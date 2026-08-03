import type { UsageOperation, UsageOperationAttribution } from "./contracts/index.js";

const knownLabels = new Map<string, string>([
  ["documents:document_enrichment", "Metadata generation"],
  ["agent_wizard:analyze_website", "Agent setup"],
  ["agents:draft_directive", "Draft directive"],
  ["agents:directive_coherence", "Directive coherence"],
  ["assistant:answer", "Answer"],
]);

const humanize = (value: string): string => value
  .split(/[_-]+/)
  .filter(Boolean)
  .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
  .join(" ") || "Unknown operation";

const contextPrefix = (input: {
  surface: string;
  conversationSourceChannel?: string | null;
}): string | null => {
  if (input.surface === "eval") return "Evaluation";
  if (input.conversationSourceChannel === "authenticated_chat") return "Test chat";
  if (input.conversationSourceChannel === "workbench_replay") return "Workbench replay";
  return null;
};

export const labelUsageOperation = (
  operation: UsageOperationAttribution,
  context?: { conversationSourceChannel?: string | null },
): UsageOperation => {
  const label = knownLabels.get(`${operation.surface}:${operation.name}`) ?? humanize(operation.name);
  const prefix = contextPrefix({ ...operation, ...context });
  return {
    ...operation,
    label: prefix ? `${prefix}: ${label}` : label,
  };
};
