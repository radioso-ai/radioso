import { describe, expect, it, vi } from "vitest";

import { WorkspaceSetupContext } from "../../../src/modules/operatorCopilot/context/workspaceSetup.js";
import { CopilotEmptyStateService } from "../../../src/modules/operatorCopilot/services/emptyStateService.js";
import type { CopilotWorkspaceSetupStatePort } from "../../../src/modules/operatorCopilot/tools/workspaceSetupState.js";

type Summary = Awaited<ReturnType<CopilotWorkspaceSetupStatePort["getSetupSignals"]>>;

const summary = (overrides: Partial<Omit<Summary, "setup">> & { setup?: Partial<Summary["setup"]> } = {}): Summary => ({
  hasReadyDocuments: false,
  hasCompletedChat: false,
  ...overrides,
  setup: {
    purpose: null,
    dismissed: false,
    skippedSteps: [],
    shouldShowFirstRun: true,
    hasDirectivesOrRoutines: false,
    hasNotifyDestination: false,
    hasNotifyDeliveryConfirmed: false,
    hasCredential: false,
    ...overrides.setup,
  },
});

const FRESH = summary();
const PARTLY_SET_UP = summary({ hasReadyDocuments: true, hasCompletedChat: true, setup: { shouldShowFirstRun: false } });
const COMPLETE = summary({
  hasReadyDocuments: true,
  hasCompletedChat: true,
  setup: { purpose: "Answer product questions", shouldShowFirstRun: false, hasDirectivesOrRoutines: true, hasNotifyDestination: true, hasNotifyDeliveryConfirmed: true, hasCredential: true },
});

const written = (greeting: string, suggestions: Array<{ id: string; text: string }>) => JSON.stringify({ greeting, suggestions });
const FRESH_REPLY = written("Hello", [
  { id: "documents", text: "Add your documents" },
  { id: "conversation", text: "Ask a first question" },
  { id: "directives_or_routines", text: "Give the agent a rule" },
]);

const harness = (state: Summary, reply: string | null | (() => string) = FRESH_REPLY, options: { now?: () => Date; terminatedReason?: string } = {}) => {
  let current = state;
  const runStreaming = vi.fn((_request: { systemPrompt: string; userMessage: string; usageContext?: unknown }, _tools: ReadonlyArray<unknown>) => ({
    events: (async function* () {})(),
    result: Promise.resolve({ terminatedReason: options.terminatedReason ?? "completed" as const, finalMessage: typeof reply === "function" ? reply() : reply, stepsTaken: 1, toolResultTokensUsed: 0, wallTimeMs: 1 }),
  }));
  const commit = vi.fn(async () => {});
  const release = vi.fn(async () => {});
  const reserveAnswer = vi.fn(async (_input: unknown) => ({ commit, release }));
  const warn = vi.fn<(fields: Record<string, unknown>, message: string) => void>();
  const service = new CopilotEmptyStateService({
    capabilityRunner: { runStreaming: runStreaming as never },
    usageLimitPolicy: { reserveAnswer },
    prompt: "You are Ray.",
    workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "acme" },
    setup: new WorkspaceSetupContext({ workspaceSetupState: { getSetupSignals: async () => current } }),
    logger: { warn },
    ...(options.now ? { now: options.now } : {}),
  });
  const get = (input: { locale?: string | null; permissions?: string[] } = {}) => service.get({
    workspaceId: "workspace-1",
    accountId: "account-1",
    permissions: new Set(input.permissions ?? ["workspace.summary.read"]),
    locale: input.locale ?? null,
  });
  return { get, runStreaming, reserveAnswer, commit, release, warn, setState: (next: Summary) => { current = next; } };
};

const offeredIds = (request: { userMessage: string }): string[] => {
  const offers = /Offers\.[^\n]*\n(\[.*\])/u.exec(request.userMessage);
  return (JSON.parse(offers![1]) as Array<{ id: string }>).map((offer) => offer.id);
};

