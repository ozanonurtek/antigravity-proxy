/**
 * Translation between OpenAI Chat Completions and the other upstream protocols
 * exposed by OpenCode Zen / OpenCode Go.
 *
 * Some models are only served on:
 *   - the OpenAI Responses API      (`/responses`, e.g. GPT-5.x, Grok, Muse Spark)
 *   - the Anthropic Messages API    (`/messages`, e.g. Claude, Qwen, MiniMax)
 *   - the Google GenAI API          (`:generateContent`, e.g. Gemini)
 *
 * The gateway always speaks Chat Completions downstream, so requests and
 * responses are converted here.
 */

export type UpstreamApi = "chat" | "responses" | "messages" | "google";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_MAX_TOKENS = 4096;

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

export function contentToText(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") {
          return part.text || "";
        }
        return "";
      })
      .join("");
  }
  return String(content);
}

function safeJsonParse(value: string | undefined, fallback: any): any {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function makeChunk(
  id: string,
  model: string,
  created: number,
  delta: any,
  finishReason: string | null = null,
  usage?: any
): any {
  const chunk: any = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

function mapResponsesUsage(usage: any): any {
  if (!usage) return undefined;
  const prompt = usage.input_tokens ?? 0;
  const completion = usage.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.total_tokens ?? prompt + completion,
  };
}

function mapMessagesUsage(usage: any): any {
  if (!usage) return undefined;
  const prompt = usage.input_tokens ?? 0;
  const completion = usage.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

const MESSAGES_STOP_REASONS: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

function responsesFinishReason(response: any): string {
  const output = response?.output || [];
  if (output.some((item: any) => item?.type === "function_call")) return "tool_calls";
  if (response?.status === "incomplete" && response?.incomplete_details?.reason === "max_output_tokens") {
    return "length";
  }
  return "stop";
}

/* -------------------------------------------------------------------------- */
/* Request translation (Chat Completions -> upstream)                         */
/* -------------------------------------------------------------------------- */

export function translateRequestToUpstream(body: any, api: UpstreamApi): any {
  if (api === "responses") return chatToResponses(body);
  if (api === "messages") return chatToMessages(body);
  if (api === "google") return chatToGoogle(body);
  return body;
}

function chatToolToResponsesTool(tool: any): any | null {
  const fn = tool?.function;
  if (tool?.type !== "function" || !fn?.name) return null;
  return {
    type: "function",
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters ?? { type: "object", properties: {} },
  };
}

function mapToolChoiceToResponses(choice: any): any {
  if (choice == null) return undefined;
  if (typeof choice === "string") return choice;
  if (choice.type === "function" && choice.function?.name) {
    return { type: "function", name: choice.function.name };
  }
  return undefined;
}

function contentToResponsesParts(content: any, textType: "input_text" | "output_text"): any[] {
  if (typeof content === "string") {
    return content ? [{ type: textType, text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: any[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: textType, text: part });
      continue;
    }
    if (part?.type === "text") {
      parts.push({ type: textType, text: part.text || "" });
    } else if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) parts.push({ type: "input_image", image_url: url });
    }
  }
  return parts;
}

function chatToResponses(body: any): any {
  let instructions = "";
  const input: any[] = [];

  for (const msg of body.messages || []) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = contentToText(msg.content);
      instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }

    if (msg.role === "tool" || msg.role === "function") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: contentToText(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant") {
      const text = contentToText(msg.content);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of msg.tool_calls || []) {
        if (!call?.function?.name) continue;
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || "{}",
        });
      }
      continue;
    }

    const parts = contentToResponsesParts(msg.content, "input_text");
    if (parts.length) input.push({ role: "user", content: parts });
  }

  const out: any = { model: body.model, input, store: false };
  if (body.stream === true) out.stream = true;
  if (instructions) out.instructions = instructions;
  if (typeof body.max_tokens === "number") out.max_output_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;

  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = body.tools.map(chatToolToResponsesTool).filter(Boolean);
    if (tools.length) out.tools = tools;
  }
  const toolChoice = mapToolChoiceToResponses(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  return out;
}

function contentToAnthropicParts(content: any): any[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: any[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (part?.type === "text") {
      parts.push({ type: "text", text: part.text || "" });
    } else if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) parts.push(canvasImageToAnthropic(url));
    }
  }
  return parts;
}

function canvasImageToAnthropic(url: string): any {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (match) {
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  }
  return { type: "image", source: { type: "url", url } };
}

function chatToolToAnthropicTool(tool: any): any | null {
  const fn = tool?.function;
  if (tool?.type !== "function" || !fn?.name) return null;
  return {
    name: fn.name,
    description: fn.description,
    input_schema: fn.parameters ?? { type: "object", properties: {} },
  };
}

