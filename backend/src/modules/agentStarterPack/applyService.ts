import { createHash, randomUUID } from "node:crypto";

import { canonicalJson } from "../../shared/domain/canonicalJson.js";
import { AppError } from "../../shared/domain/errors.js";
import {
  pendingDirectiveId,
  type AuthoredDirectiveInput,
  type DirectiveCoherenceAssessment,
  type DirectiveCoherenceCandidate,
} from "../agents/public.js";
import type { RoutineDefinition, RoutineDefinitionDraftInput } from "../routines/public.js";
import {
  starterPackApplyResultSchema,
  type StarterPackAppliedItem,
  type StarterPackApplyItem,
  type StarterPackApplyRequest,
  type StarterPackApplyResponse,
  type StarterPackApplyResult,
  type StarterPackCoherenceVerdict,
} from "./contracts.js";

/**
 * Everything an apply does to storage, bound to one database transaction that holds the agent's
 * draft lock. The directive and routine writes go through the owning domain services, built on
 * that transaction; nothing here writes their tables directly. Nothing here calls a model.
 */
export interface StarterPackApplyTransaction {
  /** Directive names already on the agent. Throws 404 when the agent is not in the workspace. */
  listDirectiveNames(): Promise<string[]>;
  routineNameTaken(name: string): Promise<boolean>;
  /** The coherence context token for these candidates as the agent stands inside this transaction. */
  coherenceContextToken(candidates: ReadonlyArray<DirectiveCoherenceCandidate>): Promise<string>;
  createDirective(input: AuthoredDirectiveInput, assessedCoherence: StarterPackCoherenceVerdict): Promise<{ id: string; name: string }>;
  createRoutine(input: RoutineDefinitionDraftInput): Promise<RoutineDefinition>;
  findApply(idempotencyKey: string): Promise<{ requestFingerprint: string; result: unknown } | null>;
  recordApply(input: {
    id: string;
    idempotencyKey: string;
    requestFingerprint: string;
    result: StarterPackApplyResult;
    actorAccountId: string | null;
  }): Promise<void>;
}

export interface StarterPackApplyUnitOfWork {
  /**
   * Runs `work` in one transaction that first takes the agent's draft lock, the lock every
   * directive and routine writer for that agent takes. Commits when `work` resolves; rolls
   * everything back when it throws.
   */
  run<T>(workspaceId: string, agentId: string, work: (transaction: StarterPackApplyTransaction) => Promise<T>): Promise<T>;
}

interface StarterPackApplyServiceOptions {
  unitOfWork: StarterPackApplyUnitOfWork;
  /** Reads a committed apply record without a transaction or lock, to replay before any model call. */
  findCompletedApply(workspaceId: string, agentId: string, idempotencyKey: string): Promise<{ requestFingerprint: string; result: unknown } | null>;
  /** The directive coherence check, run outside any transaction and lock. */
  assessCoherence(
    workspaceId: string,
    agentId: string,
    candidates: ReadonlyArray<DirectiveCoherenceCandidate>,
  ): Promise<DirectiveCoherenceAssessment>;
  /**
   * The routine owner's best-effort follow-ups (trigger embedding, authoring audit), which use
   * their own connections and so must run only after the routine is committed.
   */
  afterRoutineCommitted(workspaceId: string, agentId: string, routine: RoutineDefinition): Promise<void>;
  audit?: { record(event: { accountId?: string | null; workspaceId?: string | null; eventType: string; eventStatus: "success" | "failure"; metadata?: Record<string, unknown> }): Promise<void> };
  logger?: { warn(bindings: Record<string, unknown>, message: string): void };
}

interface StarterPackApplyActor {
  accountId: string | null;
}

/** An agent edited between assessment and write is reassessed at most this many times in total. */
const MAX_COHERENCE_ASSESSMENTS = 3;

export const starterPackRequestFingerprint = (items: readonly StarterPackApplyItem[]): string =>
  createHash("sha256").update(canonicalJson(items)).digest("hex");

