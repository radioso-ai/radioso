import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  TextRoutedToolCallingGateway,
  compactTranscript,
  extractJsonBlock,
  parseModelResponse,
  type ModelToolCallRequest,
  type ModelTranscriptEntry,
} from "../../src/shared/agent-runtime/index.js";
import type { TextGenerationClient } from "../../src/shared/infra/llm/providerTypes.js";

const stubTextClient = (
  responder: (input: { prompt: string; systemPrompt?: string }) => string | Promise<string>,
): TextGenerationClient & { calls: Array<{ prompt: string; systemPrompt?: string }> } => {
  const calls: Array<{ prompt: string; systemPrompt?: string }> = [];
  return {
    metadata: { capability: "chat", provider: "openai", model: "test-model" },
    async complete(input) {
      calls.push({ prompt: input.prompt, systemPrompt: input.systemPrompt });
      return responder(input);
    },
    async *stream() {
      // not used
    },
    calls,
  } as TextGenerationClient & { calls: Array<{ prompt: string; systemPrompt?: string }> };
};

const buildRequest = (overrides: Partial<ModelToolCallRequest> = {}): ModelToolCallRequest => ({
  stepIndex: 0,
  systemPrompt: "you are an agent",
  transcript: [{ role: "user", content: "find gandhi" }],
  toolSchemas: [
    {
      name: "semantic_search",
      description: "Find chunks similar to a query",
      inputSchema: z.object({ query: z.string().min(1) }),
    },
  ],
  signal: new AbortController().signal,
  ...overrides,
});

describe("extractJsonBlock", () => {
  it("returns null on empty input", () => {
    expect(extractJsonBlock("")).toBeNull();
    expect(extractJsonBlock("   ")).toBeNull();
  });

  it("extracts a bare JSON object", () => {
    expect(extractJsonBlock('{"text":"hi","tool_calls":[]}')).toBe('{"text":"hi","tool_calls":[]}');
  });

  it("strips markdown code fences", () => {
    expect(extractJsonBlock('```json\n{"text":"hi"}\n```')).toBe('{"text":"hi"}');
    expect(extractJsonBlock('```\n{"x":1}\n```')).toBe('{"x":1}');
  });

  it("extracts the JSON object when the model wraps it in prose", () => {
    const raw = 'Sure, here you go:\n{"text":"hi","tool_calls":[]}\nLet me know if you want more.';
    expect(extractJsonBlock(raw)).toBe('{"text":"hi","tool_calls":[]}');
  });

  it("handles braces inside string values without breaking", () => {
    const raw = '{"text":"contains {braces} inside","tool_calls":[]}';
    expect(extractJsonBlock(raw)).toBe(raw);
  });

  it("handles escaped quotes inside string values", () => {
    const raw = '{"text":"he said \\"hi\\"","tool_calls":[]}';
    expect(extractJsonBlock(raw)).toBe(raw);
  });
});

describe("parseModelResponse", () => {
  it("returns no tool calls and the trimmed text when the response is not parseable JSON", () => {
    const result = parseModelResponse("just a plain message");
    expect(result).toEqual({ assistantMessage: "just a plain message", toolCalls: [] });
  });

  it("parses a tool_calls array and preserves arguments as a JSON string", () => {
    const raw =
      '{"text":"searching","tool_calls":[{"id":"c1","name":"semantic_search","arguments":{"query":"gandhi"}}]}';
    const result = parseModelResponse(raw);
    expect(result.assistantMessage).toBe("searching");
    expect(result.toolCalls).toEqual([
      { callId: "c1", toolName: "semantic_search", rawArguments: '{"query":"gandhi"}' },
    ]);
  });

  it("synthesizes a callId when the model omits one", () => {
    const raw = '{"text":"","tool_calls":[{"name":"semantic_search","arguments":{}}]}';
    const result = parseModelResponse(raw);
    expect(result.toolCalls[0].callId).toMatch(/^call_/);
  });

  it("drops tool calls missing a name", () => {
    const raw = '{"text":"","tool_calls":[{"arguments":{"query":"x"}},{"name":"valid","arguments":{}}]}';
    const result = parseModelResponse(raw);
    expect(result.toolCalls.map((c) => c.toolName)).toEqual(["valid"]);
  });

  it("returns an empty tool_calls array when the model declares it is done", () => {
    const raw = '{"text":"all set","tool_calls":[]}';
    const result = parseModelResponse(raw);
    expect(result).toEqual({ assistantMessage: "all set", toolCalls: [] });
  });

  it("treats arguments-as-string the model already serialized as the rawArguments value", () => {
    const raw = '{"text":"","tool_calls":[{"id":"c1","name":"t","arguments":"{\\"a\\":1}"}]}';
    const result = parseModelResponse(raw);
    expect(result.toolCalls[0].rawArguments).toBe('{"a":1}');
  });
});

