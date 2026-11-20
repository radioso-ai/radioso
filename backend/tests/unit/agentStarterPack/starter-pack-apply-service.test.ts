import { describe, expect, it, vi } from "vitest";

import {
  StarterPackApplyService,
  starterPackApplyRequestSchema,
  starterPackRequestFingerprint,
  type StarterPackApplyRequest,
  type StarterPackApplyTransaction,
  type StarterPackApplyUnitOfWork,
} from "../../../src/modules/agentStarterPack/public.js";
import { pendingDirectiveId, type DirectiveCoherenceCandidate } from "../../../src/modules/agents/public.js";
import type { RoutineDefinition } from "../../../src/modules/routines/public.js";
import { notFound } from "../../../src/shared/domain/errors.js";

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

const directiveItem = (itemKey: string, name: string) =>
  ({ itemKey, kind: "directive", directive: { name, condition: { kind: "always" }, action: `Follow ${name}.` } });
const routineItem = (itemKey: string, name: string) => ({ itemKey, kind: "routine", routine: routineDraft(name) });

const coherent = { coherent: true, conflicts: [], rationale: "Coherent." };

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
  const state = { insideTransaction: false, transactions: 0, failOnCreate: undefined as string | undefined };
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
          return { id: `routine-id-${nextId++}`, name: input.name } as RoutineDefinition;
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

  return { committed, state, unitOfWork, assessCoherence, findCompletedApply };
};

const createService = (store: ReturnType<typeof createStore>) => {
  const afterRoutineCommitted = vi.fn(async () => undefined);
  const audit = { record: vi.fn(async () => undefined) };
  const logger = { warn: vi.fn() };
  const service = new StarterPackApplyService({
    unitOfWork: store.unitOfWork,
    findCompletedApply: store.findCompletedApply,
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
    // Simulate the early check racing ahead of the other request's commit.
    store.findCompletedApply.mockResolvedValueOnce(null);

    const second = await service.apply(workspaceId, agentId, { accountId: null }, body);

    expect(second).toEqual({ ...first, replayed: true });
    expect(store.committed.directives).toEqual(["confirm-details"]);
  });

  it("reassesses when the agent changed after assessment, writing nothing on the stale attempt", async () => {
    const store = createStore();
    const { service, logger } = createService(store);
    store.assessCoherence.mockImplementationOnce(async (ws, agent, candidates) => {
      const assessment = await store.assessCoherence.getMockImplementation()!(ws, agent, candidates);
      store.committed.contextVersion += 1; // another writer edits the agent before the lock is taken
      return assessment;
    });

    const result = await service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "confirm-details")]));

    expect(result.replayed).toBe(false);
    expect(store.assessCoherence).toHaveBeenCalledTimes(2);
    expect(store.committed.directives).toEqual(["confirm-details"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }), "starter_pack_coherence_context_changed");
  });

  it("gives up after three assessments with a retryable 409, having written nothing", async () => {
    const store = createStore();
    const { service } = createService(store);
    const real = store.assessCoherence.getMockImplementation()!;
    store.assessCoherence.mockImplementation(async (ws, agent, candidates) => {
      const assessment = await real(ws, agent, candidates);
      store.committed.contextVersion += 1;
      return assessment;
    });

    await expect(service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "confirm-details")])))
      .rejects.toMatchObject({ statusCode: 409, code: "starter_pack_agent_changed" });
    expect(store.assessCoherence).toHaveBeenCalledTimes(3);
    expect(store.committed.directives).toEqual([]);
    expect(store.committed.applies.size).toBe(0);
  });

  it("checks the context token even when the verdict was the fail-open fallback", async () => {
    const store = createStore();
    const { service } = createService(store);
    const real = store.assessCoherence.getMockImplementation()!;
    let calls = 0;
    store.assessCoherence.mockImplementation(async (ws, agent, candidates) => {
      const assessment = await real(ws, agent, candidates);
      calls += 1;
      if (calls === 1) store.committed.contextVersion += 1;
      return {
        ...assessment,
        verdicts: assessment.verdicts.map((entry) => ({ ...entry, verdict: { coherent: true, conflicts: [], rationale: "Coherence check unavailable." } })),
      };
    });

    await service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "confirm-details")]));

    expect(store.assessCoherence).toHaveBeenCalledTimes(2);
  });

  it("does not reassess when the only clash is a taken name", async () => {
    const store = createStore({ directives: ["confirm-details"] });
    const { service } = createService(store);

    await expect(service.apply(workspaceId, agentId, { accountId: null }, request([directiveItem("directive-1", "confirm-details")])))
      .rejects.toMatchObject({ code: "starter_pack_name_conflict" });
    expect(store.assessCoherence).toHaveBeenCalledTimes(1);
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
