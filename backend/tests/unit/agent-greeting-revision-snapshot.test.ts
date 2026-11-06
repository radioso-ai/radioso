import { describe, expect, it } from "vitest";

import {
  assertCandidateSnapshotIsRunnable,
  equalScopedAuthoringSnapshots,
  parseAgentRevisionSnapshot,
  readAgentRevisionGreeting,
} from "../../src/modules/agents/public.js";

const baseSnapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  customInstruction: null,
  directives: [],
  routines: [],
  contextVariableEnablements: [],
  ...overrides,
});

const exactContent = (overrides: Record<string, unknown> = {}) => ({
  chips: [],
  variants: [{ locale: "en", body: "Welcome! How can I help?", chipLabels: {} }],
  ...overrides,
});

describe("agent revision snapshot: exact greeting", () => {
  it("defaults an absent greeting to off with no content", () => {
    const parsed = parseAgentRevisionSnapshot(baseSnapshot());

    expect(parsed.greeting).toBeUndefined();
    expect(readAgentRevisionGreeting(parsed)).toEqual({ exactWordsEnabled: false, exactContent: null });
  });

  it("carries an authored-but-inactive greeting through parsing unchanged", () => {
    const parsed = parseAgentRevisionSnapshot(
      baseSnapshot({ greeting: { exactWordsEnabled: false, exactContent: exactContent() } }),
    );

    expect(readAgentRevisionGreeting(parsed)).toEqual({
      exactWordsEnabled: false,
      exactContent: exactContent(),
    });
  });

  it("does not block a candidate/publish when exact words is off, even with invalid saved content", () => {
    const parsed = parseAgentRevisionSnapshot(
      baseSnapshot({
        greeting: {
          exactWordsEnabled: false,
          exactContent: exactContent({ variants: [{ locale: "en", body: "   ", chipLabels: {} }] }),
        },
      }),
    );

    expect(() => assertCandidateSnapshotIsRunnable(parsed, { agentDefaultLocale: "en" })).not.toThrow();
  });

  it("rejects a candidate/publish when exact words is enabled but no content is authored", () => {
    const parsed = parseAgentRevisionSnapshot(
      baseSnapshot({ greeting: { exactWordsEnabled: true, exactContent: null } }),
    );

    expect(() => assertCandidateSnapshotIsRunnable(parsed, { agentDefaultLocale: "en" })).toThrow(/cannot be released/u);
  });

  it("rejects a candidate/publish when exact words is enabled and content fails validation", () => {
    const parsed = parseAgentRevisionSnapshot(
      baseSnapshot({
        greeting: {
          exactWordsEnabled: true,
          exactContent: exactContent({ variants: [{ locale: "en", body: "", chipLabels: {} }] }),
        },
      }),
    );

    let caught: unknown;
    try {
      assertCandidateSnapshotIsRunnable(parsed, { agentDefaultLocale: "en" });
    } catch (error) {
      caught = error;
    }
    const appError = caught as { details?: { diagnostics?: Array<{ code: string; location: string }> } } | undefined;
    expect(appError?.details?.diagnostics).toContainEqual(
      expect.objectContaining({ code: "blank_body", location: "greeting.variants[0].body" }),
    );
  });

  it("re-validates against the current agent default locale, not one frozen at authoring time", () => {
    // Authored while the agent default locale was English; only an English variant exists.
    const parsed = parseAgentRevisionSnapshot(
      baseSnapshot({ greeting: { exactWordsEnabled: true, exactContent: exactContent() } }),
    );

    expect(() => assertCandidateSnapshotIsRunnable(parsed, { agentDefaultLocale: "en" })).not.toThrow();
    // The agent's default locale changed to Estonian after authoring; publication must be
    // rejected until an "et" variant exists (spec 1150 FR-005), even though the snapshot
    // itself never changed.
    expect(() => assertCandidateSnapshotIsRunnable(parsed, { agentDefaultLocale: "et" })).toThrow(/cannot be released/u);
  });

  it("falls back to English when no agentDefaultLocale option is supplied", () => {
    const parsed = parseAgentRevisionSnapshot(
      baseSnapshot({ greeting: { exactWordsEnabled: true, exactContent: exactContent() } }),
    );

    expect(() => assertCandidateSnapshotIsRunnable(parsed)).not.toThrow();
  });

  it("carries exact greeting content from draft into a published revision snapshot unchanged", () => {
    // Simulates AgentRevisionRepository#createCandidate/#publish freezing the draft's
    // greeting key into a revision row: parsing the frozen snapshot again must reproduce
    // the same authored content byte-for-byte (FR-013 — publishing snapshots the selected
    // revision's greeting; editing drafts afterward must not affect it).
    const draftSnapshot = baseSnapshot({
      greeting: { exactWordsEnabled: true, exactContent: exactContent({ chips: ["compare"], variants: [{ locale: "en", body: "Welcome! How can I help?", chipLabels: { compare: "Compare plans" } }] }) },
    });
    const candidateSnapshot = parseAgentRevisionSnapshot(draftSnapshot);
    const publishedSnapshot = parseAgentRevisionSnapshot(JSON.parse(JSON.stringify(candidateSnapshot)));

    expect(readAgentRevisionGreeting(publishedSnapshot)).toEqual(readAgentRevisionGreeting(candidateSnapshot));
    expect(() => assertCandidateSnapshotIsRunnable(publishedSnapshot, { agentDefaultLocale: "en" })).not.toThrow();
  });
});

