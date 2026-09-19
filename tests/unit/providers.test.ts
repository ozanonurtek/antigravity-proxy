import { expect, test, describe, beforeAll } from "bun:test";
import { matchProvider, buildUpstreamHeaders, proxyProviderRequest, resolveUpstreamApi } from "../../src/providers/opencode";
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

  test("uses x-api-key auth for the Anthropic Messages API", () => {
    const provider: ProviderConfig = { ...providers[0], apiKey: "sk-test" };
    const headers = buildUpstreamHeaders(provider, { sessionId: "ses_abc" }, true, "messages");
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Authorization"]).toBeUndefined();
  });
});

describe("resolveUpstreamApi", () => {
  test("defaults to chat", () => {
    expect(resolveUpstreamApi(providers[0], "kimi-k3")).toBe("chat");
  });

  test("honours per-model overrides", () => {
    const provider: ProviderConfig = {
      ...providers[0],
      modelApis: { "gpt-5.6-luna": "responses", "claude-sonnet-4-6": "messages" },
    };
    expect(resolveUpstreamApi(provider, "gpt-5.6-luna")).toBe("responses");
    expect(resolveUpstreamApi(provider, "claude-sonnet-4-6")).toBe("messages");
    expect(resolveUpstreamApi(provider, "kimi-k3")).toBe("chat");
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

  test("routes Responses models and converts the response", async () => {
    let path = "";
    let received: any = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        path = new URL(req.url).pathname;
        received = { headers: Object.fromEntries(req.headers), body: await req.json() };
        return new Response(
          JSON.stringify({
            id: "resp_1",
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      },
    });

    try {
      const provider: ProviderConfig = {
        ...providers[0],
        baseUrl: `http://127.0.0.1:${server.port}`,
        modelApis: { "gpt-5.6-luna": "responses" },
      };
      const res = await proxyProviderRequest(
        { model: "opencode/gpt-5.6-luna", messages: [{ role: "user", content: "hi" }], stream: false },
        { providerId: "opencode", provider, upstreamModel: "gpt-5.6-luna" },
        { sessionId: "ses_r" }
      );

      expect(path).toBe("/responses");
      expect(received.body.model).toBe("gpt-5.6-luna");
      expect(received.body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
      expect(res.headers.get("X-Antigravity-Upstream-Api")).toBe("responses");

      const json = await res.json() as any;
      expect(json.choices[0].message.content).toBe("Hello");
      expect(json.usage.total_tokens).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("routes Messages models, uses x-api-key and converts the stream", async () => {
    let path = "";
    let received: any = null;
    const sse = [
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n`,
    ].join("");

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        path = new URL(req.url).pathname;
        received = { headers: Object.fromEntries(req.headers), body: await req.json() };
        return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
      },
    });

    try {
      const provider: ProviderConfig = {
        ...providers[0],
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "sk-test",
        modelApis: { "minimax-m2.7": "messages" },
      };
      const res = await proxyProviderRequest(
        { model: "opencode/minimax-m2.7", messages: [{ role: "user", content: "hi" }], stream: true },
        { providerId: "opencode", provider, upstreamModel: "minimax-m2.7" },
        { sessionId: "ses_m" }
      );

      expect(path).toBe("/messages");
      expect(received.headers["x-api-key"]).toBe("sk-test");
      expect(received.headers["anthropic-version"]).toBe("2023-06-01");
      expect(received.headers["authorization"]).toBeUndefined();
      expect(received.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");

      const text = await res.text();
      expect(text).toContain('"content":"Hello"');
      expect(text).toContain("data: [DONE]");
    } finally {
      server.stop(true);
    }
  });
});
