import { isDeepStrictEqual } from "node:util";

import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type { CopilotExpensiveOperationGuardDependencies } from "../contracts/expensiveOperation.js";
import type {
  CopilotAgentDirectivesPort,
  CopilotEvalCaseReaderPort,
  CopilotEvalCaseReplayInput,
  CopilotEvalCaseReplayOverrides,
  CopilotEvalCaseReplayPort,
  CopilotEvalCaseReplayResult,
  CopilotEvalCaseReplayRunnerPort,
  CopilotReplayEvidenceRepositoryPort,
} from "../contracts/evalCases.js";
import { enforceCopilotExpensiveOperation, withCopilotSpendRefusals } from "./expensiveOperationGuard.js";

/** Directive names are unique per agent (`UNIQUE(agent_id, name)`, migration 076), and canonical
 * directive serialization never carries an id, so a directive's name is the only stable key that
 * lets a live directive be matched against its counterpart in a case's captured snapshot. */
const readDirectiveName = (config: Record<string, unknown>): string | null => {
  const name = config.name;
  return typeof name === "string" && name.length > 0 ? name : null;
};

/**
 * A snapshot captured before a field existed simply omits it, while the live serialization states
 * it. Comparing those directly would report an untouched directive as changed and refuse a replay
 * that is perfectly honest, so both sides are read through the same defaults materialization
 * applies: an absent `enabled` means the directive was in play. Defaulting both sides rather than
 * only the snapshot keeps the comparison symmetric, so it stays a question about the directive's
 * content rather than about which side happens to spell a default out.
 */
const withDirectiveDefaults = (config: Record<string, unknown>): Record<string, unknown> =>
  Object.prototype.hasOwnProperty.call(config, "enabled") ? config : { ...config, enabled: true };

export interface EvalCaseReplayServiceDependencies extends CopilotExpensiveOperationGuardDependencies {
  cases: CopilotEvalCaseReaderPort;
  runs: CopilotEvalCaseReplayRunnerPort;
  evidence: CopilotReplayEvidenceRepositoryPort;
  /** Resolves a directive exclusion against real agent state; see {@link CopilotAgentDirectivesPort}. */
  agentDirectives: CopilotAgentDirectivesPort;
}

interface ResolvedDirectiveExclusion {
  overrides: CopilotEvalCaseReplayOverrides | undefined;
  /** Real directive ids the replay actually excluded, for the evidence row to carry. */
  directivesExcluded: ReadonlyArray<string>;
}

/**
 * Replays one captured case against a configuration the operator has not adopted, so a proposal
 * can carry a measured verdict instead of an assertion. The run is detached on purpose: the case
 * keeps the verdict the library recorded, and trying a change never moves the suite's pass rate.
 * The replay is always a full assistant turn, because the overrides worth measuring — instructions,
 * directives, a mid-routine start — only take effect on the conversation-engine path.
 */
export class EvalCaseReplayService implements CopilotEvalCaseReplayPort {
  constructor(private readonly dependencies: EvalCaseReplayServiceDependencies) {}

  async replayCase(input: CopilotEvalCaseReplayInput): Promise<CopilotEvalCaseReplayResult> {
    await enforceCopilotExpensiveOperation(this.dependencies, input, "replay_eval_case");

    const evalCase = await this.dependencies.cases.findCase(input.workspaceId, input.caseId);
    if (!evalCase) {
      throw notFound("Eval case not found");
    }

    const { overrides, directivesExcluded } = await this.resolveDirectiveExclusion(
      input.workspaceId,
      evalCase.sourceAgentId,
      evalCase.snapshotAuthoredDirectives,
      input.overrides,
    );

    const { run } = await withCopilotSpendRefusals(() => this.dependencies.runs.execute({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      snapshotId: evalCase.snapshotId,
      caseId: evalCase.id,
      mode: "full_assistant",
      overrides,
      attachToCase: false,
    }));

    // Recorded from the run the replay just wrote, not from anything the assistant reports, so a
    // proposal that cites this measurement cites what actually happened.
    const evidenceId = evalCase.sourceAgentId === null || evalCase.snapshotCapturedAt === null ? null : (await this.dependencies.evidence.record({
      workspaceId: input.workspaceId,
      operatorUserId: input.operatorUserId,
      conversationId: input.copilotConversationId,
      agentId: evalCase.sourceAgentId,
      caseId: evalCase.id,
      caseName: evalCase.name,
      runId: run.id,
      // The capture point, not the agent's version now: the replay ran against the configuration
      // frozen then, so recording today's version would call a measurement of an outdated
      // baseline fresh.
      baselineCapturedAt: evalCase.snapshotCapturedAt,
      recordedStatus: evalCase.status,
      verdict: run.observedOutput.error ? "error" : run.status,
      overrides: overrides ?? {},
      directivesExcluded,
    })).id;

    return {
      caseId: evalCase.id,
      name: evalCase.name,
      evidenceId,
      // A case with no assertions aggregates to "recorded", the eval module's word for "nothing
      // scored". A turn that never produced an answer is not unscored, and a freshly captured
      // case has no assertions yet, so capture-then-replay hits this on any model failure.
      verdict: run.observedOutput.error ? "error" : run.status,
      recordedStatus: evalCase.status,
      assertionCount: evalCase.assertions.length,
      answer: run.observedOutput.answer ?? null,
      groundingVerdict: run.observedOutput.groundingVerdict ?? null,
      groundingDiagnostics: run.observedOutput.groundingDiagnostics ?? null,
      assertionVerdicts: run.assertionVerdicts,
      model: {
        provider: run.resolvedConfig.modelProvider ?? null,
        id: run.resolvedConfig.modelId ?? null,
      },
      error: run.observedOutput.error?.message ?? null,
    };
  }

