import { expect, test, describe } from "bun:test";
import { isCataloguedModel, isGemini3OrNewer, prefersCliPool, parseModelFamily, supportedModelsCache } from "../../src/utils/model-registry";

describe("Model Registry", () => {
  test("parseModelFamily detects vendor and version", () => {
    expect(parseModelFamily("gemini-3.1-pro-high")).toEqual({ vendor: "gemini", major: 3, isFlash: false, isPreview: false });
    expect(parseModelFamily("gemini-4-flash-preview")).toEqual({ vendor: "gemini", major: 4, isFlash: true, isPreview: true });
    expect(parseModelFamily("antigravity-claude-opus-4-6")).toMatchObject({ vendor: "claude" });
    expect(parseModelFamily("gpt-4o")).toMatchObject({ vendor: "gpt" });
  });

  test("prefersCliPool generalizes across versions", () => {
    expect(prefersCliPool("gemini-3-pro")).toBe(true);
    expect(prefersCliPool("gemini-3-flash")).toBe(false);
    expect(prefersCliPool("gemini-3-flash-preview")).toBe(true);
    expect(prefersCliPool("gemini-2.5-pro")).toBe(true);
    expect(prefersCliPool("gemini-4-pro")).toBe(true);
    expect(prefersCliPool("gemini-4-flash")).toBe(false);
    expect(prefersCliPool("claude-sonnet-4-6")).toBe(false);
    expect(prefersCliPool("gpt-4o")).toBe(false);
  });

  test("isGemini3OrNewer only matches Gemini 3+", () => {
    expect(isGemini3OrNewer("gemini-3-flash")).toBe(true);
    expect(isGemini3OrNewer("gemini-3.1-pro")).toBe(true);
    expect(isGemini3OrNewer("gemini-10-pro")).toBe(true);
    expect(isGemini3OrNewer("gemini-2.5-pro")).toBe(false);
    expect(isGemini3OrNewer("claude-sonnet-4-6")).toBe(false);
  });

  test("isCataloguedModel uses live cache entries added at runtime", () => {
    expect(isCataloguedModel("gemini-3-flash-thinking-medium", "gemini-3-flash")).toBe(true);
    expect(isCataloguedModel("gemini-9-pro")).toBe(false);

    supportedModelsCache.add("gemini-9-pro");
    expect(isCataloguedModel("gemini-9-pro-high")).toBe(true);
    supportedModelsCache.delete("gemini-9-pro");
  });
});
