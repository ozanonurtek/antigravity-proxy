export const supportedModelsCache: Set<string> = new Set();

/**
 * Raw model entries returned by the Cloud Code `fetchAvailableModels` endpoint,
 * keyed by the model id that is exposed through the proxy. The endpoint is the
 * source of truth for native model capabilities (images/video/thinking/limits),
 * so we keep the source record instead of describing models statically.
 */
export const supportedModelMetadata: Map<string, Record<string, any>> = new Map();

/** Model ids the upstream declares as image generators (output modality: image). */
export const imageGenerationModelIds: Set<string> = new Set();

const VENDOR_PREFIX_RE = /^(openai|antigravity|custom_openai|litellm|google)\//i;
const TIER_RE = /-(low|medium|high)$/i;

export function normalizeModelId(id: string): string {
  return (id || "")
    .toLowerCase()
    .trim()
    .replace(VENDOR_PREFIX_RE, "")
    .replace(/^models\//, "")
    .replace(/^antigravity-/, "")
    .replace(/^gemini-claude-/, "claude-");
}

function baseModelId(id: string): string {
  return normalizeModelId(id)
    .replace(/-thinking/i, "")
    .replace(/-preview$/i, "")
    .replace(TIER_RE, "");
}

export function isCataloguedModel(...candidates: (string | undefined)[]): boolean {
  const known = new Set<string>();
  for (const id of supportedModelsCache) known.add(normalizeModelId(id));

  const knownBases = new Set<string>();
  for (const id of known) knownBases.add(baseModelId(id));

  for (const candidate of candidates) {
    if (!candidate) continue;
    const norm = normalizeModelId(candidate);
    if (known.has(norm)) return true;
    const base = baseModelId(candidate);
    if (base && knownBases.has(base)) return true;
  }
  return false;
}

export interface ModelFamily {
  vendor: "claude" | "gemini" | "gpt" | "image" | "antigravity" | "other";
  major?: number;
  isFlash: boolean;
  isPreview: boolean;
}

export function parseModelFamily(modelId: string): ModelFamily {
  const id = normalizeModelId(modelId);
  const isFlash = id.includes("flash");
  const isPreview = id.includes("-preview");

  if (id.includes("claude")) return { vendor: "claude", isFlash, isPreview };
  if (id.includes("gemini")) {
    const match = id.match(/gemini-(\d+)/);
    return { vendor: "gemini", major: match ? parseInt(match[1], 10) : undefined, isFlash, isPreview };
  }
  if (id.includes("image")) return { vendor: "image", isFlash, isPreview };
  if (id.includes("gpt")) return { vendor: "gpt", isFlash, isPreview };
  if (id.includes("antigravity")) return { vendor: "antigravity", isFlash, isPreview };
  return { vendor: "other", isFlash, isPreview };
}

export function isGemini3OrNewer(modelId: string): boolean {
  const { vendor, major } = parseModelFamily(modelId);
  return vendor === "gemini" && major !== undefined && major >= 3;
}

export function prefersCliPool(modelId: string): boolean {
  const { vendor, major, isFlash, isPreview } = parseModelFamily(modelId);
  if (vendor !== "gemini") return false;
  if (isPreview) return true;
  if (major === 2) return true;
  if (major !== undefined && major >= 3) return !isFlash;
  return false;
}

/** Record a native model and its raw source metadata from `fetchAvailableModels`. */
export function recordSupportedModel(id: string, metadata: Record<string, any> | undefined): void {
  const cleanId = (id || "").replace(/^models\//, "");
  if (!cleanId) return;
  supportedModelsCache.add(cleanId);
  if (metadata) supportedModelMetadata.set(cleanId, metadata);
}

/** Record the ids the upstream reports as image generators. */
export function recordImageGenerationModels(ids: unknown): void {
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const cleanId = id.replace(/^models\//, "");
    if (cleanId) imageGenerationModelIds.add(cleanId);
  }
}

function deriveInputModalities(raw: Record<string, any>): string[] {
  const input = new Set<string>();

  const mimeTypes = raw.supportedMimeTypes;
  if (mimeTypes && typeof mimeTypes === "object") {
    for (const [mime, supported] of Object.entries(mimeTypes)) {
      if (supported !== false) input.add(mime);
    }
  }
  if (raw.supportsImages === true) input.add("image");
  if (raw.supportsVideo === true) input.add("video");
  if (input.size === 0) input.add("text");
  // A source that only advertises media mime types still accepts text prompts.
  if (!Array.from(input).some(m => m === "text" || m.startsWith("text/"))) input.add("text");

  return Array.from(input);
}

function modalityFamily(modality: string): string | null {
  const lower = modality.toLowerCase();
  if (lower === "text" || lower.startsWith("text/")) return "text";
  if (lower === "image" || lower.startsWith("image/")) return "image";
  if (lower === "audio" || lower.startsWith("audio/")) return "audio";
  if (lower === "video" || lower.startsWith("video/")) return "video";
  if (lower === "file" || lower === "files" || lower.startsWith("application/")) return "file";
  return null;
}

function modalityFamilies(modalities: unknown): string[] {
  if (!Array.isArray(modalities)) return [];
  const families = new Set<string>();
  for (const modality of modalities) {
    if (typeof modality !== "string") continue;
    const family = modalityFamily(modality);
    if (family) families.add(family);
  }
  return Array.from(families);
}

/**
 * Add the OpenRouter/models.dev-style aliases many clients use to read
 * capabilities from `/v1/models` (`architecture`, `supported_parameters`,
 * `reasoning`). All values are derived from the mirrored source metadata.
 */
export function withModelCapabilityAliases(model: Record<string, any>): Record<string, any> {
  const out = { ...model };
  const capabilities = model.capabilities && typeof model.capabilities === "object" ? model.capabilities : {};

  const reasoning = capabilities.reasoning;
  const reasoningSupported = typeof reasoning === "boolean"
    ? reasoning
    : typeof reasoning?.supported === "boolean"
      ? reasoning.supported
      : undefined;
  const tools = capabilities.tools;
  const toolsSupported = typeof tools === "boolean"
    ? tools
    : typeof tools?.supported === "boolean"
      ? tools.supported
      : undefined;
  const efforts = Array.isArray(reasoning?.effort)
    ? reasoning.effort.filter((effort: unknown): effort is string => typeof effort === "string")
    : [];

  const inputFamilies = modalityFamilies(model.modalities?.input);
  const outputFamilies = modalityFamilies(model.modalities?.output);
  if (inputFamilies.length === 0) inputFamilies.push("text");
  if (outputFamilies.length === 0) outputFamilies.push("text");

  if (out.architecture === undefined) {
    out.architecture = {
      input_modalities: inputFamilies,
      output_modalities: outputFamilies,
    };
  }

  if (out.reasoning === undefined && reasoningSupported !== undefined) {
    out.reasoning = {
      supported_efforts: efforts,
      default_enabled: reasoningSupported,
      mandatory: reasoningSupported && !reasoning?.toggle && !efforts.includes("none"),
      supports_max_tokens: false,
    };
  }

  if (out.supported_parameters === undefined) {
    const parameters = new Set<string>();
    if (toolsSupported) {
      parameters.add("tools");
      parameters.add("tool_choice");
    }
    if (reasoningSupported) {
      parameters.add("reasoning");
      parameters.add("include_reasoning");
      if (efforts.length > 0) parameters.add("reasoning_effort");
    }
    if (capabilities.temperature !== false) parameters.add("temperature");
    if (capabilities.top_p !== false) parameters.add("top_p");
    if (capabilities.top_k !== false) parameters.add("top_k");
    if (capabilities.structured_output) parameters.add("response_format");
    out.supported_parameters = Array.from(parameters);
  }

  return out;
}

/**
 * Build the OpenAI model object for a native (Cloud Code) model from the
 * metadata the upstream returned. Unknown models fall back to a minimal entry.
 */
export function buildNativeModelObject(id: string): Record<string, any> {
  const cleanId = id.replace(/^models\//, "");
  const raw = supportedModelMetadata.get(cleanId);
  const model: Record<string, any> = {
    id: cleanId,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "antigravity",
  };
  if (!raw) return model;

  const input = deriveInputModalities(raw);
  const output = ["text"];
  if (imageGenerationModelIds.has(cleanId)) output.push("image");

  const capabilities: Record<string, any> = {
    // The proxy always forwards tool definitions on the native chat endpoint.
    tools: { supported: true },
  };
  if (typeof raw.supportsThinking === "boolean") {
    capabilities.reasoning = { supported: raw.supportsThinking };
  }

  const limit: Record<string, any> = {};
  if (typeof raw.maxTokens === "number") limit.context = raw.maxTokens;
  if (typeof raw.maxOutputTokens === "number") limit.output = raw.maxOutputTokens;

  if (typeof raw.displayName === "string") model.name = raw.displayName;
  model.modalities = { input, output };
  model.capabilities = capabilities;
  if (Object.keys(limit).length > 0) model.limit = limit;

  // Mirror the upstream fields as well so consumers can read the source values.
  for (const field of [
    "displayName",
    "supportsImages",
    "supportsThinking",
    "supportsVideo",
    "supportedMimeTypes",
    "minThinkingBudget",
    "thinkingBudget",
    "thinkingLevel",
    "maxTokens",
    "maxOutputTokens",
    "recommended",
    "apiProvider",
    "modelProvider",
  ]) {
    if (raw[field] !== undefined) model[field] = raw[field];
  }

  return withModelCapabilityAliases(model);
}