  /**
   * Turns `excludedDirectiveIds` into the concrete directive set the run actually uses. The case's
   * recorded verdict describes the snapshot it captured, not the source agent's directives as they
   * stand today, so the replayed set is always the *snapshot's* directives minus the excluded
   * one(s) — never the live agent's, which may have gained or lost directives unrelated to this
   * exclusion since capture. Live directives are read only to resolve which snapshot entry an id
   * means (by name — canonical serialization never carries an id) and to confirm that entry still
   * matches what the snapshot captured; a rename, edit, or an id absent from the snapshot refuses
   * the replay rather than silently measure the wrong configuration.
   * `authoredDirectives` is a freeform, model-authored array that never carries a directive's real
   * id, so it cannot back a removal claim; `excludedDirectiveIds` is the only seam that can,
   * precisely because the server — not the model — decides what it resolves to.
   * Returns the input overrides unchanged when no exclusion was requested.
   */
  private async resolveDirectiveExclusion(
    workspaceId: string,
    sourceAgentId: string | null,
    snapshotAuthoredDirectives: ReadonlyArray<Record<string, unknown>>,
    overrides: CopilotEvalCaseReplayOverrides | undefined,
  ): Promise<ResolvedDirectiveExclusion> {
    const excludedDirectiveIds = overrides?.agentConfigOverride?.excludedDirectiveIds;
    if (!excludedDirectiveIds || excludedDirectiveIds.length === 0) {
      return { overrides, directivesExcluded: [] };
    }
    if (overrides?.agentConfigOverride?.authoredDirectives) {
      throw badRequest("excludedDirectiveIds cannot be combined with an authoredDirectives override in the same replay");
    }
    if (!sourceAgentId) {
      throw badRequest("This case has no source agent, so a directive exclusion cannot be resolved");
    }

    const liveDirectives = await this.dependencies.agentDirectives.listDirectives(workspaceId, sourceAgentId);
    const liveById = new Map(liveDirectives.map((directive) => [directive.id, directive]));
    const unknownIds = excludedDirectiveIds.filter((id) => !liveById.has(id));
    if (unknownIds.length > 0) {
      throw badRequest(`Replay cannot exclude directive id(s) not on the source agent: ${unknownIds.join(", ")}`);
    }

    const snapshotByName = new Map<string, Record<string, unknown>>();
    for (const directive of snapshotAuthoredDirectives) {
      const name = readDirectiveName(directive);
      if (name) {
        snapshotByName.set(name, directive);
      }
    }

    const excludedNames = new Set<string>();
    for (const id of excludedDirectiveIds) {
      const live = liveById.get(id)!;
      const name = readDirectiveName(live.config);
      const snapshotDirective = name ? snapshotByName.get(name) : undefined;
      if (!name || !snapshotDirective) {
        throw badRequest(
          `Replay cannot exclude directive ${id}: it is not present in this case's captured snapshot, so its removal cannot be measured against it`,
        );
      }
      if (!isDeepStrictEqual(withDirectiveDefaults(live.config), withDirectiveDefaults(snapshotDirective))) {
        throw badRequest(
          `Replay cannot exclude directive "${name}": it has changed since this case's snapshot was captured, so this replay cannot honestly attribute a result to removing it`,
        );
      }
      excludedNames.add(name);
    }

    return {
      overrides: {
        ...overrides,
        agentConfigOverride: {
          ...overrides?.agentConfigOverride,
          excludedDirectiveIds: undefined,
          authoredDirectives: snapshotAuthoredDirectives.filter((directive) => {
            const name = readDirectiveName(directive);
            return !name || !excludedNames.has(name);
          }),
        },
      },
      directivesExcluded: excludedDirectiveIds,
    };
  }
}
