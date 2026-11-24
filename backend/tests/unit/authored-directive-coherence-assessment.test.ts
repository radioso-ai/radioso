import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  AuthoredDirectiveService,
  pendingDirectiveId,
  type AuthoredDirective,
  type AuthoredDirectiveInput,
  type AuthoredDirectiveServiceOptions,
} from "../../src/modules/agents/public.js";
import { defaultAnswerDirectives } from "../../src/modules/directives/public.js";
import type { DirectiveCoherenceCheckInput, DirectiveCoherenceVerdict } from "@radioso/conversation-contract";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const directiveInput = (name: string, overrides: Partial<AuthoredDirectiveInput> = {}): AuthoredDirectiveInput => ({
  name,
  condition: { kind: "always" },
  action: `Follow ${name}.`,
  ...overrides,
});

const persisted = (input: AuthoredDirectiveInput, overrides: Partial<AuthoredDirective> = {}): AuthoredDirective => ({
  id: randomUUID(),
  agentId,
  name: input.name,
  condition: input.condition,
  action: input.action,
  priority: null,
  requiredCapabilities: [],
  dependsOn: [],
  excludes: [],
  tags: [],
  routes: [],
  surfaces: input.surfaces ?? [],
  description: null,
  binding: null,
  lifecycle: null,
  enabled: input.enabled ?? true,
  metadata: {},
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  ...overrides,
});

const setup = (options: { verdict?: (input: DirectiveCoherenceCheckInput) => DirectiveCoherenceVerdict; checkerFails?: boolean } = {}) => {
  const agent = {
    id: agentId,
    workspaceId,
    name: "Front desk",
    customInstruction: "Be useful.",
    greetingInstruction: "Hello",
    assistantDefaultLocale: null as string | null,
    chatModelOverride: null,
  };
  const directives: AuthoredDirective[] = [];
  const created: AuthoredDirectiveInput[] = [];
  const repository = {
    findByIdAndWorkspaceId: async () => ({ ...agent }),
    listDirectives: async () => [...directives],
    createDirective: async (_agentId: string, _workspaceId: string, input: AuthoredDirectiveInput) => {
      created.push(input);
      const saved = persisted(input);
      directives.push(saved);
      return saved;
    },
    updateDirective: vi.fn(),
    deleteDirective: vi.fn(),
  } as unknown as AuthoredDirectiveServiceOptions["repository"];
  const checks: DirectiveCoherenceCheckInput[] = [];
  const check = vi.fn(async (input: DirectiveCoherenceCheckInput) => {
    checks.push(input);
    if (options.checkerFails) throw new Error("provider down");
    return options.verdict?.(input) ?? { coherent: true, conflicts: [], rationale: "Coherent." };
  });
  const service = new AuthoredDirectiveService({
    repository,
    coherenceChecker: { check },
    registeredCapabilityNames: new Set(),
  });
  return { service, agent, directives, created, checks, check };
};

