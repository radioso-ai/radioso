import { describe, expect, it } from "vitest";

import type { EvalSnapshot } from "../../src/modules/eval/domain/types.js";
import { buildReplayInputs } from "../../src/modules/eval/services/evalRunner.js";

const fixedDate = "2026-05-23T12:00:00.000Z";

const snapshot = (overrides: Partial<EvalSnapshot> = {}): EvalSnapshot => ({
  id: "snap-1",
  workspaceId: "ws-1",
  sourceConversationId: "conv-1",
  sourceMessageId: "a2",
  replayTarget: null,
  fidelity: "messages_only",
  messages: [
    { id: "u1", role: "user", content: "First question", createdAt: fixedDate },
    { id: "a1", role: "assistant", content: "First answer", createdAt: fixedDate },
    { id: "u2", role: "user", content: "Second question", createdAt: fixedDate },
    { id: "a2", role: "assistant", content: "Second answer", createdAt: fixedDate },
  ],
  originalInstructionBlock: null,
  originalModelId: null,
  originalRetrievalSettings: null,
  originalRetrievalResult: null,
  originalAgent: null,
  originalAgentConfig: null,
  sourceAgentId: null,
  originalRoutineState: null,
  capturedAt: fixedDate,
  capturedBy: null,
  ...overrides,
});

describe("buildReplayInputs", () => {
  it("uses an explicit replay target instead of the last user in the snapshot", () => {
    const replay = buildReplayInputs(snapshot({
      sourceMessageId: "a1",
      replayTarget: {
        userMessageId: "u1",
        assistantMessageId: "a1",
      },
    }));

    expect(replay?.query).toBe("First question");
    expect(replay?.history).toEqual([]);
  });

  it("falls back to the last user message for legacy snapshots without a replay target", () => {
    const replay = buildReplayInputs(snapshot());

    expect(replay?.query).toBe("Second question");
    expect(replay?.history.map((message) => message.id)).toEqual(["u1", "a1"]);
  });
});

