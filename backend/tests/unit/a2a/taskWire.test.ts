import { describe, expect, it } from "vitest";

import type { A2aTaskRecord, A2aTurnEnvelope } from "../../../src/modules/a2a/contracts/ports.js";
import { authoredMessages, unseenHumanMessages } from "../../../src/modules/a2a/domain/turnMessages.js";
import { renderAgentMessage, renderTask, wireTaskState } from "../../../src/modules/a2a/domain/taskWire.js";
import { A2A_CONVERSE_EXTENSION_URI } from "../../../src/shared/domain/a2aConverseExtension.js";

const message = (id: string, source: string, text = `${source} says ${id}`) => ({ id, source, text, createdAt: "2026-11-09T10:00:00.000Z" });

const envelope: A2aTurnEnvelope = {
  answerCoverage: { availability: "not_recorded", originatingTurnId: "t", originatingRequestId: "r" },
  ownership: { state: "ai_owned", suppressed: false },
  routine: { toolName: "start_return", name: "Start a return", status: "waiting_for_input", pendingInput: [{ key: "reason", type: "text", required: true }] },
  citations: [],
};

const task = (overrides: Partial<A2aTaskRecord> = {}): A2aTaskRecord => ({
  id: "task-1",
  workspaceId: "w",
  conversationId: "c",
  contextToken: "ctx-token",
  contextExpiresAt: null,
  routineExecutionId: "exec-1",
  openingMessageId: "m1",
  callerMessageId: "m1",
  cursor: "cur",
  shownThroughMessageId: "m2",
  statusMessageId: "m2",
  artifactMessageId: null,
  envelope,
  state: "input_required",
  reason: "awaiting_input",
  humanStretch: false,
  stateAt: new Date("2026-11-09T10:00:01.000Z"),
  version: 1,
  ...overrides,
});

describe("message authorship", () => {
  it("reads the caller, the agent and a person from the stored source, and drops system notes", () => {
    expect(authoredMessages([
      message("m1", "customer"),
      message("m2", "ai_agent"),
      message("m3", "human_agent"),
      message("m4", "human_agent_on_behalf_of_ai_agent"),
      message("m5", "system"),
    ]).map((entry) => [entry.id, entry.author])).toEqual([
      ["m1", "caller"],
      ["m2", "agent"],
      ["m3", "human"],
      ["m4", "human"],
    ]);
  });

  it("finds the people's messages after the caller's previous message", () => {
    const transcript = authoredMessages([
      message("m1", "customer"),
      message("m2", "human_agent"),
      message("m3", "customer"),
      message("m4", "ai_agent"),
      message("m5", "human_agent"),
      message("m6", "human_agent"),
    ]);
    expect(unseenHumanMessages(transcript).map((entry) => entry.id)).toEqual(["m5", "m6"]);
    expect(unseenHumanMessages(authoredMessages([message("m1", "human_agent")])).map((entry) => entry.id)).toEqual(["m1"]);
  });
});

describe("A2A wire rendering", () => {
  it("spells states as ProtoJSON enum names", () => {
    expect(wireTaskState("input_required")).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(wireTaskState("canceled")).toBe("TASK_STATE_CANCELED");
  });

  it("renders an agent message with a text part and no extension metadata unless activated", () => {
    expect(renderAgentMessage({ messageId: "m2", text: "Hello", contextId: "ctx", extension: null })).toEqual({
      messageId: "m2",
      contextId: "ctx",
      role: "ROLE_AGENT",
      parts: [{ text: "Hello" }],
    });
    expect(renderAgentMessage({ messageId: "m2", text: "Hello", contextId: "ctx", taskId: "task-1", extension: { envelope, author: "agent" } }))
      .toMatchObject({
        taskId: "task-1",
        // A message that carries the extension's metadata names the extension (A2A v1.0 Message.extensions).
        extensions: [A2A_CONVERSE_EXTENSION_URI],
        metadata: {
          [A2A_CONVERSE_EXTENSION_URI]: {
            answerCoverage: envelope.answerCoverage,
            ownership: envelope.ownership,
            routine: envelope.routine,
            citations: [],
            author: "agent",
          },
        },
      });
  });

  it("renders a task with its status message, history roles, and no artifacts or metadata by default", () => {
    const transcript = authoredMessages([message("m1", "customer", "Return my order"), message("m2", "ai_agent", "Which order?")]);
    const rendered = renderTask({
      task: task(),
      statusMessage: transcript[1] ?? null,
      artifact: null,
      history: transcript,
      extensionActive: false,
      includeArtifacts: true,
    });
    expect(rendered).toEqual({
      id: "task-1",
      contextId: "ctx-token",
      status: {
        state: "TASK_STATE_INPUT_REQUIRED",
        message: { messageId: "m2", contextId: "ctx-token", taskId: "task-1", role: "ROLE_AGENT", parts: [{ text: "Which order?" }] },
        timestamp: "2026-11-09T10:00:01.000Z",
      },
      history: [
        { messageId: "m1", contextId: "ctx-token", taskId: "task-1", role: "ROLE_USER", parts: [{ text: "Return my order" }] },
        { messageId: "m2", contextId: "ctx-token", taskId: "task-1", role: "ROLE_AGENT", parts: [{ text: "Which order?" }] },
      ],
    });
  });

  it("renders a completed routine's reply as the artifact, and the reason and envelope when the extension is active", () => {
    const reply = authoredMessages([message("m4", "ai_agent", "Your return is booked.")])[0];
    if (!reply) throw new Error("expected a reply");
    const rendered = renderTask({
      task: task({ state: "completed", reason: "routine_completed", statusMessageId: null, artifactMessageId: "m4" }),
      statusMessage: null,
      artifact: reply,
      history: null,
      extensionActive: true,
      includeArtifacts: true,
    });
    expect(rendered.status).toEqual({ state: "TASK_STATE_COMPLETED", timestamp: "2026-11-09T10:00:01.000Z" });
    expect(rendered.history).toBeUndefined();
    expect(rendered.artifacts).toEqual([{
      artifactId: "m4",
      name: "Start a return",
      parts: [{ text: "Your return is booked." }],
      extensions: [A2A_CONVERSE_EXTENSION_URI],
      metadata: { [A2A_CONVERSE_EXTENSION_URI]: expect.objectContaining({ author: "agent", routine: envelope.routine }) },
    }]);
    expect(rendered.metadata).toEqual({ [A2A_CONVERSE_EXTENSION_URI]: { reason: "routine_completed" } });
  });

  it("leaves artifacts out when the caller did not ask for them", () => {
    const reply = authoredMessages([message("m4", "ai_agent")])[0] ?? null;
    expect(renderTask({
      task: task({ state: "completed" }),
      statusMessage: null,
      artifact: reply,
      history: null,
      extensionActive: false,
      includeArtifacts: false,
    }).artifacts).toBeUndefined();
  });
});