const itemName = (item: StarterPackApplyItem): string =>
  item.kind === "directive" ? item.directive.name : item.routine.name;

const nameConflictError = (items: StarterPackApplyItem[]): AppError =>
  new AppError(
    409,
    "starter_pack_name_conflict",
    "Some selected items have names already used on this agent. Nothing was created; rename or deselect them and apply again.",
    { items: items.map((item) => ({ itemKey: item.itemKey, kind: item.kind, name: itemName(item) })) },
  );

const idempotencyKeyReusedError = (): AppError =>
  new AppError(
    409,
    "idempotency_key_reused",
    "This idempotency key was already used to apply different items. Use a new key for a different selection.",
  );

const agentChangedError = (): AppError =>
  new AppError(
    409,
    "starter_pack_agent_changed",
    "The agent kept changing while its directives were being checked. Nothing was created; apply again with the same key.",
  );

/** Replaces each reference to a not-yet-saved pack directive with the id it was saved under. */
const resolvePendingReferences = (
  verdict: StarterPackCoherenceVerdict,
  savedIds: ReadonlyMap<string, string>,
): StarterPackCoherenceVerdict => ({
  ...verdict,
  conflicts: verdict.conflicts.map((conflict) => {
    const savedId = conflict.directiveId === undefined ? undefined : savedIds.get(conflict.directiveId);
    return savedId === undefined ? conflict : { ...conflict, directiveId: savedId };
  }),
});

type ApplyOutcome =
  | { kind: "replayed"; result: StarterPackApplyResult }
  | { kind: "applied"; result: StarterPackApplyResult; routine: RoutineDefinition | null }
  | { kind: "context_changed" };

/**
 * Applies a reviewed starter pack: creates exactly the selected directives and routine, all or
 * nothing, and never touches anything that already exists. Directive coherence model calls run
 * before the transaction, never while it holds the agent's lock.
 */
export class StarterPackApplyService {
  constructor(private readonly options: StarterPackApplyServiceOptions) {}

  async apply(
    workspaceId: string,
    agentId: string,
    actor: StarterPackApplyActor,
    request: StarterPackApplyRequest,
  ): Promise<StarterPackApplyResponse> {
    const requestFingerprint = starterPackRequestFingerprint(request.items);

    // A request that already completed is answered before any model call. The transaction checks
    // again under the lock, because another request can complete in between.
    const completed = await this.options.findCompletedApply(workspaceId, agentId, request.idempotencyKey);
    if (completed) {
      return { ...this.replay(completed, requestFingerprint), replayed: true };
    }

    const candidates: DirectiveCoherenceCandidate[] = request.items.flatMap((item) =>
      item.kind === "directive" ? [{ ref: item.itemKey, input: item.directive }] : []);

    for (let attempt = 1; attempt <= MAX_COHERENCE_ASSESSMENTS; attempt += 1) {
      const assessment = await this.options.assessCoherence(workspaceId, agentId, candidates);
      const outcome = await this.options.unitOfWork.run(workspaceId, agentId, (transaction) =>
        this.applyInTransaction(transaction, request, requestFingerprint, actor, candidates, assessment));

      if (outcome.kind === "context_changed") {
        // Nothing was written: the token is compared before the first write.
        this.options.logger?.warn({ workspaceId, agentId, attempt }, "starter_pack_coherence_context_changed");
        continue;
      }
      if (outcome.kind === "applied") {
        await this.afterCommit(workspaceId, agentId, actor, outcome.result, outcome.routine);
      }
      return { ...outcome.result, replayed: outcome.kind === "replayed" };
    }
    throw agentChangedError();
  }

  private replay(
    record: { requestFingerprint: string; result: unknown },
    requestFingerprint: string,
  ): StarterPackApplyResult {
    if (record.requestFingerprint !== requestFingerprint) {
      throw idempotencyKeyReusedError();
    }
    return starterPackApplyResultSchema.parse(record.result);
  }