describe("TextRoutedToolCallingGateway.request", () => {
  it("renders the tool catalog into the system prompt with a compact prose signature per tool", async () => {
    const client = stubTextClient(() => '{"text":"ok","tool_calls":[]}');
    const gateway = new TextRoutedToolCallingGateway(client);
    await gateway.request(buildRequest());
    const sp = client.calls[0].systemPrompt ?? "";
    expect(sp).toContain("semantic_search");
    expect(sp).toContain("Find chunks similar to a query");
    expect(sp).toContain("(query: string)");
  });

  it("renders the transcript into the prompt, including tool-call payloads and tool results", async () => {
    const client = stubTextClient(() => '{"text":"done","tool_calls":[]}');
    const gateway = new TextRoutedToolCallingGateway(client);
    await gateway.request(
      buildRequest({
        transcript: [
          { role: "user", content: "find gandhi" },
          {
            role: "assistant",
            content: "let me search",
            toolCalls: [{ callId: "c1", toolName: "semantic_search", rawArguments: '{"query":"gandhi"}' }],
          },
          { role: "tool", callId: "c1", toolName: "semantic_search", content: '{"results":[]}', isError: false },
        ],
      }),
    );
    const prompt = client.calls[0].prompt;
    expect(prompt).toContain("USER:");
    expect(prompt).toContain("find gandhi");
    expect(prompt).toContain("ASSISTANT:");
    expect(prompt).toContain('"id":"c1"');
    expect(prompt).toContain("TOOL RESULT");
    expect(prompt).toContain('{"results":[]}');
  });

  it("flags failed tool results in the rendered transcript", async () => {
    const client = stubTextClient(() => '{"text":"done","tool_calls":[]}');
    const gateway = new TextRoutedToolCallingGateway(client);
    await gateway.request(
      buildRequest({
        transcript: [
          { role: "user", content: "go" },
          { role: "assistant", content: "", toolCalls: [{ callId: "c1", toolName: "t", rawArguments: "{}" }] },
          { role: "tool", callId: "c1", toolName: "t", content: "boom", isError: true },
        ],
      }),
    );
    expect(client.calls[0].prompt).toContain("[ERROR]");
  });

  it("parses the model's tool call out of the completion text", async () => {
    const client = stubTextClient(
      () => '{"text":"searching","tool_calls":[{"id":"c-1","name":"semantic_search","arguments":{"query":"q"}}]}',
    );
    const gateway = new TextRoutedToolCallingGateway(client);
    const result = await gateway.request(buildRequest());
    expect(result.toolCalls[0]).toEqual({
      callId: "c-1",
      toolName: "semantic_search",
      rawArguments: '{"query":"q"}',
    });
  });

  it("survives a model that wraps its JSON in code fences", async () => {
    const client = stubTextClient(() => '```json\n{"text":"hi","tool_calls":[]}\n```');
    const gateway = new TextRoutedToolCallingGateway(client);
    const result = await gateway.request(buildRequest());
    expect(result.assistantMessage).toBe("hi");
    expect(result.toolCalls).toEqual([]);
  });

  it("treats an unparseable response as a final message rather than crashing", async () => {
    const client = stubTextClient(() => "not json at all");
    const gateway = new TextRoutedToolCallingGateway(client);
    const result = await gateway.request(buildRequest());
    expect(result).toEqual({ assistantMessage: "not json at all", toolCalls: [] });
  });
});

describe("compactTranscript", () => {
  const userTurn = (content: string): ModelTranscriptEntry => ({ role: "user", content });
  const assistantTurn = (callIds: string[]): ModelTranscriptEntry => ({
    role: "assistant",
    content: "",
    toolCalls: callIds.map((id) => ({ callId: id, toolName: "semantic_search", rawArguments: "{}" })),
  });
  const toolResult = (callId: string, content: string): ModelTranscriptEntry => ({
    role: "tool",
    callId,
    toolName: "semantic_search",
    content,
    isError: false,
  });

  it("leaves a short transcript untouched", () => {
    const t = [userTurn("q"), assistantTurn(["c1"]), toolResult("c1", '{"results":[]}')];
    expect(compactTranscript(t)).toEqual(t);
  });

  it("compacts tool results from steps older than the two most recent", () => {
    const oldResult = JSON.stringify({ results: [{ chunkId: "old-1" }, { chunkId: "old-2" }] });
    const recentResult = JSON.stringify({ results: [{ chunkId: "new-1" }] });
    const t: ModelTranscriptEntry[] = [
      userTurn("q"),
      assistantTurn(["c-old"]),
      toolResult("c-old", oldResult),
      assistantTurn(["c-mid"]),
      toolResult("c-mid", recentResult),
      assistantTurn(["c-new"]),
      toolResult("c-new", recentResult),
    ];
    const result = compactTranscript(t);
    const oldToolEntry = result[2];
    expect(oldToolEntry.role).toBe("tool");
    if (oldToolEntry.role === "tool") {
      expect(oldToolEntry.content).toContain("chunks elided");
      expect(oldToolEntry.content).toContain("old-1");
      expect(oldToolEntry.content).toContain("old-2");
    }
    const recentToolEntry = result[4];
    if (recentToolEntry.role === "tool") {
      expect(recentToolEntry.content).toBe(recentResult);
    }
  });

  it("compacts non-search tool results to a char-count placeholder", () => {
    const big = "x".repeat(5000);
    const t: ModelTranscriptEntry[] = [
      userTurn("q"),
      assistantTurn(["c-old"]),
      toolResult("c-old", big),
      assistantTurn(["c-mid"]),
      toolResult("c-mid", "{}"),
      assistantTurn(["c-new"]),
      toolResult("c-new", "{}"),
    ];
    const result = compactTranscript(t);
    if (result[2].role === "tool") {
      expect(result[2].content).toBe("[5000 chars elided]");
    }
  });

  it("preserves tool errors with truncation rather than collapsing them", () => {
    const longError = "error: ".repeat(80);
    const t: ModelTranscriptEntry[] = [
      userTurn("q"),
      assistantTurn(["c-err"]),
      { role: "tool", callId: "c-err", toolName: "ghost", content: longError, isError: true },
      assistantTurn(["c-mid"]),
      toolResult("c-mid", "{}"),
      assistantTurn(["c-new"]),
      toolResult("c-new", "{}"),
    ];
    const result = compactTranscript(t);
    if (result[2].role === "tool") {
      expect(result[2].content).toContain("error: ");
      expect(result[2].content.length).toBeLessThanOrEqual(201);
    }
  });
});
