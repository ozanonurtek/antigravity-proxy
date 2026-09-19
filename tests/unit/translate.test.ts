import { expect, test, describe } from "bun:test";
import {
  translateRequestToUpstream,
  translateResponseToChat,
  createUpstreamStreamTransformer,
  contentToText,
} from "../../src/providers/translate";

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];

describe("contentToText", () => {
  test("handles strings and text parts", () => {
    expect(contentToText("hello")).toBe("hello");
    expect(contentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
  });
});

describe("translateRequestToUpstream", () => {
  test("leaves chat requests untouched", () => {
    const body = { model: "m", messages: [] };
    expect(translateRequestToUpstream(body, "chat")).toBe(body);
  });

  test("maps chat to the Responses API", () => {
    const body = {
      model: "gpt-5.6-luna",
      stream: true,
      max_tokens: 100,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools,
      tool_choice: "required",
    };
    const out = translateRequestToUpstream(body, "responses");
    expect(out.model).toBe("gpt-5.6-luna");
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    expect(out.instructions).toBe("sys");
    expect(out.max_output_tokens).toBe(100);
    expect(out.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    expect(out.tools[0]).toEqual({
      type: "function",
      name: "get_weather",
      description: "Get weather",
      parameters: tools[0].function.parameters,
    });
    expect(out.tool_choice).toBe("required");
  });

  test("carries assistant tool calls and tool results through Responses", () => {
    const out = translateRequestToUpstream(
      {
        model: "m",
        messages: [
          { role: "user", content: "weather?" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
          { role: "tool", tool_call_id: "call_1", content: "sunny" },
        ],
      },
      "responses"
    );
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "weather?" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
    ]);
  });

  test("maps chat to the Anthropic Messages API", () => {
    const body = {
      model: "claude-sonnet-4-6",
      stream: true,
      max_tokens: 64,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "get_weather" } },
    };
    const out = translateRequestToUpstream(body, "messages");
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(out.system).toBe("sys");
    expect(out.max_tokens).toBe(64);
    expect(out.stream).toBe(true);
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ]);
    expect(out.tools[0]).toEqual({ name: "get_weather", description: "Get weather", input_schema: tools[0].function.parameters });
    expect(out.tool_choice).toEqual({ type: "tool", name: "get_weather" });
  });

  test("merges tool results into a user turn for Messages", () => {
    const out = translateRequestToUpstream(
      {
        model: "m",
        messages: [
          { role: "user", content: "weather?" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
          { role: "tool", tool_call_id: "call_1", content: "sunny" },
        ],
      },
      "messages"
    );
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }] },
    ]);
  });

  test("defaults max_tokens for Messages", () => {
    const out = translateRequestToUpstream({ model: "m", messages: [{ role: "user", content: "hi" }] }, "messages");
    expect(out.max_tokens).toBe(4096);
  });
});

describe("translateResponseToChat", () => {
  test("converts a Responses completion", () => {
    const out = translateResponseToChat(
      {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] },
          { type: "message", content: [{ type: "output_text", text: "Hi there" }] },
        ],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
      "responses",
      "opencode-go/gpt-5.6-luna",
      "chatcmpl-1"
    );
    expect(out.choices[0].message.content).toBe("Hi there");
    expect(out.choices[0].message.reasoning_content).toBe("thinking...");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  test("converts a Responses tool call", () => {
    const out = translateResponseToChat(
      {
        status: "completed",
        output: [{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' }],
      },
      "responses",
      "m",
      "chatcmpl-1"
    );
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
    ]);
    expect(out.choices[0].finish_reason).toBe("tool_calls");
  });

  test("converts a Messages completion", () => {
    const out = translateResponseToChat(
      {
        id: "msg_1",
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Let me check" },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
        usage: { input_tokens: 10, output_tokens: 8 },
      },
      "messages",
      "opencode-go/minimax-m2.7",
      "chatcmpl-1"
    );
    expect(out.choices[0].message.content).toBe("Let me check");
    expect(out.choices[0].message.reasoning_content).toBe("hmm");
    expect(out.choices[0].message.tool_calls[0].function.arguments).toBe('{"city":"Paris"}');
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 });
  });

  test("maps Messages max_tokens to length", () => {
    const out = translateResponseToChat({ content: [], stop_reason: "max_tokens" }, "messages", "m", "id");
    expect(out.choices[0].finish_reason).toBe("length");
  });
});

async function runStream(fixture: string, api: "responses" | "messages") {
  const transformer = createUpstreamStreamTransformer(api, "opencode-go/test", "chatcmpl-test");
  const writer = transformer.writable.getWriter();
  const reader = transformer.readable.getReader();
  const decoder = new TextDecoder();
  const collected: string[] = [];

  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collected.push(decoder.decode(value));
    }
  })();

  // Feed in small chunks to exercise buffering across split lines.
  for (let i = 0; i < fixture.length; i += 32) {
    await writer.write(new TextEncoder().encode(fixture.slice(i, i + 32)));
  }
  await writer.close();
  await readPromise;

  return collected
    .join("")
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim());
}

describe("stream translation", () => {
  test("converts Responses text deltas", async () => {
    const fixture = [
      `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n`,
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n`,
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Hello world"}]}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n`,
    ].join("");

    const lines = await runStream(fixture, "responses");
    const chunks = lines.filter(l => l !== "[DONE]").map(l => JSON.parse(l));
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks.map(c => c.choices[0].delta.content).filter(Boolean).join("")).toBe("Hello world");
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(lines[lines.length - 1]).toBe("[DONE]");
  });

  test("converts Responses tool-call deltas", async () => {
    const fixture = [
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","name":"get_weather","call_id":"call_1","arguments":""}}\n\n`,
      `event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"city\\":"}\n\n`,
      `event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"\\"Paris\\"}"}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","name":"get_weather","call_id":"call_1","arguments":"{\\"city\\":\\"Paris\\"}"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`,
    ].join("");

    const lines = await runStream(fixture, "responses");
    const chunks = lines.filter(l => l !== "[DONE]").map(l => JSON.parse(l));
    const start = chunks.find(c => c.choices[0].delta.tool_calls?.[0]?.id);
    expect(start.choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "get_weather" },
    });
    const args = chunks
      .flatMap(c => c.choices[0].delta.tool_calls || [])
      .filter(tc => tc.function?.arguments)
      .map(tc => tc.function.arguments)
      .join("");
    expect(args).toBe('{"city":"Paris"}');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls");
  });

  test("converts Messages text and thinking deltas", async () => {
    const fixture = [
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ].join("");

    const lines = await runStream(fixture, "messages");
    const chunks = lines.filter(l => l !== "[DONE]").map(l => JSON.parse(l));
    expect(chunks.map(c => c.choices[0].delta.reasoning_content).filter(Boolean).join("")).toBe("hmm");
    expect(chunks.map(c => c.choices[0].delta.content).filter(Boolean).join("")).toBe("Hello");
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
  });

  test("converts Messages tool-use deltas", async () => {
    const fixture = [
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n`,
    ].join("");

    const lines = await runStream(fixture, "messages");
    const chunks = lines.filter(l => l !== "[DONE]").map(l => JSON.parse(l));
    const start = chunks.find(c => c.choices[0].delta.tool_calls?.[0]?.id);
    expect(start.choices[0].delta.tool_calls[0].function).toEqual({ name: "get_weather", arguments: "" });
    const args = chunks
      .flatMap(c => c.choices[0].delta.tool_calls || [])
      .filter(tc => tc.function?.arguments)
      .map(tc => tc.function.arguments)
      .join("");
    expect(args).toBe('{"city":"Paris"}');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls");
  });
});
