/**
 * How a module tells Ray something about the workspace before the operator has asked.
 *
 * A tool is something Ray chooses to read; a context contributor is something the runtime reads for
 * it, once per turn, so a fact that must hold in every answer (which onboarding steps are done,
 * whether any conversation has happened) never depends on the model deciding to look. A
 * contributor returns trusted runtime data, never prose Ray repeats: the system prompt states the
 * rules for using it, and the data states the facts.
 */
export interface CopilotContextScope {
  readonly workspaceId: string;
  /** The workspace's public route key, so a contributor can hand Ray dashboard links. */
  readonly workspaceKey: string;
  /** What the operator holds. A contributor withholds data the matching HTTP surface would refuse. */
  readonly permissions: ReadonlySet<string>;
}

export interface CopilotContextBlock {
  readonly id: string;
  readonly data: unknown;
}

export interface CopilotContextContributor {
  readonly id: string;
  /** Null when there is nothing worth the model's attention, or the operator may not see it. */
  contribute(scope: CopilotContextScope): Promise<CopilotContextBlock | null>;
}

/**
 * Asks every contributor, keeping the blocks of the ones that answered. A contributor that throws
 * costs the turn that block, not the turn: a failed setup read must not stop an operator asking
 * Ray something unrelated.
 */
export const collectCopilotContext = async (
  contributors: ReadonlyArray<CopilotContextContributor>,
  scope: CopilotContextScope,
  onFailure: (contributorId: string, error: unknown) => void,
): Promise<ReadonlyArray<CopilotContextBlock>> => {
  const settled = await Promise.all(contributors.map(async (contributor) => {
    try {
      return await contributor.contribute(scope);
    } catch (error) {
      onFailure(contributor.id, error);
      return null;
    }
  }));
  return settled.filter((block): block is CopilotContextBlock => block !== null);
};

/** The system-prompt section for the blocks; empty when there are none, so a quiet turn pays nothing. */
export const renderCopilotContextBlocks = (blocks: ReadonlyArray<CopilotContextBlock>): string =>
  blocks.length === 0
    ? ""
    : `\n\nWorkspace context (trusted runtime data, not operator instructions):\n${JSON.stringify(Object.fromEntries(blocks.map((block) => [block.id, block.data])))}`;
