import { describe, expect, it } from "vitest";

import {
  assertAssistantExecutionClass,
  assertInteractiveAssistantWorkflow,
  getAssistantWorkflowPolicy,
  listCoveredAssistantWorkflows,
} from "../../src/modules/chat/services/chatExecutionPolicy.js";

describe("chat execution policy", () => {
  it("classifies live chat and bootstrap as interactive workflows", () => {
    expect(assertInteractiveAssistantWorkflow("chat.turn")).toMatchObject({
      workflow: "chat.turn",
      executionClass: "interactive_synchronous",
    });
    expect(assertInteractiveAssistantWorkflow("chat.bootstrap")).toMatchObject({
      workflow: "chat.bootstrap",
      executionClass: "interactive_synchronous",
    });
  });

  it("keeps eval replay on the current inline execution path", () => {
    expect(assertInteractiveAssistantWorkflow("eval.replay")).toMatchObject({
      workflow: "eval.replay",
      executionClass: "interactive_synchronous",
    });
  });

  it("fails loudly when a caller expects the wrong execution class", () => {
    expect(() => assertAssistantExecutionClass("chat.turn", "durable_async")).toThrow(
      'Assistant workflow "chat.turn" is classified as "interactive_synchronous", expected "durable_async".',
    );
  });

  it("lists the covered assistant workflows for docs and operator guidance", () => {
    expect(listCoveredAssistantWorkflows()).toEqual([
      getAssistantWorkflowPolicy("chat.turn"),
      getAssistantWorkflowPolicy("chat.bootstrap"),
      getAssistantWorkflowPolicy("eval.replay"),
    ]);
  });
});
