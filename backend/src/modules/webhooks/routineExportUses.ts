/**
 * Which routines export their completions to a webhook destination. A completed routine delivers to
 * the destination its agent's published release froze, not the draft's, so a destination stays in
 * use while a draft routine exports to it and also while the published release still does, after
 * the draft pointed the export elsewhere or switched it off.
 */

export interface RoutineExportUse {
  readonly agentId: string;
  readonly agentName: string;
  readonly routineName: string;
  /** The draft's routine exports to the destination: pointing it elsewhere or turning it off frees it. */
  readonly inDraft: boolean;
  /** The published release's routine exports to it: only publishing a draft without it frees it. */
  readonly inPublishedRelease: boolean;
}

const quoted = (value: string): string => `"${value}"`;

const quotedList = (values: readonly string[]): string => values.map(quoted).join(", ");

const describeDraftExports = (inDraft: readonly RoutineExportUse[]): string | null => {
  if (inDraft.length === 0) return null;
  const routines = inDraft.map((use) => `routine ${quoted(use.routineName)} on agent ${quoted(use.agentName)}`);
  const toPublish = [...new Set(inDraft.filter((use) => use.inPublishedRelease).map((use) => use.agentName))];
  const thenPublish = toPublish.length === 0
    ? " first"
    : `, then publish ${toPublish.length === 1 ? "agent" : "agents"} ${quotedList(toPublish)}`;
  return `Used by ${routines.join(", ")}. Point ${inDraft.length === 1 ? "its export" : "their exports"} elsewhere or turn ${inDraft.length === 1 ? "it" : "them"} off${thenPublish}.`;
};

/**
 * Why a destination that routines export to cannot be deleted yet: the draft routines to re-point
 * or turn off, and the agents whose published version still exports to it and needs publishing.
 * An agent the draft sentence already says to publish is not told to again.
 */
export const describeRoutineExportUses = (uses: readonly RoutineExportUse[]): string => {
  const inDraft = uses.filter((use) => use.inDraft);
  const sentences = [describeDraftExports(inDraft)].filter((sentence) => sentence !== null);
  const publishedAfterDraft = new Set(inDraft.filter((use) => use.inPublishedRelease).map((use) => use.agentId));
  const releasedByAgent = new Map<string, { agentName: string; routineNames: string[] }>();
  for (const use of uses) {
    if (use.inDraft || !use.inPublishedRelease) continue;
    const agent = releasedByAgent.get(use.agentId) ?? { agentName: use.agentName, routineNames: [] };
    agent.routineNames.push(use.routineName);
    releasedByAgent.set(use.agentId, agent);
  }
  for (const [agentId, { agentName, routineNames }] of releasedByAgent) {
    const routines = `${routineNames.length === 1 ? "routine" : "routines"} ${quotedList(routineNames)}`;
    sentences.push(publishedAfterDraft.has(agentId)
      ? `The published version of agent ${quoted(agentName)} also still exports ${routines} to it.`
      : `The published version of agent ${quoted(agentName)} still exports ${routines} to it. Publish agent ${quoted(agentName)} first.`);
  }
  return sentences.join(" ");
};
