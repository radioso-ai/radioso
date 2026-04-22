export type AssistantExecutionClass = "interactive_synchronous" | "durable_async";

export type CoveredAssistantWorkflow =
  | "chat.turn"
  | "chat.bootstrap"
  | "eval.replay";

export interface AssistantWorkflowPolicy {
  workflow: CoveredAssistantWorkflow;
  executionClass: AssistantExecutionClass;
  operatorLabel: string;
  description: string;
}

const WORKFLOW_POLICIES: Record<CoveredAssistantWorkflow, AssistantWorkflowPolicy> = {
  "chat.turn": {
    workflow: "chat.turn",
    executionClass: "interactive_synchronous",
    operatorLabel: "Live chat turn",
    description: "Normal chat stays in the live request path so users get an immediate response or explicit failure.",
  },
  "chat.bootstrap": {
    workflow: "chat.bootstrap",
    executionClass: "interactive_synchronous",
    operatorLabel: "Bootstrap greeting",
    description: "Assistant-first greetings are created inline with the chat request and never deferred to background work.",
  },
  "eval.replay": {
    workflow: "eval.replay",
    executionClass: "interactive_synchronous",
    operatorLabel: "Eval replay",
    description: "Eval replay currently runs inline and remains a candidate for a future deferred assistant-work path.",
  },
};

export const listCoveredAssistantWorkflows = (): AssistantWorkflowPolicy[] =>
  (Object.keys(WORKFLOW_POLICIES) as CoveredAssistantWorkflow[]).map((workflow) => WORKFLOW_POLICIES[workflow]);

export const getAssistantWorkflowPolicy = (workflow: CoveredAssistantWorkflow): AssistantWorkflowPolicy =>
  WORKFLOW_POLICIES[workflow];

const buildExecutionMismatchError = (
  workflow: CoveredAssistantWorkflow,
  expected: AssistantExecutionClass,
  actual: AssistantExecutionClass,
): Error => {
  const error = new Error(
    `Assistant workflow "${workflow}" is classified as "${actual}", expected "${expected}".`,
  );
  error.name = "AssistantExecutionPolicyError";
  return error;
};

export const assertAssistantExecutionClass = (
  workflow: CoveredAssistantWorkflow,
  expected: AssistantExecutionClass,
): AssistantWorkflowPolicy => {
  const policy = getAssistantWorkflowPolicy(workflow);
  if (policy.executionClass !== expected) {
    throw buildExecutionMismatchError(workflow, expected, policy.executionClass);
  }
  return policy;
};

export const assertInteractiveAssistantWorkflow = (workflow: CoveredAssistantWorkflow): AssistantWorkflowPolicy =>
  assertAssistantExecutionClass(workflow, "interactive_synchronous");

export const assertDeferredAssistantWorkflow = (workflow: CoveredAssistantWorkflow): AssistantWorkflowPolicy =>
  assertAssistantExecutionClass(workflow, "durable_async");
