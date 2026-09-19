import { getProxyConfig } from "../config/manager";
import { type ProviderConfig } from "../config/types";

export interface ResolvedProvider {
  providerId: string;
  provider: ProviderConfig;
  upstreamModel: string;
}

export const providerModelsCache = new Map<string, string[]>();

const DEFAULT_CHAT_PATH = "chat/completions";
const DEFAULT_MODELS_PATH = "models";

function providerBaseUrl(provider: ProviderConfig): string {
  return (provider.baseUrl || "").replace(/\/+$/, "");
}

export function getProviders(): ProviderConfig[] {
  const providers = getProxyConfig().providers || [];
  return providers.filter(p => p.enabled !== false && p.id && p.baseUrl);
}

export function providerApiKey(provider: ProviderConfig): string {
  if (provider.apiKey) return provider.apiKey.trim();
  const envName = provider.apiKeyEnv || "OPENCODE_API_KEY";
  return (process.env[envName] || "").trim();
}

/** Pure prefix match so it can be unit tested without the config singleton. */
export function matchProvider(modelId: string, providers: ProviderConfig[]): ResolvedProvider | null {
  if (!modelId) return null;
  const normalized = modelId.trim();
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    const prefix = `${provider.id}/`;
    if (normalized.startsWith(prefix)) {
      const upstreamModel = normalized.slice(prefix.length);
      if (!upstreamModel) continue;
      return { providerId: provider.id, provider, upstreamModel };
    }
  }
  return null;
}

export function resolveProvider(modelId: string): ResolvedProvider | null {
  return matchProvider(modelId, getProviders());
}

export function listProviderModels(): Array<{ id: string; owned_by: string }> {
  const models: Array<{ id: string; owned_by: string }> = [];
  for (const provider of getProviders()) {
    for (const model of providerModelsCache.get(provider.id) || []) {
      models.push({ id: `${provider.id}/${model}`, owned_by: provider.id });
    }
  }
  return models;
}

export function listProviderModelIds(): string[] {
  return listProviderModels().map(m => m.id);
}

export async function refreshProviderModels(): Promise<void> {
  for (const provider of getProviders()) {
    try {
      const baseUrl = providerBaseUrl(provider);
      const key = providerApiKey(provider);
      const res = await fetch(`${baseUrl}/${provider.modelsPath || DEFAULT_MODELS_PATH}`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      });
      if (!res.ok) {
        console.warn(`[Provider] ${provider.id} model discovery returned ${res.status}`);
        continue;
      }
      const data = await res.json() as any;
      const ids = (data?.data || [])
        .map((m: any) => m?.id)
        .filter((id: any): id is string => typeof id === "string" && id.length > 0);
      if (ids.length > 0) {
        providerModelsCache.set(provider.id, ids);
        console.log(`[Provider] Loaded ${ids.length} models from ${provider.name || provider.id}`);
      }
    } catch (e: any) {
      console.warn(`[Provider] Failed to refresh models for ${provider.id}: ${e?.message || e}`);
    }
  }
}

export interface ProxyProviderOptions {
  sessionId: string;
  version?: string;
}

export function buildUpstreamHeaders(
  provider: ProviderConfig,
  options: ProxyProviderOptions,
  stream: boolean
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": stream ? "text/event-stream" : "application/json",
    ...(provider.defaultHeaders || {}),
  };

  const key = providerApiKey(provider);
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const client = provider.client || "antigravity-proxy";
  headers["User-Agent"] = options.version ? `${client}/${options.version}` : client;
  if (provider.clientHeader) headers[provider.clientHeader] = client;

  const sessionHeader = provider.sessionHeader || "x-opencode-session";
  if (options.sessionId) headers[sessionHeader] = options.sessionId;

  return headers;
}

/**
 * Forward an OpenAI-compatible request to an external provider and stream the
 * (already OpenAI-shaped) response straight back to the caller.
 */
export async function proxyProviderRequest(
  openaiBody: any,
  resolved: ResolvedProvider,
  options: ProxyProviderOptions
): Promise<Response> {
  const { provider, upstreamModel } = resolved;
  const baseUrl = providerBaseUrl(provider);
  const chatPath = provider.chatPath || DEFAULT_CHAT_PATH;
  const targetUrl = `${baseUrl}/${chatPath}`;

  const upstreamBody = { ...openaiBody, model: upstreamModel };
  const headers = buildUpstreamHeaders(provider, options, openaiBody.stream === true);

  console.log(`[Provider] ${provider.id} -> ${targetUrl} (model: ${upstreamModel})`);

  const controller = new AbortController();
  const timeoutMs = openaiBody.stream === true ? 300000 : 120000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const contentType = upstream.headers.get("content-type") || "application/json";
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Antigravity-Provider": provider.id,
      },
    });
  } catch (e: any) {
    clearTimeout(timeoutId);
    const message = e?.name === "AbortError" ? "Upstream provider timed out" : (e?.message || String(e));
    console.error(`[Provider] ${provider.id} request failed:`, message);
    return new Response(JSON.stringify({
      error: { message: `Provider ${provider.id} error: ${message}`, type: "provider_error", code: "provider_error" }
    }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Antigravity-Provider": provider.id }
    });
  }
}
