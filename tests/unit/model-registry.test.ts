import { expect, test, describe } from "bun:test";
import { isCataloguedModel, isGemini3OrNewer, prefersCliPool, parseModelFamily, supportedModelsCache, supportedModelMetadata, imageGenerationModelIds, recordSupportedModel, recordImageGenerationModels, buildNativeModelObject } from "../../src/utils/model-registry";

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

  test("isCataloguedModel uses only live catalog entries", () => {
    expect(isCataloguedModel("gemini-3-flash-thinking-medium", "gemini-3-flash")).toBe(false);

    supportedModelsCache.add("gemini-3-flash");
    expect(isCataloguedModel("gemini-3-flash-thinking-medium", "gemini-3-flash")).toBe(true);
    supportedModelsCache.delete("gemini-3-flash");

    supportedModelsCache.add("gemini-9-pro");
    expect(isCataloguedModel("gemini-9-pro-high")).toBe(true);
    supportedModelsCache.delete("gemini-9-pro");
  });
});

describe("Native model metadata", () => {
  test("buildNativeModelObject mirrors capabilities from fetchAvailableModels", () => {
    recordSupportedModel("gemini-catalog-test", {
      displayName: "Gemini Catalog Test",
      supportsImages: true,
      supportsVideo: true,
      supportsThinking: true,
      maxTokens: 1048576,
      maxOutputTokens: 65536,
      supportedMimeTypes: { "text/plain": true, "image/png": true, "video/mp4": true },
    });

    const model = buildNativeModelObject("gemini-catalog-test");

    expect(model.id).toBe("gemini-catalog-test");
    expect(model.name).toBe("Gemini Catalog Test");
    expect(model.modalities.input).toEqual(expect.arrayContaining(["text/plain", "image/png", "video/mp4"]));
    expect(model.modalities.output).toEqual(["text"]);
    expect(model.capabilities.reasoning).toEqual({ supported: true });
    expect(model.limit).toEqual({ context: 1048576, output: 65536 });
    expect(model.supportsImages).toBe(true);
    expect(model.architecture.input_modalities).toEqual(expect.arrayContaining(["text", "image", "video"]));
    expect(model.architecture.output_modalities).toEqual(["text"]);
    expect(model.supported_parameters).toEqual(expect.arrayContaining(["tools", "reasoning", "include_reasoning"]));
    expect(model.reasoning).toMatchObject({ default_enabled: true });

    supportedModelMetadata.delete("gemini-catalog-test");
    supportedModelsCache.delete("gemini-catalog-test");
  });

  test("buildNativeModelObject derives media modalities even without mime types", () => {
    recordSupportedModel("claude-catalog-test", {
      supportsImages: true,
      maxTokens: 250000,
      maxOutputTokens: 64000,
    });

    const model = buildNativeModelObject("claude-catalog-test");
    expect(model.modalities.input).toEqual(["image", "text"]);
    expect(model.capabilities.reasoning).toBeUndefined();

    supportedModelMetadata.delete("claude-catalog-test");
    supportedModelsCache.delete("claude-catalog-test");
  });

  test("image generation models report image output", () => {
    recordImageGenerationModels(["models/gemini-image-test"]);
    recordSupportedModel("gemini-image-test", { maxTokens: 65536, maxOutputTokens: 65536 });

    const model = buildNativeModelObject("gemini-image-test");
    expect(model.modalities.output).toEqual(["text", "image"]);

    imageGenerationModelIds.delete("gemini-image-test");
    supportedModelMetadata.delete("gemini-image-test");
    supportedModelsCache.delete("gemini-image-test");
  });

  test("unknown models still return a minimal valid object", () => {
    const model = buildNativeModelObject("not-in-catalog");
    expect(model).toMatchObject({ id: "not-in-catalog", object: "model", owned_by: "antigravity" });
  });
});
