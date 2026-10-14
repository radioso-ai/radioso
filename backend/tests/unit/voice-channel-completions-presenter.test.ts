import { describe, expect, it } from "vitest";

import {
  COMPLETION_ERROR_FRAME,
  createCompletionChunkRenderer,
  renderCompletion,
} from "../../src/modules/voiceChannel/adapters/openaiCompletions/completionsPresenter.js";
import type { VoiceTurnEvent } from "../../src/modules/voiceChannel/domain.js";

const identity = { id: "chatcmpl-test", created: 1_760_000_000, model: "radioso-voice" };

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

  it("ends a failed stream with one generic OpenAI error frame", () => {
    expect(COMPLETION_ERROR_FRAME).toBe(
      'data: {"error":{"message":"The agent could not finish this reply.","type":"server_error"}}\n\n',
    );
  });

  it("renders a whole turn as one chat.completion object for a non-streaming request", () => {
    expect(renderCompletion(identity, turn)).toEqual({
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