  private async applyInTransaction(
    transaction: StarterPackApplyTransaction,
    request: StarterPackApplyRequest,
    requestFingerprint: string,
    actor: StarterPackApplyActor,
    candidates: ReadonlyArray<DirectiveCoherenceCandidate>,
    assessment: DirectiveCoherenceAssessment,
  ): Promise<ApplyOutcome> {
    // Read under the agent lock: the 404 check, the replay check, the name checks, and the
    // coherence context below see committed state no other writer for this agent can change
    // until this transaction ends.
    const directiveNames = new Set(await transaction.listDirectiveNames());

    const previous = await transaction.findApply(request.idempotencyKey);
    if (previous) {
      return { kind: "replayed", result: this.replay(previous, requestFingerprint) };
    }

    const clashing: StarterPackApplyItem[] = [];
    for (const item of request.items) {
      const taken = item.kind === "directive"
        ? directiveNames.has(item.directive.name)
        : await transaction.routineNameTaken(item.routine.name);
      if (taken) clashing.push(item);
    }
    if (clashing.length > 0) {
      throw nameConflictError(clashing);
    }

    // The verdicts hold only if every input the checker read is unchanged. This runs whether or
    // not the model answered, so a fail-open verdict is never kept for an agent that changed.
    if (await transaction.coherenceContextToken(candidates) !== assessment.contextToken) {
      return { kind: "context_changed" };
    }

    const verdicts = new Map(assessment.verdicts.map((entry) => [entry.ref, entry.verdict]));
    const verdictFor = (itemKey: string): StarterPackCoherenceVerdict => {
      const verdict = verdicts.get(itemKey);
      if (!verdict) {
        throw new Error(`Coherence assessment has no verdict for item ${itemKey}`);
      }
      return verdict;
    };
    const savedIds = new Map<string, string>();
    const saved: Array<{ item: StarterPackApplyItem; id: string; name: string }> = [];
    let routine: RoutineDefinition | null = null;
    for (const item of request.items) {
      if (item.kind === "directive") {
        const directive = await transaction.createDirective(item.directive, verdictFor(item.itemKey));
        savedIds.set(pendingDirectiveId(item.itemKey), directive.id);
        saved.push({ item, id: directive.id, name: directive.name });
      } else {
        routine = await transaction.createRoutine(item.routine);
        saved.push({ item, id: routine.id, name: routine.name });
      }
    }

    // Built after every directive is saved, so a conflict with a later-listed pack directive
    // also points at its saved id.
    const items: StarterPackAppliedItem[] = saved.map(({ item, id, name }) =>
      item.kind === "directive"
        ? { itemKey: item.itemKey, kind: "directive", id, name, coherence: resolvePendingReferences(verdictFor(item.itemKey), savedIds) }
        : { itemKey: item.itemKey, kind: "routine", id, name });
    const result: StarterPackApplyResult = { applyId: randomUUID(), items };
    await transaction.recordApply({
      id: result.applyId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      result,
      actorAccountId: actor.accountId,
    });
    return { kind: "applied", result, routine };
  }

  private async afterCommit(
    workspaceId: string,
    agentId: string,
    actor: StarterPackApplyActor,
    result: StarterPackApplyResult,
    routine: RoutineDefinition | null,
  ): Promise<void> {
    if (routine) {
      await this.options.afterRoutineCommitted(workspaceId, agentId, routine).catch((error: unknown) => {
        this.options.logger?.warn({ workspaceId, agentId, routineId: routine.id, err: error instanceof Error ? error.name : "unknown" }, "starter_pack_routine_follow_up_failed");
      });
    }
    await this.options.audit?.record({
      accountId: actor.accountId,
      workspaceId,
      eventType: "agent_starter_pack.apply",
      eventStatus: "success",
      metadata: {
        agentId,
        applyId: result.applyId,
        directiveCount: result.items.filter((item) => item.kind === "directive").length,
        routineCount: result.items.filter((item) => item.kind === "routine").length,
      },
    }).catch(() => undefined);
  }
}
