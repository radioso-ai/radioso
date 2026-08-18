import type { CopilotEntityReference } from "./contracts.js";

/**
 * Backend-owned mirror of the dashboard's public workspace routes. Keep every
 * Ray handoff URL here: the frontend has one route source, and the catalog has
 * one backend mirror that its focused tests pin to those shapes.
 */
export const buildCopilotDashboardLink = (
  workspaceKey: string,
  subject: CopilotEntityReference,
): string => {
  const base = `/w/${encodeURIComponent(workspaceKey)}`;

  switch (subject.type) {
    case "workspace_settings":
      return `${base}/settings`;
    case "agent":
      return subject.id ? `${base}/agents/${encodeURIComponent(subject.id)}` : `${base}/agents`;
    case "routine":
      return subject.id && subject.agentId
        ? `${base}/agents/${encodeURIComponent(subject.agentId)}/routines/${encodeURIComponent(subject.id)}`
        : `${base}/agents`;
    case "document":
      return subject.id ? `${base}/knowledge/documents/${encodeURIComponent(subject.id)}` : `${base}/knowledge`;
    case "conversation":
      return subject.id
        ? `${base}/activity?itemKind=chat&itemId=${encodeURIComponent(subject.id)}`
        : `${base}/activity`;
    case "quality_turn":
      return `${base}/quality`;
    case "proposal":
      return `${base}/copilot`;
    case "eval":
      return subject.id ? `${base}/eval/${encodeURIComponent(subject.id)}` : `${base}/eval`;
    case "audience_topics":
      return `${base}/quality?view=audience-pulse`;
    case "workspace":
    default:
      return `${base}/agents`;
  }
};

/** Collection routes still give terminal clients a usable dashboard handoff. */
export const dashboardSubjectForCopilotTool = (toolName: string): CopilotEntityReference => {
  switch (toolName) {
    case "workspace_settings":
      return { type: "workspace_settings" };
    case "agent_configuration":
    case "routine_definition":
    case "agent_skills":
      return { type: "agent" };
    case "conversation_transcript":
    case "turn_trace":
    case "conversation_history_search":
      return { type: "conversation" };
    case "document_search":
    case "document_status":
      return { type: "document" };
    case "eval_results":
      return { type: "eval" };
    case "quality_signals":
      return { type: "quality_turn" };
    case "audience_topics":
      return { type: "audience_topics" };
    case "propose_directive":
    case "propose_routine":
    case "propose_agent_setting":
      return { type: "proposal" };
    default:
      return { type: "workspace" };
  }
};
