import { createHash, randomUUID } from "node:crypto";

import { canonicalJson } from "../../shared/domain/canonicalContentHash.js";
import { AppError, badRequest } from "../../shared/domain/errors.js";
import {
  coherenceUnavailableVerdict,
  pendingDirectiveId,
  validateDirectiveReplacementNames,
  type AuthoredDirectiveInput,
  type DirectiveCoherenceAssessment,
  type DirectiveCoherenceCandidate,
} from "../agents/public.js";
import type { RoutineDefinition, RoutineDefinitionDraftInput, RoutineValidationResult } from "../routines/public.js";
import {
  starterPackApplyResultSchema,
  type StarterPackAppliedItem,
  type StarterPackApplyItem,
  type StarterPackApplyRequest,
  type StarterPackApplyResponse,
  type StarterPackApplyResult,
  type StarterPackCoherenceVerdict,
} from "./contracts.js";

/** The name reads apply checks a pack against: once before any model call, and again under the lock. */
export interface StarterPackNameReads {
  /** Directive names already on the agent. Throws 404 when the agent is not in the workspace. */
  listDirectiveNames(): Promise<string[]>;
  routineNameTaken(name: string): Promise<boolean>;
}

/**
 * Everything an apply does to storage, bound to one database transaction that holds the agent's
 * draft lock. The directive and routine writes go through the owning domain services, built on
 * that transaction; nothing here writes their tables directly. Nothing here calls a model.
 */
export interface StarterPackApplyTransaction extends StarterPackNameReads {
  /** The coherence context token for these candidates as the agent stands inside this transaction. */
  coherenceContextToken(candidates: ReadonlyArray<DirectiveCoherenceCandidate>): Promise<string>;
  createDirective(input: AuthoredDirectiveInput, assessedCoherence: StarterPackCoherenceVerdict): Promise<{ id: string; name: string }>;
  /** Creates the routine and returns it with its validation, as the routine authoring endpoints report it. */
  createRoutine(input: RoutineDefinitionDraftInput): Promise<{ routine: RoutineDefinition; validation: RoutineValidationResult }>;
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
  /** The transaction's name reads, on committed state and without the lock, for the checks made before any model call. */
  readNames(workspaceId: string, agentId: string): StarterPackNameReads;
  /** The directive coherence check, run outside any transaction and lock. */
  assessCoherence(
    workspaceId: string,
    agentId: string,
    candidates: ReadonlyArray<DirectiveCoherenceCandidate>,
  ): Promise<DirectiveCoherenceAssessment>;
  /**
   * The routine owner's best-effort follow-ups for a created routine (trigger embedding, authoring
   * audit), which use their own connections and so must run only after the routine is committed.
   */
  afterRoutineCommitted(workspaceId: string, agentId: string, routine: RoutineDefinition): Promise<void>;
  audit?: { record(event: { accountId?: string | null; workspaceId?: string | null; eventType: string; eventStatus: "success" | "failure"; metadata?: Record<string, unknown> }): Promise<void> };
  logger?: { warn(bindings: Record<string, unknown>, message: string): void };
}

interface StarterPackApplyActor {
  accountId: string | null;
}

interface StarterPackApplyRequestOptions {
  /**
   * Runs before the first model call, once the request is neither a replay nor refused for its
   * names or excludes. A caller spends its rate-limit budget here.
   */
  beforeModelCalls?: () => Promise<void>;
}

export const starterPackRequestFingerprint = (items: readonly StarterPackApplyItem[]): string =>
  createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(items)) as unknown)).digest("hex");

const itemName = (item: StarterPackApplyItem): string =>
  item.kind === "directive" ? item.directive.name : item.routine.name;

const nameConflictError = (items: StarterPackApplyItem[]): AppError =>
  new AppError(
    409,
    "starter_pack_name_conflict",
    "Some selected items have names already used on this agent. Nothing was created; rename or deselect them and apply again.",
    { items: items.map((item) => ({ itemKey: item.itemKey, kind: item.kind, name: itemName(item) })) },
  );

const unknownExcludesError = (items: Array<{ itemKey: string; name: string; unknownExcludes: string[] }>): AppError =>
  badRequest(
    "Some directives exclude a directive that is neither on this agent nor listed before them in this pack. List the excluded directive first, before the directive that excludes it, or remove it from excludes. Nothing was created.",
    { items },
  );

