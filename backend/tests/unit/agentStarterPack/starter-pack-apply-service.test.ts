import { describe, expect, it, vi } from "vitest";

import {
  StarterPackApplyService,
  starterPackApplyRequestSchema,
  starterPackRequestFingerprint,
  type StarterPackApplyRequest,
  type StarterPackApplyTransaction,
  type StarterPackApplyUnitOfWork,
  type StarterPackNameReads,
} from "../../../src/modules/agentStarterPack/public.js";
import { pendingDirectiveId, type DirectiveCoherenceCandidate } from "../../../src/modules/agents/public.js";
import type { RoutineDefinition, RoutineValidationResult } from "../../../src/modules/routines/public.js";
import { defaultAnswerDirectives } from "../../../src/modules/directives/public.js";
import { AppError, notFound } from "../../../src/shared/domain/errors.js";

const workspaceId = "workspace-1";
const agentId = "22222222-2222-4222-8222-222222222222";

const routineDraft = (name: string) => ({
  enabled: true,
  name,
  activation: { triggerDescription: "The visitor wants an appointment.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [],
  steps: [{ stableStepId: "step_ask", kind: "chat", instruction: "Ask for a date.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "step_ask", toRef: "terminal_complete", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
  terminals: [{ stableStepId: "terminal_complete", kind: "complete", instruction: "Confirm.", ordinal: 1 }],
});

const request = (items: unknown[], idempotencyKey = "apply-key-0001"): StarterPackApplyRequest =>
  starterPackApplyRequestSchema.parse({ idempotencyKey, items });

const directiveItem = (itemKey: string, name: string, excludes?: string[]) =>
  ({ itemKey, kind: "directive", directive: { name, condition: { kind: "always" }, action: `Follow ${name}.`, ...(excludes ? { excludes } : {}) } });
const routineItem = (itemKey: string, name: string) => ({ itemKey, kind: "routine", routine: routineDraft(name) });

const coherent = { coherent: true, conflicts: [], rationale: "Coherent." };
const unavailable = { coherent: true, conflicts: [], rationale: "Coherence check unavailable." };
const validRoutine = { ok: true, diagnostics: [] };

/**
 * A unit of work over in-memory state that behaves like a transaction: writes are staged and
 * become visible only when the work resolves, and are dropped when it throws. `contextVersion`
 * stands for everything the coherence check reads; a test bumps it to simulate another writer.
 */
const createStore = (initial: { directives?: string[]; routines?: string[]; agentExists?: boolean } = {}) => {
  const committed = {
    directives: [...(initial.directives ?? [])],
    routines: [...(initial.routines ?? [])],
    applies: new Map<string, { requestFingerprint: string; result: unknown }>(),
    contextVersion: 0,
  };
  const state = {
    insideTransaction: false,
    transactions: 0,
    failOnCreate: undefined as string | undefined,
    routineValidation: validRoutine as { ok: boolean; diagnostics: Array<{ code: string; location: string; message: string }> },
  };
  let nextId = 1;
  const tokenFor = (candidates: ReadonlyArray<DirectiveCoherenceCandidate>) =>
    `v${committed.contextVersion}:${committed.directives.join(",")}:${candidates.map((candidate) => candidate.ref).join(",")}`;

  const unitOfWork: StarterPackApplyUnitOfWork = {
    async run(_workspaceId, _agentId, work) {
      state.insideTransaction = true;
      state.transactions += 1;
      const staged = { directives: [...committed.directives], routines: [...committed.routines], applies: new Map(committed.applies) };
      const assessedVerdicts: unknown[] = [];
      const transaction: StarterPackApplyTransaction = {
        listDirectiveNames: async () => {
          if (initial.agentExists === false) throw notFound("Agent not found");
          return [...staged.directives];
        },
        routineNameTaken: async (name) => staged.routines.includes(name),
        coherenceContextToken: async (candidates) => tokenFor(candidates),
        createDirective: async (input, assessedCoherence) => {
          staged.directives.push(input.name);
          assessedVerdicts.push(assessedCoherence);
          if (state.failOnCreate === input.name) throw new Error("injected failure");
          return { id: `directive-id-${nextId++}`, name: input.name };
        },
        createRoutine: async (input) => {
          staged.routines.push(input.name);
          if (state.failOnCreate === input.name) throw new Error("injected failure");
          return {
            routine: { id: `routine-id-${nextId++}`, name: input.name } as RoutineDefinition,
            validation: state.routineValidation as RoutineValidationResult,
          };
        },
        findApply: async (key) => staged.applies.get(key) ?? null,
        recordApply: async (record) => {
          staged.applies.set(record.idempotencyKey, { requestFingerprint: record.requestFingerprint, result: record.result });
        },
      };
      try {
        const result = await work(transaction);
        Object.assign(committed, staged);
        return result;
      } finally {
        state.insideTransaction = false;
      }
    },
  };

  /** The model-backed check. It fails the test if it ever runs inside the transaction. */
  const assessCoherence = vi.fn(async (_ws: string, _agent: string, candidates: ReadonlyArray<DirectiveCoherenceCandidate>) => {
    if (state.insideTransaction) throw new Error("coherence was assessed inside the transaction");
    return {
      verdicts: candidates.map((candidate, index) => ({
        ref: candidate.ref,
        verdict: index === 0 || candidates.length < 2
          ? coherent
          : { coherent: false, conflicts: [{ directiveId: pendingDirectiveId(candidates[0]?.ref ?? ""), directiveName: "earlier", reason: "Overlaps." }], rationale: "Conflicts with an earlier pack directive." },
      })),
      contextToken: tokenFor(candidates),
    };
  });
  const findCompletedApply = vi.fn(async (_ws: string, _agent: string, key: string) => committed.applies.get(key) ?? null);
  /** The same name reads as the transaction's, on committed state, before any model call. */
  const readNames = vi.fn((): StarterPackNameReads => ({
    listDirectiveNames: async () => {
      if (initial.agentExists === false) throw notFound("Agent not found");
      return [...committed.directives];
    },
    routineNameTaken: async (name) => committed.routines.includes(name),
  }));

  return { committed, state, unitOfWork, assessCoherence, findCompletedApply, readNames };
};

const createService = (store: ReturnType<typeof createStore>) => {
  const afterRoutineCommitted = vi.fn(async () => undefined);
  const audit = { record: vi.fn(async () => undefined) };
  const logger = { warn: vi.fn() };
  const service = new StarterPackApplyService({
    unitOfWork: store.unitOfWork,
    findCompletedApply: store.findCompletedApply,
    readNames: store.readNames,
    assessCoherence: store.assessCoherence,
    afterRoutineCommitted,
    audit,
    logger,
  });
  return { service, afterRoutineCommitted, audit, logger };
};

describe("StarterPackApplyService", () => {
  it("creates every selected item and returns them in request order", async () => {
    const store = createStore();
    const { service, afterRoutineCommitted, audit } = createService(store);

    const result = await service.apply(workspaceId, agentId, { accountId: "account-1" }, request([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis"),
      routineItem("routine-1", "book-appointment"),
    ]));

    expect(result.replayed).toBe(false);
    expect(result.items.map(({ itemKey, kind, name }) => ({ itemKey, kind, name }))).toEqual([
      { itemKey: "directive-1", kind: "directive", name: "confirm-details" },
      { itemKey: "directive-2", kind: "directive", name: "no-diagnosis" },
      { itemKey: "routine-1", kind: "routine", name: "book-appointment" },
    ]);
    expect(result.items[2]).toMatchObject({ kind: "routine", validation: validRoutine });
    expect(store.committed.directives).toEqual(["confirm-details", "no-diagnosis"]);
    expect(store.committed.routines).toEqual(["book-appointment"]);
    expect(afterRoutineCommitted).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "agent_starter_pack.apply",
      accountId: "account-1",
      metadata: expect.objectContaining({ agentId, directiveCount: 2, routineCount: 1 }),
    }));
  });

  it("creates only the selected items, with or without a routine", async () => {
    const store = createStore();
    const { service, afterRoutineCommitted } = createService(store);

    await service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-2", "no-diagnosis")]));

    expect(store.committed.directives).toEqual(["no-diagnosis"]);
    expect(store.committed.routines).toEqual([]);
    expect(afterRoutineCommitted).not.toHaveBeenCalled();
  });

  it("refuses a reused key with a different selection", async () => {
    const store = createStore();
    const { service } = createService(store);
    await service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "confirm-details")]));

    await expect(service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "other-name")])))
      .rejects.toMatchObject({ statusCode: 409, code: "idempotency_key_reused" });
    expect(store.committed.directives).toEqual(["confirm-details"]);
  });

  it("reports every clashing item and creates nothing when names are taken", async () => {
    const store = createStore({ directives: ["no-diagnosis"], routines: ["book-appointment"] });
    const { service, audit } = createService(store);

    await expect(service.apply(workspaceId, agentId, { accountId: null }, request([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis"),
      routineItem("routine-1", "book-appointment"),
    ]))).rejects.toMatchObject({
      statusCode: 409,
      code: "starter_pack_name_conflict",
      details: {
        items: [
          { itemKey: "directive-2", kind: "directive", name: "no-diagnosis" },
          { itemKey: "routine-1", kind: "routine", name: "book-appointment" },
        ],
      },
    });
    expect(store.committed.directives).toEqual(["no-diagnosis"]);
    expect(store.committed.routines).toEqual(["book-appointment"]);
    expect(store.committed.applies.size).toBe(0);
    expect(audit.record).not.toHaveBeenCalled();
    // Refused on cheap reads: no coherence model call and no transaction.
    expect(store.assessCoherence).not.toHaveBeenCalled();
    expect(store.state.transactions).toBe(0);
  });

  it("checks the names again under the lock, refusing one taken while coherence was assessed", async () => {
    const store = createStore();
    const { service } = createService(store);
    const real = store.assessCoherence.getMockImplementation()!;
    store.assessCoherence.mockImplementationOnce(async (ws, agent, candidates) => {
      const assessment = await real(ws, agent, candidates);
      store.committed.routines.push("book-appointment"); // another writer takes the name meanwhile
      return assessment;
    });

    await expect(service.apply(workspaceId, agentId, { accountId: null }, request([
      directiveItem("directive-1", "confirm-details"),
      routineItem("routine-1", "book-appointment"),
    ]))).rejects.toMatchObject({ statusCode: 409, code: "starter_pack_name_conflict" });
    expect(store.committed.directives).toEqual([]);
  });

  it("returns the routine's validation result, so a routine that cannot serve is visible at once", async () => {
    const store = createStore();
    const diagnostic = { code: "unknown_skill", location: "steps[0].toolRef", message: "The step names a skill this agent does not have." };
    store.state.routineValidation = { ok: false, diagnostics: [diagnostic] };
    const { service } = createService(store);

    const result = await service.apply(workspaceId, agentId, { accountId: null }, request([routineItem("routine-1", "book-appointment")]));
    const replay = await service.apply(workspaceId, agentId, { accountId: null }, request([routineItem("routine-1", "book-appointment")]));

    expect(result.items[0]).toEqual({ itemKey: "routine-1", kind: "routine", id: expect.any(String), name: "book-appointment", validation: { ok: false, diagnostics: [diagnostic] } });
    expect(replay.items).toEqual(result.items);
  });

  it("propagates a failure from the unit of work, leaving nothing committed and nothing recorded", async () => {
    const store = createStore();
    store.state.failOnCreate = "book-appointment";
    const { service, afterRoutineCommitted, audit } = createService(store);

    await expect(service.apply(workspaceId, agentId, { accountId: null }, request([
      directiveItem("directive-1", "confirm-details"),
      routineItem("routine-1", "book-appointment"),
    ]))).rejects.toThrow("injected failure");

    expect(store.committed).toMatchObject({ directives: [], routines: [] });
    expect(store.committed.applies.size).toBe(0);
    expect(afterRoutineCommitted).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("returns 404 for an agent outside the workspace", async () => {
    const { service } = createService(createStore({ agentExists: false }));

    await expect(service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "x-rule")])))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("still succeeds when a post-commit follow-up or the audit fails", async () => {
    const store = createStore();
    const service = new StarterPackApplyService({
      unitOfWork: store.unitOfWork,
      findCompletedApply: store.findCompletedApply,
      readNames: store.readNames,
      assessCoherence: store.assessCoherence,
      afterRoutineCommitted: async () => { throw new Error("embedding provider down"); },
      audit: { record: async () => { throw new Error("audit store down"); } },
      logger: { warn: vi.fn() },
    });

    const result = await service.apply(workspaceId, agentId, { accountId: null }, request([routineItem("routine-1", "book-appointment")]));

    expect(result.replayed).toBe(false);
    expect(store.committed.routines).toEqual(["book-appointment"]);
  });
});

