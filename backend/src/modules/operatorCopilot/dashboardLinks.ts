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
    // Ingestion settings are a tab on Knowledge, and the dashboard drops the default tab from the
    // URL, so this one has to name its tab explicitly.
    case "ingestion_settings":
      return `${base}/knowledge?knowledgeTab=ingestion`;
    case "document":
      return subject.id ? `${base}/knowledge/documents/${encodeURIComponent(subject.id)}` : `${base}/knowledge`;
    case "conversation":
      return subject.id
        ? `${base}/activity?itemKind=chat&itemId=${encodeURIComponent(subject.id)}`
        : `${base}/activity`;
    case "quality_turn":
      return `${base}/quality`;
    // Activity opens on Needs Attention by default, and the dashboard drops the default tab from
    // the URL, so the bare section path is the canonical link to the operator's inbox.
    case "needs_attention":
      return `${base}/activity`;
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