function mapToolChoiceToAnthropic(choice: any): any {
  if (choice == null) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" };
  if (choice.type === "function" && choice.function?.name) {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

function chatToMessages(body: any): any {
  let system = "";
  const messages: any[] = [];

  const pushBlocks = (role: "user" | "assistant", blocks: any[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      messages.push({ role, content: blocks });
    }
  };

  for (const msg of body.messages || []) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = contentToText(msg.content);
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }

    if (msg.role === "tool" || msg.role === "function") {
      pushBlocks("user", [
        { type: "tool_result", tool_use_id: msg.tool_call_id, content: contentToText(msg.content) },
      ]);
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: any[] = [];
      const text = contentToText(msg.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of msg.tool_calls || []) {
        if (!call?.function?.name) continue;
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: safeJsonParse(call.function.arguments, {}),
        });
      }
      pushBlocks("assistant", blocks);
      continue;
    }

    pushBlocks("user", contentToAnthropicParts(msg.content));
  }

  // Anthropic requires at least one message and a user turn first.
  if (messages.length === 0) {
    messages.push({ role: "user", content: [{ type: "text", text: "" }] });
  }

  const out: any = {
    model: body.model,
    messages,
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : DEFAULT_MAX_TOKENS,
  };
  if (system) out.system = system;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (body.stream === true) out.stream = true;

  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = body.tools.map(chatToolToAnthropicTool).filter(Boolean);
    if (tools.length) out.tools = tools;
  }
  const toolChoice = mapToolChoiceToAnthropic(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  return out;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};

function guessMimeType(url: string): string {
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url);
  return (match && IMAGE_MIME_BY_EXTENSION[match[1].toLowerCase()]) || "application/octet-stream";
}

function contentToGoogleParts(content: any): any[] {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: any[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ text: part });
      continue;
    }
    if (part?.type === "text") {
      parts.push({ text: part.text || "" });
    } else if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (!url) continue;
      const dataUrl = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (dataUrl) {
        parts.push({ inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } });
      } else {
        parts.push({ fileData: { mimeType: guessMimeType(url), fileUri: url } });
      }
    }
  }
  return parts;
}

function chatToolToGoogleDeclaration(tool: any): any | null {
  const fn = tool?.function;
  if (tool?.type !== "function" || !fn?.name) return null;
  return {
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters ?? { type: "object", properties: {} },
  };
}

function mapToolChoiceToGoogle(choice: any): any | undefined {
  if (choice == null) return undefined;
  if (choice === "auto") return { mode: "AUTO" };
  if (choice === "required") return { mode: "ANY" };
  if (choice === "none") return { mode: "NONE" };
  if (choice.type === "function" && choice.function?.name) {
    return { mode: "ANY", allowedFunctionNames: [choice.function.name] };
  }
  return undefined;
}

function chatToGoogle(body: any): any {
  const contents: any[] = [];
  let systemInstruction: any;
  const toolNameByCallId = new Map<string, string>();

  const pushContent = (role: "user" | "model", parts: any[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const msg of body.messages || []) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = contentToText(msg.content);
      if (!text) continue;
      const parts = systemInstruction?.parts || [];
      parts.push({ text });
      systemInstruction = { parts };
      continue;
    }

    if (msg.role === "tool" || msg.role === "function") {
      const name = toolNameByCallId.get(msg.tool_call_id) || msg.name || "tool";
      const parsed = safeJsonParse(contentToText(msg.content), {});
      pushContent("user", [
        {
          functionResponse: {
            name,
            response: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed },
          },
        },
      ]);
      continue;
    }

    if (msg.role === "assistant") {
      const parts: any[] = [];
      const text = contentToText(msg.content);
      if (text) parts.push({ text });
      for (const call of msg.tool_calls || []) {
        if (!call?.function?.name) continue;
        if (call.id) toolNameByCallId.set(call.id, call.function.name);
        parts.push({
          functionCall: {
            name: call.function.name,
            args: safeJsonParse(call.function.arguments, {}),
          },
        });
      }
      pushContent("model", parts);
      continue;
    }

    pushContent("user", contentToGoogleParts(msg.content));
  }

  if (contents.length === 0) contents.push({ role: "user", parts: [{ text: "" }] });

  const out: any = { contents };
  if (systemInstruction) out.systemInstruction = systemInstruction;

  const generationConfig: any = {};
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body.top_p === "number") generationConfig.topP = body.top_p;
  if (typeof body.top_k === "number") generationConfig.topK = body.top_k;
  if (typeof body.max_tokens === "number") generationConfig.maxOutputTokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === "number") generationConfig.maxOutputTokens = body.max_completion_tokens;
  if (body.stop != null) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Object.keys(generationConfig).length) out.generationConfig = generationConfig;

  if (Array.isArray(body.tools) && body.tools.length) {
    const declarations = body.tools.map(chatToolToGoogleDeclaration).filter(Boolean);
    if (declarations.length) {
      out.tools = [{ functionDeclarations: declarations }];
      const toolConfig = mapToolChoiceToGoogle(body.tool_choice);
      if (toolConfig) out.toolConfig = { functionCallingConfig: toolConfig };
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Non-streaming response translation (upstream -> Chat Completions)          */
/* -------------------------------------------------------------------------- */

export function translateResponseToChat(
  json: any,
  api: UpstreamApi,
  model: string,
  requestId: string
): any {
  if (api === "responses") return responsesToChatCompletion(json, model, requestId);
  if (api === "messages") return messagesToChatCompletion(json, model, requestId);
  if (api === "google") return googleToChatCompletion(json, model, requestId);
  return json;
}

const GOOGLE_FINISH_REASONS: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  MALFORMED_FUNCTION_CALL: "tool_calls",
};

function mapGoogleUsage(usage: any): any {
  if (!usage) return undefined;
  const prompt = usage.promptTokenCount ?? 0;
  const completion = usage.candidatesTokenCount ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokenCount ?? prompt + completion,
  };
}

