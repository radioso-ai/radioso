import { describe, expect, it } from "vitest";

import {
  COMPLETION_ERROR_FRAME,
  createCompletionChunkRenderer,
  renderCompletion,
} from "../../src/modules/voiceChannel/adapters/openaiCompletions/completionsPresenter.js";
import type { VoiceTurnEvent } from "../../src/modules/voiceChannel/domain.js";

const identity = { id: "chatcmpl-test", created: 1_760_000_000, model: "radioso-voice" };

const deltaOf = (frame: string): unknown => {
  const data = frame.slice("data: ".length).trim();
  return data === "[DONE]" ? data : (JSON.parse(data) as { choices: [{ delta: unknown }] }).choices[0].delta;
};

const turn: VoiceTurnEvent[] = [
  { type: "conversation", conversationId: "55555555-5555-4555-8555-555555555555" },
  { type: "speech", text: "We open at nine. ", last: false },
  { type: "speech", text: "See you then!", last: true },
  { type: "outcome", outcome: { kind: "continue" } },
];

describe("OpenAI completions presenter", () => {
  it("renders speech as chat.completion.chunk frames, the role on the first only, then stop and [DONE]", () => {
    const render = createCompletionChunkRenderer(identity);

    expect(turn.flatMap(render)).toEqual([
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1760000000,"model":"radioso-voice",'
        + '"choices":[{"index":0,"delta":{"role":"assistant","content":"We open at nine. "},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1760000000,"model":"radioso-voice",'
        + '"choices":[{"index":0,"delta":{"content":"See you then!"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1760000000,"model":"radioso-voice",'
        + '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  });

  it("ends a turn that requests a callback the way it ends one that continues: stop and [DONE], no tool call", () => {
    const callback: VoiceTurnEvent[] = [
      ...turn.slice(0, -1),
      { type: "outcome", outcome: { kind: "callback_requested", handoffReason: "routine_handoff" } },
    ];

    expect(callback.flatMap(createCompletionChunkRenderer(identity))).toEqual(turn.flatMap(createCompletionChunkRenderer(identity)));
    expect(renderCompletion(identity, callback)).toEqual(renderCompletion(identity, turn));
  });

  it("writes nothing for an empty final piece and still opens the reply with the role when nothing was spoken", () => {
    const render = createCompletionChunkRenderer(identity);
    const frames = [
      { type: "speech", text: "", last: true },
      { type: "outcome", outcome: { kind: "continue" } },
    ].flatMap((event) => render(event as VoiceTurnEvent));

    expect(frames).toHaveLength(3);
    expect(JSON.parse(frames[0].slice("data: ".length))).toMatchObject({
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
    expect(JSON.parse(frames[1].slice("data: ".length))).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    expect(frames[2]).toBe("data: [DONE]\n\n");
  });

  it("speaks a bridge line as a content delta, like any other speech", () => {
    const render = createCompletionChunkRenderer(identity);
    const frames = [
      { type: "bridge", text: "Let me check." },
      { type: "speech", text: "We open at nine.", last: true },
      { type: "outcome", outcome: { kind: "continue" } },
    ].flatMap((event) => render(event as VoiceTurnEvent));

    expect(frames.map(deltaOf)).toEqual([
      { role: "assistant", content: "Let me check." },
      { content: "We open at nine." },
      {},
      "[DONE]",
    ]);
  });

  it("follows every bridge line and sentence with the dialect's flush delta", () => {
    const render = createCompletionChunkRenderer(identity, { sentenceFlushDelta: " \u200B" });
    const frames = [
      { type: "conversation", conversationId: "55555555-5555-4555-8555-555555555555" },
      { type: "bridge", text: "Let me check." },
      { type: "speech", text: "We open at nine. ", last: false },
      { type: "speech", text: "See you then!", last: true },
      { type: "outcome", outcome: { kind: "continue" } },
    ].flatMap((event) => render(event as VoiceTurnEvent));

    expect(frames.map(deltaOf)).toEqual([
      { role: "assistant", content: "Let me check." },
      { content: " \u200B" },
      { content: "We open at nine. " },
      { content: " \u200B" },
      { content: "See you then!" },
      { content: " \u200B" },
      {},
      "[DONE]",
    ]);
  });

  it("renders a keep-alive as a content delta, sending the role first when nothing has been written", () => {
    const render = createCompletionChunkRenderer(identity);

    expect([...render({ type: "keep_alive", delta: " \u200B" }), ...render({ type: "keep_alive", delta: " \u200B" })]
      .map(deltaOf)).toEqual([
      { role: "assistant", content: "" },
      { content: " \u200B" },
      { content: " \u200B" },
    ]);
  });

  it("sends no flush delta after an empty final piece", () => {
    const render = createCompletionChunkRenderer(identity, { sentenceFlushDelta: " \u200B" });

    expect(render({ type: "speech", text: "", last: true })).toEqual([]);
  });

  it("ends a failed stream with one generic OpenAI error frame", () => {
    expect(COMPLETION_ERROR_FRAME).toBe(
      'data: {"error":{"message":"The agent could not finish this reply.","type":"server_error"}}\n\n',
    );
  });

  it("renders a whole turn as one chat.completion object for a non-streaming request", () => {
    expect(renderCompletion(identity, [{ type: "bridge", text: "Let me check." }, ...turn])).toEqual({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_760_000_000,
      model: "radioso-voice",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "We open at nine. See you then!" },
        finish_reason: "stop",
      }],
    });
  });
});

describe("a switch of the call's language", () => {
  /** How the elevenlabs dialect names its `language_detection` tool and arguments. */
  const languageSwitch = { tool: "language_detection", argument: "language", reasonArgument: "reason" };
  const switching: VoiceTurnEvent[] = [
    { type: "conversation", conversationId: "55555555-5555-4555-8555-555555555555" },
    { type: "switchLanguage", switchId: "switch-1", language: "it", reason: "response_language" },
    { type: "outcome", outcome: { kind: "continue" } },
  ];
  const chunk = (choice: string) =>
    `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1760000000,"model":"radioso-voice","choices":[${choice}]}\n\n`;
  const toolCall = '{"index":0,"id":"switch-1","type":"function","function":{"name":"language_detection","arguments":"{\\"reason\\":\\"response_language\\",\\"language\\":\\"it\\"}"}}';

  it("streams the tool call alone and ends it with tool_calls and [DONE]: no content, so the runtime speaks nothing twice", () => {
    const render = createCompletionChunkRenderer(identity, { sentenceFlushDelta: " ​", languageSwitch });

    expect(switching.flatMap(render)).toEqual([
      chunk(`{"index":0,"delta":{"role":"assistant","tool_calls":[${toolCall}]},"finish_reason":null}`),
      chunk('{"index":0,"delta":{},"finish_reason":"tool_calls"}'),
      "data: [DONE]\n\n",
    ]);
  });

  it("does not repeat the role after a keep-alive opened the reply", () => {
    const render = createCompletionChunkRenderer(identity, { languageSwitch });

    render({ type: "keep_alive", delta: " ​" });
    expect(deltaOf(render(switching[1])[0])).toEqual(JSON.parse(`{"tool_calls":[${toolCall}]}`));
  });

  it("answers a request that is not streamed with one tool-call message", () => {
    expect(renderCompletion(identity, switching, { languageSwitch })).toEqual({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_760_000_000,
      model: "radioso-voice",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "switch-1", type: "function", function: { name: "language_detection", arguments: '{"reason":"response_language","language":"it"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    });
  });
});
