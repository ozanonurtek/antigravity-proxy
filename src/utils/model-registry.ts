export const supportedModelsCache: Set<string> = new Set();

export const STATIC_MODEL_FALLBACK = [
  "claude-sonnet-4-6",
  "claude-sonnet-4-6-thinking",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-thinking",
  "claude-opus-4-6-thinking",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3.1-pro",
  "gemini-3.1-pro-preview",
  "gemini-3-flash",
  "gemini-3-pro-high",
  "gemini-3-pro-low",
  "gemini-3-pro",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-thinking",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview"
];

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
  for (const id of STATIC_MODEL_FALLBACK) known.add(normalizeModelId(id));
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
