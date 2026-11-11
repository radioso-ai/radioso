import { describe, expect, it, vi } from "vitest";

import { WorkspaceSetupContext } from "../../../src/modules/operatorCopilot/context/workspaceSetup.js";
import { CopilotEmptyStateService } from "../../../src/modules/operatorCopilot/services/emptyStateService.js";
import type { CopilotWorkspaceSetupStatePort } from "../../../src/modules/operatorCopilot/tools/workspaceSetupState.js";

type Summary = Awaited<ReturnType<CopilotWorkspaceSetupStatePort["getSummary"]>>;

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

const harness = (state: Summary, reply: string | (() => string) = written("Hello", []), options: { now?: () => Date } = {}) => {
  let current = state;
  const runStreaming = vi.fn((_request: { systemPrompt: string; userMessage: string; usageContext?: unknown }, _tools: ReadonlyArray<unknown>) => ({
    events: (async function* () {})(),
    result: Promise.resolve({ terminatedReason: "completed" as const, finalMessage: typeof reply === "function" ? reply() : reply, stepsTaken: 1, toolResultTokensUsed: 0, wallTimeMs: 1 }),
  }));
  const logger = { warn: vi.fn() };
  const service = new CopilotEmptyStateService({
    capabilityRunner: { runStreaming },
    prompt: "You are Ray.",
    workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "acme" },
    setup: new WorkspaceSetupContext({ workspaceSetupState: { getSummary: async () => current } }),
    logger,
    ...(options.now ? { now: options.now } : {}),
  });
  const get = (input: { locale?: string | null; permissions?: string[] } = {}) => service.get({
    workspaceId: "workspace-1",
    permissions: new Set(input.permissions ?? ["workspace.summary.read"]),
    locale: input.locale ?? null,
  });
  return { get, runStreaming, logger, setState: (next: Summary) => { current = next; } };
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
    ]));
    const state = await get();

    expect(offeredIds(runStreaming.mock.calls[0][0])).toEqual(["directives_or_routines", "notify_destination", "credential"]);
    expect(state.suggestions.map((suggestion) => suggestion.kind === "setup_step" ? suggestion.step : suggestion.intent)).toEqual(["directives_or_routines"]);
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
      greeting: "What shall we work on?",
      suggestions: [
        { kind: "prompt", intent: "crawl_more", text: "Crawl more of my website" },
        { kind: "prompt", intent: "tighten_tone", text: "Tighten the tone" },
        { kind: "prompt", intent: "draft_routine", text: "Draft a routine" },
      ],
    });
  });

  it("moves to the open-ended tail when the operator dismissed setup", async () => {
    const { get, runStreaming } = harness(summary({ setup: { dismissed: true } }));
    expect((await get()).phase).toBe("open");
    expect(offeredIds(runStreaming.mock.calls[0][0])).toEqual(["crawl_more", "tighten_tone", "draft_routine"]);
  });

  it("writes in the operator's language and runs without tools or a conversation", async () => {
    const { get, runStreaming } = harness(FRESH);
    await get({ locale: "fr-CA" });
    const [request, tools] = runStreaming.mock.calls[0];
    expect(request.userMessage).toContain("fr-CA");
    expect(tools).toEqual([]);
    expect(request.usageContext).toMatchObject({ workspaceId: "workspace-1", surface: "operator_copilot", attemptKey: "copilot_empty_state" });
  });

  it("answers an operator who cannot read the workspace summary without reading it or calling a model", async () => {
    const { get, runStreaming } = harness(FRESH);
    expect(await get({ permissions: ["workspace.agents.read"] })).toEqual({ phase: "open", greeting: null, suggestions: [] });
    expect(runStreaming).not.toHaveBeenCalled();
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

  it("shares one model call between concurrent opens of the same state", async () => {
    const { get, runStreaming } = harness(FRESH);
    await Promise.all([get(), get(), get()]);
    expect(runStreaming).toHaveBeenCalledTimes(1);
  });

  it("accepts a reply wrapped in a code fence", async () => {
    const { get } = harness(FRESH, `\`\`\`json\n${written("Hi", [{ id: "documents", text: "Add documents" }])}\n\`\`\``);
    expect((await get()).suggestions).toHaveLength(1);
  });

  it("degrades to a neutral empty state when the model's reply is unusable, and says so in the log", async () => {
    const { get, logger } = harness(FRESH, "not json at all");
    expect(await get()).toEqual({ phase: "setup", greeting: null, suggestions: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1", reason: "unparseable_reply" }), "operator_copilot_empty_state_unavailable");
  });

  it("degrades when the model call fails, without leaking the error into the response", async () => {
    const runStreaming = vi.fn(() => ({ events: (async function* () {})(), result: Promise.reject(new Error("provider down")) }));
    const logger = { warn: vi.fn() };
    const service = new CopilotEmptyStateService({
      capabilityRunner: { runStreaming },
      prompt: "You are Ray.",
      workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "acme" },
      setup: new WorkspaceSetupContext({ workspaceSetupState: { getSummary: async () => FRESH } }),
      logger,
    });
    const state = await service.get({ workspaceId: "workspace-1", permissions: new Set(["workspace.summary.read"]), locale: null });
    expect(state).toEqual({ phase: "setup", greeting: null, suggestions: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "model_failed" }), "operator_copilot_empty_state_unavailable");
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
