import { getProxyConfig } from "../config/manager";
import { type ProviderConfig } from "../config/types";
import { withModelCapabilityAliases } from "../utils/model-registry";
import {
  type UpstreamApi,
  translateRequestToUpstream,
  translateResponseToChat,
  createUpstreamStreamTransformer,
} from "./translate";

export interface ResolvedProvider {
  providerId: string;
  provider: ProviderConfig;
  upstreamModel: string;
}

/**
 * Full model objects returned by each provider's `/models` endpoint. Upstreams
 * such as OpenCode Zen/Go publish capabilities, modalities, limits and pricing
 * on these objects, so they are cached and mirrored verbatim.
 */
export const providerModelsCache = new Map<string, Array<Record<string, any>>>();

const DEFAULT_CHAT_PATH = "chat/completions";
const DEFAULT_RESPONSES_PATH = "responses";
const DEFAULT_MESSAGES_PATH = "messages";
const DEFAULT_MODELS_PATH = "models";

/** Upstream `api` object keys mapped to the protocol the proxy speaks. */
const API_KEY_MAP: Record<string, UpstreamApi> = {
  "chat-completions": "chat",
  "responses": "responses",
  "messages": "messages",
  "generate-content": "google",
};

/**
 * Read the protocol a model is served on from its upstream `/models` entry.
 * Providers such as OpenCode Zen/Go publish an `api` object with exactly one
 * key per model (`chat-completions`, `responses` or `messages`).
 */
export function upstreamApiFromModel(model: Record<string, any> | undefined): UpstreamApi | null {
  const api = model?.api;
  if (!api || typeof api !== "object") return null;
  for (const [key, upstreamApi] of Object.entries(API_KEY_MAP)) {
    if (api[key]) return upstreamApi;
  }
  return null;
}

/**
 * Determine which upstream protocol a model is served on, using the discovered
 * model metadata first. `modelApis` remains available only as an explicit
 * override for providers that do not publish an `api` description.
 */
export function resolveUpstreamApi(provider: ProviderConfig, upstreamModel: string): UpstreamApi {
  const override = provider.modelApis?.[upstreamModel];
  if (override === "responses" || override === "messages" || override === "chat") return override;

  const model = (providerModelsCache.get(provider.id) || []).find(m => m.id === upstreamModel);
  return upstreamApiFromModel(model) || "chat";
}

function upstreamPath(provider: ProviderConfig, api: UpstreamApi): string {
  if (api === "responses") return provider.responsesPath || DEFAULT_RESPONSES_PATH;
  if (api === "messages") return provider.messagesPath || DEFAULT_MESSAGES_PATH;
  return provider.chatPath || DEFAULT_CHAT_PATH;
}

/** Google GenAI exposes methods on the model resource instead of a path. */
function googleTargetUrl(baseUrl: string, model: string, stream: boolean): string {
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return `${baseUrl}/models/${encodeURIComponent(model)}:${method}`;
}

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

/**
 * Prefix a provider's model object for the proxy namespace while preserving
 * every capability/limit/pricing field the upstream published.
 */
export function prefixProviderModel(providerId: string, model: Record<string, any>): Record<string, any> {
  return withModelCapabilityAliases({
    ...model,
    id: `${providerId}/${model.id}`,
    object: model.object || "model",
    owned_by: model.owned_by || providerId,
  });
}

export function listProviderModels(): Array<Record<string, any>> {
  const models: Array<Record<string, any>> = [];
  for (const provider of getProviders()) {
    for (const model of providerModelsCache.get(provider.id) || []) {
      models.push(prefixProviderModel(provider.id, model));
    }
  }
  return models;
}

export function listProviderModelIds(): string[] {
  return listProviderModels().map(m => String(m.id));
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
      const payload = Array.isArray(data) ? data : (data?.data || []);
      const models = payload.filter(
        (m: any): m is Record<string, any> => !!m && typeof m === "object" && typeof m.id === "string" && m.id.length > 0
      );
      if (models.length > 0) {
        providerModelsCache.set(provider.id, models);
        console.log(`[Provider] Loaded ${models.length} models from ${provider.name || provider.id}`);
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
  stream: boolean,
  api: UpstreamApi = "chat"
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": stream ? "text/event-stream" : "application/json",
    ...(provider.defaultHeaders || {}),
  };

  const key = providerApiKey(provider);
  if (key) {
    if (api === "messages") {
      // Anthropic-style endpoints authenticate with x-api-key, not Bearer.
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (api === "google") {
      // Google GenAI endpoints authenticate with x-goog-api-key.
      headers["x-goog-api-key"] = key;
    } else {
      headers["Authorization"] = `Bearer ${key}`;
    }
  } else if (api === "messages") {
    headers["anthropic-version"] = "2023-06-01";
  }

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
  const api = resolveUpstreamApi(provider, upstreamModel);
  const isStream = openaiBody.stream === true;
  const targetUrl = api === "google"
    ? googleTargetUrl(baseUrl, upstreamModel, isStream)
    : `${baseUrl}/${upstreamPath(provider, api)}`;
  const requestId = "chatcmpl-" + Math.random().toString(36).substring(7);

  const baseBody = { ...openaiBody, model: upstreamModel };
  const upstreamBody = translateRequestToUpstream(baseBody, api);
  const headers = buildUpstreamHeaders(provider, options, isStream, api);

  console.log(`[Provider] ${provider.id} -> ${targetUrl} (model: ${upstreamModel}, api: ${api})`);

  const controller = new AbortController();
  const timeoutMs = isStream ? 300000 : 120000;
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
    const responseHeaders = {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Antigravity-Provider": provider.id,
      "X-Antigravity-Upstream-Api": api,
    };

    // Errors from the upstream are already OpenAI/Anthropic/Responses shaped and
    // carry a readable `error.message`, so stream them straight through.
    if (!upstream.ok || api === "chat") {
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    }

    if (isStream) {
      if (!upstream.body) {
        return new Response(JSON.stringify({ error: { message: "No response body from upstream" } }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      const stream = upstream.body.pipeThrough(createUpstreamStreamTransformer(api, openaiBody.model, requestId));
      return new Response(stream, {
        status: 200,
        headers: { ...responseHeaders, "Content-Type": "text/event-stream" },
      });
    }

    const json = await upstream.json();
    const converted = translateResponseToChat(json, api, openaiBody.model, requestId);
    return new Response(JSON.stringify(converted), { status: 200, headers: responseHeaders });
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