function googlePartToDelta(part: any, toolIndex: number): { text?: string; reasoning?: string; toolCall?: any } {
  if (!part) return {};
  if (part.functionCall?.name) {
    return {
      toolCall: {
        index: toolIndex,
        id: `call_${toolIndex}_${Math.random().toString(36).substring(2, 8)}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      },
    };
  }
  if (typeof part.text === "string") {
    if (part.thought === true) return { reasoning: part.text };
    return { text: part.text };
  }
  return {};
}

function googleToChatCompletion(json: any, model: string, requestId: string): any {
  const candidate = json?.candidates?.[0];
  let text = "";
  let reasoning = "";
  const toolCalls: any[] = [];

  for (const part of candidate?.content?.parts || []) {
    const delta = googlePartToDelta(part, toolCalls.length);
    if (delta.text) text += delta.text;
    if (delta.reasoning) reasoning += delta.reasoning;
    if (delta.toolCall) toolCalls.push(delta.toolCall);
  }

  const message: any = { role: "assistant", content: text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const finishReason = toolCalls.length
    ? "tool_calls"
    : (GOOGLE_FINISH_REASONS[candidate?.finishReason] || "stop");

  return {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: mapGoogleUsage(json?.usageMetadata),
  };
}

function responsesToChatCompletion(json: any, model: string, requestId: string): any {
  const textParts: string[] = [];
  const toolCalls: any[] = [];
  let reasoning = "";

  for (const item of json?.output || []) {
    if (item?.type === "message") {
      for (const part of item.content || []) {
        if (part?.type === "output_text") textParts.push(part.text || "");
        else if (part?.type === "refusal") textParts.push(part.refusal || "");
      }
    } else if (item?.type === "reasoning") {
      for (const summary of item.summary || []) reasoning += summary?.text || "";
    } else if (item?.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" },
      });
    }
  }

  const message: any = { role: "assistant", content: textParts.join("") };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: responsesFinishReason(json) }],
    usage: mapResponsesUsage(json?.usage),
  };
}

function messagesToChatCompletion(json: any, model: string, requestId: string): any {
  const textParts: string[] = [];
  const toolCalls: any[] = [];
  let reasoning = "";

  for (const block of json?.content || []) {
    if (block?.type === "text") textParts.push(block.text || "");
    else if (block?.type === "thinking") reasoning += block.thinking || "";
    else if (block?.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const message: any = { role: "assistant", content: textParts.join("") };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: MESSAGES_STOP_REASONS[json?.stop_reason] || "stop",
      },
    ],
    usage: mapMessagesUsage(json?.usage),
  };
}

/* -------------------------------------------------------------------------- */
/* Streaming response translation (upstream SSE -> Chat Completions SSE)      */
/* -------------------------------------------------------------------------- */

export function createUpstreamStreamTransformer(
  api: UpstreamApi,
  model: string,
  requestId: string
): TransformStream<Uint8Array, Uint8Array> {
  if (api === "messages") return createMessagesStreamTransformer(model, requestId);
  if (api === "google") return createGoogleStreamTransformer(model, requestId);
  return createResponsesStreamTransformer(model, requestId);
}

function createGoogleStreamTransformer(
  model: string,
  requestId: string
): TransformStream<Uint8Array, Uint8Array> {
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let finished = false;
  let toolIndex = 0;
  let usage: any;

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, delta: any, finishReason: string | null = null, withUsage?: any) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(requestId, model, created, delta, finishReason, withUsage))}\n\n`));
  };

  return new TransformStream({
    start(controller) {
      emit(controller, { role: "assistant", content: "" });
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.error) {
          finished = true;
          const message = event.error.message || "Upstream response failed";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: "provider_error" } })}\n\n`));
          continue;
        }

        if (event.usageMetadata) usage = mapGoogleUsage(event.usageMetadata);

        const candidate = event.candidates?.[0];
        if (!candidate) continue;

        for (const part of candidate.content?.parts || []) {
          const delta = googlePartToDelta(part, toolIndex);
          if (delta.toolCall) {
            toolIndex++;
            emit(controller, { tool_calls: [delta.toolCall] });
          }
          if (delta.text) emit(controller, { content: delta.text });
          if (delta.reasoning) emit(controller, { reasoning_content: delta.reasoning });
        }

        if (candidate.finishReason) {
          finished = true;
          const finishReason = toolIndex > 0
            ? "tool_calls"
            : (GOOGLE_FINISH_REASONS[candidate.finishReason] || "stop");
          emit(controller, {}, finishReason, usage);
        }
      }
    },
    flush(controller) {
      if (!finished) emit(controller, {}, toolIndex > 0 ? "tool_calls" : "stop", usage);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}

function createResponsesStreamTransformer(
  model: string,
  requestId: string
): TransformStream<Uint8Array, Uint8Array> {
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let finished = false;
  let toolIndex = 0;
  const toolIndexByOutput = new Map<number, number>();

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, delta: any, finishReason: string | null = null, usage?: any) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(requestId, model, created, delta, finishReason, usage))}\n\n`));
  };

  return new TransformStream({
    start(controller) {
      emit(controller, { role: "assistant", content: "" });
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.type === "response.output_text.delta") {
          if (event.delta) emit(controller, { content: event.delta });
        } else if (
          event.type === "response.reasoning_summary_text.delta" ||
          event.type === "response.reasoning_text.delta"
        ) {
          if (event.delta) emit(controller, { reasoning_content: event.delta });
        } else if (event.type === "response.output_item.added") {
          const item = event.item;
          if (item?.type === "function_call") {
            const index = toolIndex++;
            toolIndexByOutput.set(event.output_index ?? index, index);
            emit(controller, {
              tool_calls: [
                { index, id: item.call_id, type: "function", function: { name: item.name, arguments: "" } },
              ],
            });
          }
        } else if (event.type === "response.function_call_arguments.delta") {
          const index = toolIndexByOutput.get(event.output_index) ?? 0;
          emit(controller, { tool_calls: [{ index, function: { arguments: event.delta || "" } }] });
        } else if (event.type === "response.completed") {
          finished = true;
          emit(controller, {}, responsesFinishReason(event.response), mapResponsesUsage(event.response?.usage));
        } else if (event.type === "response.failed" || event.type === "error") {
          finished = true;
          const message =
            event.response?.error?.message || event.error?.message || event.message || "Upstream response failed";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: "provider_error" } })}\n\n`));
        }
      }
    },
    flush(controller) {
      if (!finished) emit(controller, {}, "stop");
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}

function createMessagesStreamTransformer(
  model: string,
  requestId: string
): TransformStream<Uint8Array, Uint8Array> {
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let finished = false;
  let toolIndex = 0;
  const toolIndexByBlock = new Map<number, number>();
  let usage: any = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, delta: any, finishReason: string | null = null, withUsage?: any) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk(requestId, model, created, delta, finishReason, withUsage))}\n\n`));
  };

  return new TransformStream({
    start(controller) {
      emit(controller, { role: "assistant", content: "" });
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.type === "message_start") {
          const inputTokens = event.message?.usage?.input_tokens ?? 0;
          usage = { prompt_tokens: inputTokens, completion_tokens: 0, total_tokens: inputTokens };
        } else if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block?.type === "tool_use") {
            const index = toolIndex++;
            toolIndexByBlock.set(event.index ?? index, index);
            emit(controller, {
              tool_calls: [
                { index, id: block.id, type: "function", function: { name: block.name, arguments: "" } },
              ],
            });
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta?.type === "text_delta") {
            emit(controller, { content: delta.text || "" });
          } else if (delta?.type === "thinking_delta") {
            emit(controller, { reasoning_content: delta.thinking || "" });
          } else if (delta?.type === "input_json_delta") {
            const index = toolIndexByBlock.get(event.index) ?? 0;
            emit(controller, { tool_calls: [{ index, function: { arguments: delta.partial_json || "" } }] });
          }
        } else if (event.type === "message_delta") {
          finished = true;
          const completion = event.usage?.output_tokens ?? 0;
          usage = {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: completion,
            total_tokens: usage.prompt_tokens + completion,
          };
          emit(controller, {}, MESSAGES_STOP_REASONS[event.delta?.stop_reason] || "stop", usage);
        }
      }
    },
    flush(controller) {
      if (!finished) emit(controller, {}, "stop", usage);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}
