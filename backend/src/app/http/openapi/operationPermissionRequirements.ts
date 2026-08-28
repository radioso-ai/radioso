import type { AccountPermission } from "../../../modules/account/public.js";

/** HTTP-owned authorization requirements for one-to-one Ray parity checks. */
export const operationPermissionRequirements: Readonly<Record<string, readonly AccountPermission[]>> = {
  listEvalCases: ["workspace.retrieval.query"],
  getOrCreateEvalCaseBySourceMessage: ["workspace.retrieval.query"],
  runEvalCases: ["workspace.retrieval.query"],
  createEvalRun: ["workspace.retrieval.query"],
  validateAgentRoutine: ["workspace.agents.read"],
  createAssistantChatResponse: ["workspace.chat.use"],
  createAgentRoutine: ["workspace.agents.manage"],
  updateAgentRoutine: ["workspace.agents.manage"],
  reviseAgentRoutine: ["workspace.agents.manage"],
  publishAgentRoutine: ["workspace.agents.manage"],
  archiveAgentRoutine: ["workspace.agents.manage"],
  restoreAgentRoutine: ["workspace.agents.manage"],
  updateAgent: ["workspace.agents.manage"],
  createAgentDirective: ["workspace.agents.manage"],
  updateAgentDirective: ["workspace.agents.manage"],
};
