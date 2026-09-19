import { expect, test, describe, beforeAll } from "bun:test";
import { matchProvider, buildUpstreamHeaders, proxyProviderRequest } from "../../src/providers/opencode";
import { type ProviderConfig } from "../../src/config/types";

const providers: ProviderConfig[] = [
  {
    id: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    sessionHeader: "x-opencode-session",
    clientHeader: "x-opencode-client",
    client: "antigravity-proxy",
    enabled: true,
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "http://opencode.ai/zen/go/v1/",
    apiKeyEnv: "OPENCODE_API_KEY",
    sessionHeader: "x-opencode-session",
    enabled: true,
  },
  {
    id: "disabled",
    baseUrl: "https://example.com/v1",
    enabled: false,
  },
];

beforeAll(() => {
  delete process.env.OPENCODE_API_KEY;
});

describe("matchProvider", () => {
  test("resolves prefixed models and strips the prefix", () => {
    const resolved = matchProvider("opencode/kimi-k3", providers);
    expect(resolved?.providerId).toBe("opencode");
    expect(resolved?.upstreamModel).toBe("kimi-k3");
  });

  test("resolves the go provider prefix", () => {
    const resolved = matchProvider("opencode-go/deepseek-v4.1-flash", providers);
    expect(resolved?.providerId).toBe("opencode-go");
    expect(resolved?.upstreamModel).toBe("deepseek-v4.1-flash");
  });

  test("returns null for non-provider models", () => {
    expect(matchProvider("gemini-3.1-pro-high", providers)).toBeNull();
    expect(matchProvider("claude-sonnet-4-6", providers)).toBeNull();
  });

  test("ignores disabled providers", () => {
    expect(matchProvider("disabled/foo", providers)).toBeNull();
  });

  test("ignores empty upstream model ids", () => {
    expect(matchProvider("opencode/", providers)).toBeNull();
  });
});

describe("buildUpstreamHeaders", () => {
  test("sends the session id in the configured header", () => {
    const headers = buildUpstreamHeaders(providers[0], { sessionId: "ses_123", version: "0.8.0" }, true);
    expect(headers["x-opencode-session"]).toBe("ses_123");
    expect(headers["Accept"]).toBe("text/event-stream");
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["x-opencode-client"]).toBe("antigravity-proxy");
  });

  test("uses bearer auth when an api key is configured", () => {
    const provider: ProviderConfig = { ...providers[0], apiKey: "sk-test" };
    const headers = buildUpstreamHeaders(provider, { sessionId: "ses_abc" }, false);
    expect(headers["Authorization"]).toBe("Bearer sk-test");
    expect(headers["x-opencode-session"]).toBe("ses_abc");
  });
});

describe("proxyProviderRequest", () => {
  test("forwards the session header and strips the model prefix upstream", async () => {
    let received: any = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received = {
          headers: Object.fromEntries(req.headers),
          body: await req.json(),
        };
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });

    try {
      const provider: ProviderConfig = { ...providers[0], baseUrl: `http://127.0.0.1:${server.port}` };
      const res = await proxyProviderRequest(
        { model: "opencode/kimi-k3", messages: [] },
        { providerId: "opencode", provider, upstreamModel: "kimi-k3" },
        { sessionId: "ses_e2e", version: "0.8.0" }
      );

      expect(res.status).toBe(200);
      expect(received?.headers["x-opencode-session"]).toBe("ses_e2e");
      expect(received?.headers["x-opencode-client"]).toBe("antigravity-proxy");
      expect(received?.body.model).toBe("kimi-k3");
      expect(res.headers.get("X-Antigravity-Provider")).toBe("opencode");
    } finally {
      server.stop(true);
    }
  });
});