describe("Ray empty state", () => {
  it("offers only the next incomplete steps on a fresh workspace, each deep-linked", async () => {
    const { get, runStreaming } = harness(FRESH, written("Let's pick up your setup.", [
      { id: "documents", text: "Add your documents" },
      { id: "conversation", text: "Ask a first question" },
      { id: "directives_or_routines", text: "Give the agent a rule" },
    ]));
    const state = await get();

    expect(offeredIds(runStreaming.mock.calls[0][0])).toEqual(["documents", "conversation", "directives_or_routines"]);
    expect(state).toEqual({
      phase: "setup",
      firstConversationHappened: false,
      greeting: "Let's pick up your setup.",
      suggestions: [
        { kind: "setup_step", step: "documents", text: "Add your documents", href: "/w/acme/knowledge" },
        { kind: "setup_step", step: "conversation", text: "Ask a first question", href: "/w/acme/agents" },
        { kind: "setup_step", step: "directives_or_routines", text: "Give the agent a rule", href: "/w/acme/agents?tab=behavior&anchor=assistant-directives" },
      ],
    });
  });

  it("tells the model no conversation has happened, in the system prompt and in the request", async () => {
    const { get, runStreaming } = harness(FRESH);
    await get();
    const request = runStreaming.mock.calls[0][0];
    expect(request.systemPrompt).toContain(JSON.stringify({ phase: "setup", firstConversationHappened: false }).slice(0, -1));
    expect(request.userMessage).toContain('"firstConversationHappened":false');
  });

  it("does not offer a step the state reports as done, and drops one the model suggests anyway", async () => {
    const { get, runStreaming } = harness(PARTLY_SET_UP, written("Good progress.", [
      { id: "documents", text: "Add your documents" },
      { id: "conversation", text: "Ask a first question" },
      { id: "directives_or_routines", text: "Give the agent a rule" },
      { id: "notify_destination", text: "Connect a handoff destination" },
      { id: "credential", text: "Create an API credential" },
    ]));
    const state = await get();

    expect(offeredIds(runStreaming.mock.calls[0][0])).toEqual(["directives_or_routines", "notify_destination", "credential"]);
    expect(state.suggestions.map((suggestion) => suggestion.kind === "setup_step" ? suggestion.step : suggestion.intent)).toEqual(["directives_or_routines", "notify_destination", "credential"]);
  });

  it("does not offer a step the operator skipped", async () => {
    const { get, runStreaming } = harness(summary({ hasReadyDocuments: true, setup: { skippedSteps: ["conversation", "directives_or_routines"] } }));
    await get();
    expect(offeredIds(runStreaming.mock.calls[0][0])).toEqual(["notify_destination", "credential"]);
  });

  it("moves to the open-ended tail once setup is complete, with no links and no setup step offered", async () => {
    const { get, runStreaming } = harness(COMPLETE, written("What shall we work on?", [
      { id: "crawl_more", text: "Crawl more of my website" },
      { id: "tighten_tone", text: "Tighten the tone" },
      { id: "draft_routine", text: "Draft a routine" },
      { id: "documents", text: "Add your documents" },
    ]));
    const state = await get();

    expect(offeredIds(runStreaming.mock.calls[0][0])).toEqual(["crawl_more", "tighten_tone", "draft_routine"]);
    expect(state).toEqual({
      phase: "open",
      firstConversationHappened: true,
      greeting: "What shall we work on?",
      suggestions: [
        { kind: "prompt", intent: "crawl_more", text: "Crawl more of my website" },
        { kind: "prompt", intent: "tighten_tone", text: "Tighten the tone" },
        { kind: "prompt", intent: "draft_routine", text: "Draft a routine" },
      ],
    });
  });

  it("moves to the open-ended tail when the operator dismissed setup, still saying no conversation has happened", async () => {
    const { get, runStreaming } = harness(summary({ setup: { dismissed: true } }), written("Where to?", [
      { id: "crawl_more", text: "Crawl more" },
      { id: "tighten_tone", text: "Tighten the tone" },
      { id: "draft_routine", text: "Draft a routine" },
    ]));
    expect(await get()).toMatchObject({ phase: "open", firstConversationHappened: false });
    expect(offeredIds(runStreaming.mock.calls[0][0])).toEqual(["crawl_more", "tighten_tone", "draft_routine"]);
  });

  it("writes in the operator's language and runs without tools or a conversation", async () => {
    const { get, runStreaming } = harness(FRESH);
    await get({ locale: "fr-CA" });
    const [request, tools] = runStreaming.mock.calls[0];
    expect(request.userMessage).toContain("browser: fr.");
    expect(request.userMessage).not.toContain("fr-CA");
    expect(tools).toEqual([]);
    expect(request.usageContext).toMatchObject({ workspaceId: "workspace-1", surface: "operator_copilot", attemptKey: "copilot_empty_state" });
  });

  it("names no language to the model when the browser names none", async () => {
    const { get, runStreaming } = harness(FRESH);
    await get({ locale: null });
    expect(runStreaming.mock.calls[0][0].userMessage).toContain("browser: unknown.");
  });

  it("answers an operator who cannot read the workspace summary without reading it, calling a model, or saying anything retrospective", async () => {
    const { get, runStreaming, reserveAnswer } = harness(FRESH);
    expect(await get({ permissions: ["workspace.agents.read"] })).toEqual({ phase: "open", firstConversationHappened: null, greeting: null, suggestions: [] });
    expect(runStreaming).not.toHaveBeenCalled();
    expect(reserveAnswer).not.toHaveBeenCalled();
  });

  it("writes copy once per state and language", async () => {
    const { get, runStreaming, setState } = harness(FRESH);
    await get({ locale: "en" });
    await get({ locale: "en" });
    expect(runStreaming).toHaveBeenCalledTimes(1);

    await get({ locale: "de" });
    expect(runStreaming).toHaveBeenCalledTimes(2);

    setState(PARTLY_SET_UP);
    await get({ locale: "en" });
    expect(runStreaming).toHaveBeenCalledTimes(3);
  });

  it("treats every region of a language as the same language", async () => {
    const { get, runStreaming } = harness(FRESH);
    await get({ locale: "en-AA" });
    await get({ locale: "en-AB" });
    await get({ locale: "EN-us" });
    expect(runStreaming).toHaveBeenCalledTimes(1);
  });

  it("shares one model call between concurrent opens of the same state", async () => {
    const { get, runStreaming } = harness(FRESH);
    await Promise.all([get(), get(), get()]);
    expect(runStreaming).toHaveBeenCalledTimes(1);
  });

  it("accepts a reply wrapped in a code fence", async () => {
    const { get } = harness(FRESH, `\`\`\`json\n${FRESH_REPLY}\n\`\`\``);
    expect((await get()).suggestions).toHaveLength(3);
  });

  it("degrades to a neutral empty state when the model's reply is unusable, and says so in the log", async () => {
    const { get, warn } = harness(FRESH, "not json at all");
    expect(await get()).toEqual({ phase: "setup", firstConversationHappened: false, greeting: null, suggestions: [] });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1", reason: "unusable_reply" }), "operator_copilot_empty_state_unavailable");
  });

  it("treats a reply that leaves an offered step unlabelled as unusable, rather than showing some chips for hours", async () => {
    let clock = new Date("2026-11-11T10:00:00.000Z");
    const replies = [written("Hello", [{ id: "documents", text: "Add your documents" }]), FRESH_REPLY];
    const { get, runStreaming } = harness(FRESH, () => replies.shift() ?? FRESH_REPLY, { now: () => clock });

    expect(await get()).toMatchObject({ greeting: null, suggestions: [] });
    clock = new Date("2026-11-11T10:01:01.000Z");
    expect((await get()).suggestions).toHaveLength(3);
    expect(runStreaming).toHaveBeenCalledTimes(2);
  });

  it("logs why a run produced no reply instead of calling it unparseable", async () => {
    const { get, warn } = harness(FRESH, null, { terminatedReason: "wall_time_exhausted" });
    expect(await get()).toMatchObject({ greeting: null, suggestions: [] });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "no_reply", terminatedReason: "wall_time_exhausted" }),
      "operator_copilot_empty_state_unavailable",
    );
  });

  it("degrades when the model call fails, without leaking the error into the response", async () => {
    const runStreaming = vi.fn(() => ({ events: (async function* () {})(), result: Promise.reject(new Error("provider down")) }));
    const warn = vi.fn<(fields: Record<string, unknown>, message: string) => void>();
    const service = new CopilotEmptyStateService({
      capabilityRunner: { runStreaming },
      usageLimitPolicy: { reserveAnswer: async () => ({ commit: async () => {}, release: async () => {} }) },
      prompt: "You are Ray.",
      workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "acme" },
      setup: new WorkspaceSetupContext({ workspaceSetupState: { getSetupSignals: async () => FRESH } }),
      logger: { warn },
    });
    const state = await service.get({ workspaceId: "workspace-1", accountId: "account-1", permissions: new Set(["workspace.summary.read"]), locale: null });
    expect(state).toEqual({ phase: "setup", firstConversationHappened: false, greeting: null, suggestions: [] });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "model_failed" }), "operator_copilot_empty_state_unavailable");
  });

  it("does not hammer a failing model: it waits a minute before writing again", async () => {
    let clock = new Date("2026-11-11T10:00:00.000Z");
    const { get, runStreaming } = harness(FRESH, "not json at all", { now: () => clock });
    await get();
    await get();
    expect(runStreaming).toHaveBeenCalledTimes(1);
    clock = new Date("2026-11-11T10:01:01.000Z");
    await get();
    expect(runStreaming).toHaveBeenCalledTimes(2);
  });
});