describe("equalScopedAuthoringSnapshots: exact greeting", () => {
  const compare = (greeting: unknown) => ({
    exactWordsEnabled: true,
    exactContent: exactContent({
      chips: ["plans", "sales"],
      variants: [{ locale: "en", body: "Welcome!", chipLabels: { plans: "Compare plans", sales: "Talk to sales" } }],
    }),
    ...(greeting as object),
  });
  const snapshotWith = (greeting?: unknown) => parseAgentRevisionSnapshot(baseSnapshot(greeting === undefined ? {} : { greeting }));

  it("tells a draft that carries a greeting from a published revision that does not", () => {
    expect(equalScopedAuthoringSnapshots(snapshotWith(compare({})), snapshotWith())).toBe(false);
    expect(equalScopedAuthoringSnapshots(snapshotWith(), snapshotWith(compare({})))).toBe(false);
  });

  it("tells apart each change an operator can make to the greeting", () => {
    const published = snapshotWith(compare({}));

    expect(equalScopedAuthoringSnapshots(snapshotWith(compare({ exactWordsEnabled: false })), published)).toBe(false);
    expect(equalScopedAuthoringSnapshots(snapshotWith(compare({ exactContent: null })), published)).toBe(false);
    expect(equalScopedAuthoringSnapshots(snapshotWith(compare({ exactContent: exactContent({ chips: ["plans", "sales"], variants: [{ locale: "en", body: "Hello!", chipLabels: { plans: "Compare plans", sales: "Talk to sales" } }] }) })), published)).toBe(false);
    expect(equalScopedAuthoringSnapshots(snapshotWith(compare({ exactContent: exactContent({ chips: ["sales", "plans"], variants: [{ locale: "en", body: "Welcome!", chipLabels: { plans: "Compare plans", sales: "Talk to sales" } }] }) })), published)).toBe(false);
  });

  it("treats a greeting missing from one side as equal to the default on the other", () => {
    const authoredDefault = { exactWordsEnabled: false, exactContent: null };

    expect(equalScopedAuthoringSnapshots(snapshotWith(authoredDefault), snapshotWith())).toBe(true);
    expect(equalScopedAuthoringSnapshots(snapshotWith(), snapshotWith(authoredDefault))).toBe(true);
    expect(equalScopedAuthoringSnapshots(snapshotWith(), snapshotWith())).toBe(true);
  });

  it("counts a field the greeting gains later without anyone teaching the comparison about it", () => {
    // The snapshot schema is strict today, so a field the schema has not learned yet is fed in
    // unparsed: the comparison must read the greeting as a whole, not a hand-picked list of its fields.
    const withExtraField = (value: string) => ({
      ...snapshotWith(compare({})),
      greeting: { ...compare({}), exactContent: { ...compare({}).exactContent, variants: [{ locale: "en", body: "Welcome!", chipLabels: { plans: "Compare plans", sales: "Talk to sales" }, tone: value }] } },
    });

    expect(equalScopedAuthoringSnapshots(withExtraField("formal") as never, withExtraField("casual") as never)).toBe(false);
    expect(equalScopedAuthoringSnapshots(withExtraField("formal") as never, withExtraField("formal") as never)).toBe(true);
  });

  it("keeps variants in the order they were authored", () => {
    const variants = [
      { locale: "en", body: "Welcome!", chipLabels: {} },
      { locale: "et", body: "Tere!", chipLabels: {} },
    ];
    const authored = snapshotWith({ exactWordsEnabled: true, exactContent: exactContent({ variants }) });
    const reordered = snapshotWith({ exactWordsEnabled: true, exactContent: exactContent({ variants: [...variants].reverse() }) });

    expect(equalScopedAuthoringSnapshots(authored, reordered)).toBe(false);
  });

  it("is not fooled by the order of a variant's chip labels, which a stored copy may list differently", () => {
    const route = compare({ exactContent: exactContent({ chips: ["plans", "sales"], variants: [{ locale: "en", body: "Welcome!", chipLabels: { plans: "Compare plans", sales: "Talk to sales" } }] }) });
    const stored = compare({ exactContent: exactContent({ chips: ["plans", "sales"], variants: [{ locale: "en", body: "Welcome!", chipLabels: { sales: "Talk to sales", plans: "Compare plans" } }] }) });

    expect(equalScopedAuthoringSnapshots(snapshotWith(route), snapshotWith(stored))).toBe(true);
  });
});