describe("AuthoredDirectiveService.assessCoherence", () => {
  it("compares each candidate with enabled directives, earlier enabled candidates, and the built-ins, in that order", async () => {
    const { service, directives, checks } = setup();
    directives.push(persisted(directiveInput("existing-on")), persisted(directiveInput("existing-off", { enabled: false })));

    await service.assessCoherence(workspaceId, agentId, [
      { ref: "item-a", input: directiveInput("first") },
      { ref: "item-b", input: directiveInput("second-off", { enabled: false }) },
      { ref: "item-c", input: directiveInput("third") },
    ]);

    // The disabled candidate is not sent to the model, as create would skip it too.
    expect(checks.map((input) => input.candidate.name)).toEqual(["first", "third"]);
    const builtInNames = defaultAnswerDirectives.map((directive) => directive.name);
    expect(checks[0]?.existingDirectives.map((directive) => directive.name)).toEqual(["existing-on", ...builtInNames]);
    // "third" sees "first" (an earlier enabled candidate, by its stable reference), not the disabled "second-off".
    expect(checks[1]?.existingDirectives.map((directive) => directive.name)).toEqual(["existing-on", "first", ...builtInNames]);
    expect(checks[1]?.existingDirectives.find((directive) => directive.name === "first")?.id).toBe(pendingDirectiveId("item-a"));
  });

  it("returns one verdict per candidate, keyed by its reference", async () => {
    const { service } = setup({
      verdict: (input) => input.candidate.name === "third"
        ? { coherent: false, conflicts: [{ directiveId: pendingDirectiveId("item-a"), directiveName: "first", reason: "Overlaps." }], rationale: "Conflict." }
        : { coherent: true, conflicts: [], rationale: "Coherent." },
    });

    const assessment = await service.assessCoherence(workspaceId, agentId, [
      { ref: "item-a", input: directiveInput("first") },
      { ref: "item-b", input: directiveInput("second-off", { enabled: false }) },
      { ref: "item-c", input: directiveInput("third") },
    ]);

    expect(assessment.verdicts.map((entry) => entry.ref)).toEqual(["item-a", "item-b", "item-c"]);
    expect(assessment.verdicts[1]?.verdict.rationale).toMatch(/disabled/iu);
    expect(assessment.verdicts[2]?.verdict).toMatchObject({ coherent: false, conflicts: [{ directiveId: pendingDirectiveId("item-a") }] });
  });

  it("runs the candidates' checks concurrently and keeps their verdicts in request order", async () => {
    const { service, check } = setup();
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const finished: string[] = [];
    check.mockImplementation(async (input: DirectiveCoherenceCheckInput) => {
      started += 1;
      if (started === 3) release();
      // Each check waits until all three are in flight, which a serial loop would never reach.
      await allStarted;
      // Later candidates answer first, so request order has to be restored on purpose.
      await new Promise((resolve) => setTimeout(resolve, input.candidate.name === "first" ? 6 : input.candidate.name === "second" ? 3 : 0));
      finished.push(input.candidate.name);
      return { coherent: true, conflicts: [], rationale: `Checked ${input.candidate.name}.` };
    });

    const assessment = await service.assessCoherence(workspaceId, agentId, [
      { ref: "item-a", input: directiveInput("first") },
      { ref: "item-b", input: directiveInput("second") },
      { ref: "item-c", input: directiveInput("third") },
    ]);

    expect(finished).toEqual(["third", "second", "first"]);
    expect(assessment.verdicts.map((entry) => [entry.ref, entry.verdict.rationale])).toEqual([
      ["item-a", "Checked first."],
      ["item-b", "Checked second."],
      ["item-c", "Checked third."],
    ]);
  });

  it("keeps the fail-open verdict when the model call fails", async () => {
    const { service } = setup({ checkerFails: true });

    const assessment = await service.assessCoherence(workspaceId, agentId, [{ ref: "item-a", input: directiveInput("first") }]);

    expect(assessment.verdicts[0]?.verdict).toEqual({ coherent: true, conflicts: [], rationale: "Coherence check unavailable." });
    expect(assessment.contextToken).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects an invalid candidate before calling the model", async () => {
    const { service, check } = setup();

    await expect(service.assessCoherence(workspaceId, agentId, [{ ref: "item-a", input: { name: "", condition: { kind: "always" }, action: "" } }]))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(check).not.toHaveBeenCalled();
  });
});

describe("AuthoredDirectiveService.coherenceContextToken", () => {
  const candidates = [{ ref: "item-a", input: directiveInput("first") }];

  it("matches the assessment token while nothing changes, without calling the model", async () => {
    const { service, check } = setup();
    const assessment = await service.assessCoherence(workspaceId, agentId, candidates);
    check.mockClear();

    expect(await service.coherenceContextToken(workspaceId, agentId, candidates)).toBe(assessment.contextToken);
    expect(check).not.toHaveBeenCalled();
  });

  it.each([
    ["the greeting instruction", (state: ReturnType<typeof setup>) => { state.agent.greetingInstruction = "Welcome!"; }],
    ["the custom instruction", (state: ReturnType<typeof setup>) => { state.agent.customInstruction = "Be brief."; }],
    ["the default locale", (state: ReturnType<typeof setup>) => { state.agent.assistantDefaultLocale = "de-DE"; }],
    ["an enabled directive", (state: ReturnType<typeof setup>) => { state.directives.push(persisted(directiveInput("new-rule"))); }],
  ])("changes when %s changes", async (_label, mutate) => {
    const state = setup();
    const before = await state.service.coherenceContextToken(workspaceId, agentId, candidates);

    mutate(state);

    expect(await state.service.coherenceContextToken(workspaceId, agentId, candidates)).not.toBe(before);
  });

  it("changes when a candidate's content changes", async () => {
    const { service } = setup();
    const before = await service.coherenceContextToken(workspaceId, agentId, candidates);

    const after = await service.coherenceContextToken(workspaceId, agentId, [{ ref: "item-a", input: directiveInput("first", { action: "Different." }) }]);

    expect(after).not.toBe(before);
  });

  it("ignores a disabled directive, which the model never sees", async () => {
    const state = setup();
    const before = await state.service.coherenceContextToken(workspaceId, agentId, candidates);

    state.directives.push(persisted(directiveInput("parked", { enabled: false })));

    expect(await state.service.coherenceContextToken(workspaceId, agentId, candidates)).toBe(before);
  });
});

describe("AuthoredDirectiveService.create with an assessed verdict", () => {
  it("saves with the given verdict and does not call the model", async () => {
    const { service, check, created } = setup();
    const verdict = { coherent: false, conflicts: [{ directiveName: "x", reason: "Overlaps." }], rationale: "Assessed earlier." };

    const result = await service.create(workspaceId, agentId, directiveInput("first"), { assessedCoherence: verdict });

    expect(result.coherence).toBe(verdict);
    expect(created.map((input) => input.name)).toEqual(["first"]);
    expect(check).not.toHaveBeenCalled();
  });

  it("still checks coherence itself when no verdict is given", async () => {
    const { service, check } = setup();

    await service.create(workspaceId, agentId, directiveInput("first"));

    expect(check).toHaveBeenCalledTimes(1);
  });
});