const idempotencyKeyReusedError = (): AppError =>
  new AppError(
    409,
    "idempotency_key_reused",
    "This idempotency key was already used to apply different items. Use a new key for a different selection.",
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
  | { kind: "applied"; result: StarterPackApplyResult; routine: RoutineDefinition | null };

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
    requestOptions: StarterPackApplyRequestOptions = {},
  ): Promise<StarterPackApplyResponse> {
    const requestFingerprint = starterPackRequestFingerprint(request.items);

    // Cheap reads first, so a request that replays, or that would be refused for its names or
    // excludes, costs no model call. The transaction repeats every one of them under the lock.
    const refusal = await this.refusalFor(this.options.readNames(workspaceId, agentId), request);
    // Read after the names: a request with this key that commits in between is replayed here,
    // not refused for the names it created itself.
    const completed = await this.options.findCompletedApply(workspaceId, agentId, request.idempotencyKey);
    if (completed) {
      return { ...this.replay(completed, requestFingerprint), replayed: true };
    }
    if (refusal) {
      throw refusal;
    }
    await requestOptions.beforeModelCalls?.();

    const candidates: DirectiveCoherenceCandidate[] = request.items.flatMap((item) =>
      item.kind === "directive" ? [{ ref: item.itemKey, input: item.directive }] : []);
    const assessment = await this.options.assessCoherence(workspaceId, agentId, candidates);
    const outcome = await this.options.unitOfWork.run(workspaceId, agentId, (transaction) =>
      this.applyInTransaction(transaction, { workspaceId, agentId, actor, request, requestFingerprint, candidates, assessment }));

    if (outcome.kind === "applied") {
      await this.afterCommit(workspaceId, agentId, actor, outcome.result, outcome.routine);
    }
    return { ...outcome.result, replayed: outcome.kind === "replayed" };
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

  /**
   * Why the agent, as `names` reads it, would refuse this pack: a name already taken (409), or an
   * `excludes` entry the directive service would reject when its directive is created (400).
   * Directives are created in request order, so a pack directive can only be excluded by one
   * listed after it.
   */
  private async refusalFor(names: StarterPackNameReads, request: StarterPackApplyRequest): Promise<AppError | null> {
    const directiveNames = await names.listDirectiveNames();
    const clashing: StarterPackApplyItem[] = [];
    for (const item of request.items) {
      const taken = item.kind === "directive"
        ? directiveNames.includes(item.directive.name)
        : await names.routineNameTaken(item.routine.name);
      if (taken) clashing.push(item);
    }
    if (clashing.length > 0) {
      return nameConflictError(clashing);
    }

    const available = directiveNames.map((name) => ({ name }));
    const unknownExcludes: Array<{ itemKey: string; name: string; unknownExcludes: string[] }> = [];
    for (const item of request.items) {
      if (item.kind !== "directive") continue;
      const { unknown } = validateDirectiveReplacementNames(item.directive.excludes, available);
      if (unknown.length > 0) {
        unknownExcludes.push({ itemKey: item.itemKey, name: item.directive.name, unknownExcludes: unknown });
      }
      available.push({ name: item.directive.name });
    }
    return unknownExcludes.length > 0 ? unknownExcludesError(unknownExcludes) : null;
  }

  private async applyInTransaction(
    transaction: StarterPackApplyTransaction,
    input: {
      workspaceId: string;
      agentId: string;
      actor: StarterPackApplyActor;
      request: StarterPackApplyRequest;
      requestFingerprint: string;
      candidates: ReadonlyArray<DirectiveCoherenceCandidate>;
      assessment: DirectiveCoherenceAssessment;
    },
  ): Promise<ApplyOutcome> {
    const { request, candidates, assessment } = input;
    // Read under the agent lock: the 404 check, the replay check, the name checks, and the
    // coherence context below see committed state no other writer for this agent can change
    // until this transaction ends.
    const refusal = await this.refusalFor(transaction, request);
    const previous = await transaction.findApply(request.idempotencyKey);
    if (previous) {
      return { kind: "replayed", result: this.replay(previous, input.requestFingerprint) };
    }
    if (refusal) {
      throw refusal;
    }

    // The verdicts hold only if every input the checker read is unchanged. If another writer
    // changed one in between, the verdicts are stale; the check is advisory, so the directives are
    // saved with the verdict a check that could not run gives, rather than assessed again.
    const contextUnchanged = await transaction.coherenceContextToken(candidates) === assessment.contextToken;
    if (!contextUnchanged) {
      this.options.logger?.warn(
        { workspaceId: input.workspaceId, agentId: input.agentId, directiveCount: candidates.length },
        "starter_pack_coherence_context_changed",
      );
    }
    const verdicts = new Map(assessment.verdicts.map((entry) => [entry.ref, entry.verdict]));
    const verdictFor = (itemKey: string): StarterPackCoherenceVerdict => {
      if (!contextUnchanged) {
        return coherenceUnavailableVerdict();
      }
      const verdict = verdicts.get(itemKey);
      if (!verdict) {
        throw new Error(`Coherence assessment has no verdict for item ${itemKey}`);
      }
      return verdict;
    };

    const savedIds = new Map<string, string>();
    const saved: Array<
      | { item: StarterPackApplyItem & { kind: "directive" }; id: string; name: string; coherence: StarterPackCoherenceVerdict }
      | { item: StarterPackApplyItem & { kind: "routine" }; id: string; name: string; validation: RoutineValidationResult }
    > = [];
    let routine: RoutineDefinition | null = null;
    for (const item of request.items) {
      if (item.kind === "directive") {
        const coherence = verdictFor(item.itemKey);
        const directive = await transaction.createDirective(item.directive, coherence);
        savedIds.set(pendingDirectiveId(item.itemKey), directive.id);
        saved.push({ item, id: directive.id, name: directive.name, coherence });
      } else {
        const created = await transaction.createRoutine(item.routine);
        routine = created.routine;
        saved.push({ item, id: created.routine.id, name: created.routine.name, validation: created.validation });
      }
    }

    // Built after every directive is saved, so a conflict with a later-listed pack directive
    // also points at its saved id.
    const items: StarterPackAppliedItem[] = saved.map((entry) =>
      "coherence" in entry
        ? { itemKey: entry.item.itemKey, kind: "directive", id: entry.id, name: entry.name, coherence: resolvePendingReferences(entry.coherence, savedIds) }
        : { itemKey: entry.item.itemKey, kind: "routine", id: entry.id, name: entry.name, validation: entry.validation });
    const result: StarterPackApplyResult = { applyId: randomUUID(), items };
    await transaction.recordApply({
      id: result.applyId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      result,
      actorAccountId: input.actor.accountId,
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
