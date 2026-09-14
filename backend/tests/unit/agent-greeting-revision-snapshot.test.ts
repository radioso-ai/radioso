import { describe, expect, it } from "vitest";

import {
  assertCandidateSnapshotIsRunnable,
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