describe("StarterPackApplyService coherence outside the transaction", () => {
  it("assesses coherence before the transaction, never inside it", async () => {
    const store = createStore();
    const { service } = createService(store);

    await service.apply(workspaceId, agentId, { accountId: null }, request([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis"),
    ]));

    // The fake assessor throws if called while the transaction is open, so reaching here proves it.
    expect(store.assessCoherence).toHaveBeenCalledTimes(1);
    expect(store.assessCoherence).toHaveBeenCalledWith(workspaceId, agentId, [
      { ref: "directive-1", input: expect.objectContaining({ name: "confirm-details" }) },
      { ref: "directive-2", input: expect.objectContaining({ name: "no-diagnosis" }) },
    ]);
  });

  it("returns each directive's verdict, resolving references to earlier pack directives to their saved ids", async () => {
    const store = createStore();
    const { service } = createService(store);

    const result = await service.apply(workspaceId, agentId, { accountId: null }, request([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis"),
      routineItem("routine-1", "book-appointment"),
    ]));

    const [first, second, routine] = result.items;
    expect(first).toMatchObject({ kind: "directive", coherence: coherent });
    expect(second).toMatchObject({
      kind: "directive",
      coherence: { coherent: false, conflicts: [{ directiveId: first?.id, reason: "Overlaps." }] },
    });
    expect(routine).not.toHaveProperty("coherence");
  });

  it("replays a completed request without any model call, and returns the stored verdicts", async () => {
    const store = createStore();
    const { service, audit } = createService(store);
    const body = request([directiveItem("directive-1", "confirm-details"), routineItem("routine-1", "book-appointment")]);

    const first = await service.apply(workspaceId, agentId, { accountId: null }, body);
    const second = await service.apply(workspaceId, agentId, { accountId: null }, body);

    expect(second).toEqual({ ...first, replayed: true });
    expect(store.assessCoherence).toHaveBeenCalledTimes(1);
    expect(store.state.transactions).toBe(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("runs beforeModelCalls just before assessing coherence, and not for a replay or a refused pack", async () => {
    const store = createStore({ directives: ["taken-name"] });
    const { service } = createService(store);
    const beforeModelCalls = vi.fn(async () => undefined);
    const body = request([directiveItem("directive-1", "confirm-details")]);

    await service.apply(workspaceId, agentId, { accountId: null }, body, { beforeModelCalls });
    expect(beforeModelCalls).toHaveBeenCalledTimes(1);
    expect(beforeModelCalls.mock.invocationCallOrder[0]).toBeLessThan(store.assessCoherence.mock.invocationCallOrder[0]);

    await service.apply(workspaceId, agentId, { accountId: null }, body, { beforeModelCalls });
    await expect(service.apply(workspaceId, agentId, { accountId: null }, { ...request([directiveItem("directive-1", "taken-name")]), idempotencyKey: "other-key-0001" }, { beforeModelCalls }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(beforeModelCalls).toHaveBeenCalledTimes(1);
  });

  it("stops before any model call or write when beforeModelCalls refuses", async () => {
    const store = createStore();
    const { service } = createService(store);
    const refusal = new AppError(429, "rate_limit_exceeded", "Too many requests");

    await expect(service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "confirm-details")]), { beforeModelCalls: async () => { throw refusal; } }))
      .rejects.toBe(refusal);
    expect(store.assessCoherence).not.toHaveBeenCalled();
    expect(store.state.transactions).toBe(0);
  });

  it("refuses a reused key before any model call", async () => {
    const store = createStore();
    const { service } = createService(store);
    await service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "confirm-details")]));

    await expect(service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "other-name")])))
      .rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(store.assessCoherence).toHaveBeenCalledTimes(1);
  });

  it("replays inside the lock when an identical request completed after the early check", async () => {
    const store = createStore();
    const { service } = createService(store);
    const body = request([directiveItem("directive-1", "confirm-details")]);
    const first = await service.apply(workspaceId, agentId, { accountId: null }, body);
    // Simulate the early reads racing ahead of the other request's commit: neither its names nor its record are visible yet.
    store.readNames.mockReturnValueOnce({ listDirectiveNames: async () => [], routineNameTaken: async () => false });
    store.findCompletedApply.mockResolvedValueOnce(null);

    const second = await service.apply(workspaceId, agentId, { accountId: null }, body);

    expect(second).toEqual({ ...first, replayed: true });
    expect(store.committed.directives).toEqual(["confirm-details"]);
  });

  it("saves every directive with the unavailable verdict when the agent changed after assessment, without assessing again", async () => {
    const store = createStore();
    const { service, logger } = createService(store);
    const real = store.assessCoherence.getMockImplementation()!;
    store.assessCoherence.mockImplementationOnce(async (ws, agent, candidates) => {
      const assessment = await real(ws, agent, candidates);
      store.committed.contextVersion += 1; // another writer edits the agent before the lock is taken
      return assessment;
    });

    const result = await service.apply(workspaceId, agentId, { accountId: null }, request([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis"),
    ]));

    expect(result.replayed).toBe(false);
    expect(store.assessCoherence).toHaveBeenCalledTimes(1);
    expect(store.state.transactions).toBe(1);
    expect(store.committed.directives).toEqual(["confirm-details", "no-diagnosis"]);
    expect(result.items.map((item) => item.kind === "directive" ? item.coherence : null)).toEqual([unavailable, unavailable]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, directiveCount: 2 },
      "starter_pack_coherence_context_changed",
    );
  });

  it("keeps the assessed verdicts when nothing the check read has changed", async () => {
    const store = createStore();
    const { service, logger } = createService(store);

    const result = await service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "confirm-details")]));

    expect(result.items[0]).toMatchObject({ coherence: coherent });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("StarterPackApplyService excludes within one pack", () => {
  it("refuses a directive that excludes one listed after it, before any model call, and says to list it first", async () => {
    const store = createStore();
    const { service } = createService(store);

    const failure = await service.apply(workspaceId, agentId, { accountId: null }, request([
      directiveItem("directive-1", "short-answers", ["detailed-answers"]),
      directiveItem("directive-2", "detailed-answers"),
    ])).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      statusCode: 400,
      details: { items: [{ itemKey: "directive-1", name: "short-answers", unknownExcludes: ["detailed-answers"] }] },
    });
    expect((failure as Error).message).toMatch(/first/u);
    expect(store.assessCoherence).not.toHaveBeenCalled();
    expect(store.committed.directives).toEqual([]);
  });

  it("accepts excludes that name an earlier pack directive, an existing directive, or a built-in one", async () => {
    const store = createStore({ directives: ["existing-rule"] });
    const { service } = createService(store);

    await service.apply(workspaceId, agentId, { accountId: null }, request([
      directiveItem("directive-1", "detailed-answers"),
      directiveItem("directive-2", "short-answers", ["detailed-answers", "existing-rule", defaultAnswerDirectives[0].name]),
    ]));

    expect(store.committed.directives).toEqual(["existing-rule", "detailed-answers", "short-answers"]);
  });

  it("refuses an excluded name that is nowhere on the agent or in the pack", async () => {
    const store = createStore();
    const { service } = createService(store);

    await expect(service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "short-answers", ["missing-rule"])])))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(store.assessCoherence).not.toHaveBeenCalled();
  });
});

describe("starterPackRequestFingerprint", () => {
  it("ignores object key order but not item order or content", () => {
    const items = request([directiveItem("directive-1", "confirm-details"), directiveItem("directive-2", "no-diagnosis")]).items;
    const reordered = items.map((item) => Object.fromEntries(Object.entries(item).reverse())) as typeof items;

    expect(starterPackRequestFingerprint(reordered)).toBe(starterPackRequestFingerprint(items));
    expect(starterPackRequestFingerprint([...items].reverse())).not.toBe(starterPackRequestFingerprint(items));
    expect(starterPackRequestFingerprint(items.slice(1))).not.toBe(starterPackRequestFingerprint(items));
  });
});