describe("Ray empty state usage", () => {
  it("reserves one greeting against the account before the model is asked, and keeps it once the copy is usable", async () => {
    const { get, reserveAnswer, commit, release, runStreaming } = harness(FRESH);
    await get();
    expect(reserveAnswer).toHaveBeenCalledWith({ accountId: "account-1", workspaceId: "workspace-1", surface: "operator_copilot", usage: "greeting" });
    expect(reserveAnswer.mock.invocationCallOrder[0]).toBeLessThan(runStreaming.mock.invocationCallOrder[0]);
    expect(commit).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("gives the reservation back when the model's reply is unusable", async () => {
    const { get, commit, release } = harness(FRESH, "not json at all");
    await get();
    expect(release).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it("spends nothing on a cached copy", async () => {
    const { get, reserveAnswer } = harness(FRESH);
    await get();
    await get();
    expect(reserveAnswer).toHaveBeenCalledOnce();
  });

  it("does not ask the model when the account has no allowance left", async () => {
    const { get, runStreaming, reserveAnswer, warn } = harness(FRESH);
    reserveAnswer.mockRejectedValueOnce(Object.assign(new Error("Usage limit exceeded"), { code: "usage_limit_exceeded" }));
    expect(await get()).toEqual({ phase: "setup", firstConversationHappened: false, greeting: null, suggestions: [] });
    expect(runStreaming).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "usage_unavailable" }), "operator_copilot_empty_state_unavailable");
  });
});
