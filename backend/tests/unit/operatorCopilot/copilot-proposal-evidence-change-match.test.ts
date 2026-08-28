import { describe, expect, it, vi } from "vitest";

import { resolveProposalEvidence } from "../../../src/modules/operatorCopilot/services/proposalEvidenceService.js";
import type { CopilotReplayEvidenceRecord } from "../../../src/modules/operatorCopilot/contracts/evalCases.js";

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  operator: "00000000-0000-4000-8000-000000000002",
  agent: "00000000-0000-4000-8000-000000000003",
  evidence: "00000000-0000-4000-8000-000000000005",
};
const capturedAt = new Date("2026-08-25T10:00:00.000Z");

const record = (
  overrides: CopilotReplayEvidenceRecord["overrides"],
  directivesExcluded: ReadonlyArray<string> = [],
): CopilotReplayEvidenceRecord => ({
  id: ids.evidence,
  workspaceId: ids.workspace,
  operatorUserId: ids.operator,
  conversationId: "conversation-1",
  agentId: ids.agent,
  caseId: "00000000-0000-4000-8000-000000000007",
  caseName: "Refund window",
  runId: "00000000-0000-4000-8000-000000000008",
  baselineCapturedAt: capturedAt,
  recordedStatus: "failing",
  verdict: "pass",
  overrides,
  directivesExcluded,
  createdAt: capturedAt,
});

const resolve = (
  measured: CopilotReplayEvidenceRecord["overrides"],
  change: Parameters<typeof resolveProposalEvidence>[1]["change"],
  directivesExcluded: ReadonlyArray<string> = [],
) => resolveProposalEvidence(
  {
    evidence: { record: vi.fn(), findMany: vi.fn(async () => [record(measured, directivesExcluded)]) },
    agentVersion: { get: vi.fn(async () => ({ updatedAt: new Date("2026-08-24T10:00:00.000Z") })) },
  } as never,
  {
    workspaceId: ids.workspace,
    operatorUserId: ids.operator,
    copilotConversationId: "conversation-1",
    agentId: ids.agent,
    evidenceIds: [ids.evidence],
    change,
  },
);

describe("cited evidence must be about the change being proposed", () => {
  it("accepts a setting proposal whose value is the one that was measured", async () => {
    const evidence = await resolve(
      { agentConfigOverride: { customInstruction: "Always state the refund window." } },
      { targetType: "agent_setting", settingKey: "customInstruction", value: "Always state the refund window." },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("refuses evidence that measured a different setting than the one proposed", async () => {
    // The failure this exists for: Ray measures a directive, then drafts a greeting change, and
    // the card shows the directive's passing result next to it.
    await expect(resolve(
      { agentConfigOverride: { authoredDirectives: [{ action: "State the refund window" }] } },
      { targetType: "agent_setting", settingKey: "greetingInstruction", value: "Hello!" },
    )).rejects.toThrow(/did not measure/i);
  });

  it("refuses evidence that measured the same setting with a different value", async () => {
    await expect(resolve(
      { agentConfigOverride: { customInstruction: "Mention the refund window." } },
      { targetType: "agent_setting", settingKey: "customInstruction", value: "Never mention refunds." },
    )).rejects.toThrow(/did not measure/i);
  });

  it("matches a proposed chat model against the model the replay ran on", async () => {
    const evidence = await resolve(
      { modelOverride: { provider: "openai", model: "gpt-test-2" } },
      { targetType: "agent_setting", settingKey: "chatModelOverride", value: { provider: "openai", model: "gpt-test-2" } },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("refuses a setting no replay override can express, rather than accepting unrelated evidence", async () => {
    await expect(resolve(
      { agentConfigOverride: { customInstruction: "Anything." } },
      { targetType: "agent_setting", settingKey: "contactRequestsEnabled", value: true },
    )).rejects.toThrow(/cannot be measured/i);
  });

  it("accepts a directive proposal measured with directives in place", async () => {
    // A directive payload is drafted from prose, so it never byte-matches the authored override.
    // Requiring that directives were the thing under test is the strongest honest check.
    const evidence = await resolve(
      { agentConfigOverride: { authoredDirectives: [{ action: "State the refund window" }] } },
      { targetType: "directive" },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("refuses a directive proposal measured without any directive in the configuration", async () => {
    await expect(resolve(
      { retrievalSettingsOverride: { vectorTopK: 20 } },
      { targetType: "directive" },
    )).rejects.toThrow(/did not measure/i);
  });

  it("accepts a directive removal proposal whose replay recorded the proposed directive as excluded", async () => {
    // The honest evidence for removing a directive is directivesExcluded: a list the replay
    // service computed itself by resolving ids against the source agent's real directives, not
    // anything read from the model-supplied overrides.
    const evidence = await resolve(
      { agentConfigOverride: { authoredDirectives: [{ id: "kept-directive", action: "Keep answering refunds" }] } },
      { targetType: "directive", directiveId: "removed-directive" },
      ["removed-directive"],
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("refuses a directive removal proposal whose replay did not record the proposed directive as excluded", async () => {
    await expect(resolve(
      { agentConfigOverride: { authoredDirectives: [{ id: "removed-directive", action: "State the refund window" }] } },
      { targetType: "directive", directiveId: "removed-directive" },
    )).rejects.toThrow(/did not exclude/i);
  });

  it("refuses a directive removal proposal even when the replay's authored-directives array simply omits the directive's id", async () => {
    // The exact hole this closes: canonical directive serialization never carries an id, and the
    // overrides array is whatever the model supplied, so an id-less array that happens not to
    // contain a matching id used to read as proof of removal even though the directive's content
    // was still right there. Only a server-computed directivesExcluded entry counts now.
    await expect(resolve(
      { agentConfigOverride: { authoredDirectives: [{ name: "Refund policy", action: "State the refund window" }] } },
      { targetType: "directive", directiveId: "removed-directive" },
    )).rejects.toThrow(/did not exclude/i);
  });

  it("refuses a directive removal proposal measured without a deliberate directive-set override at all", async () => {
    // No excludedDirectiveIds means the replay service recorded no exclusion, so directivesExcluded
    // is empty regardless of what the replay's overrides otherwise look like.
    await expect(resolve(
      { retrievalSettingsOverride: { vectorTopK: 20 } },
      { targetType: "directive", directiveId: "removed-directive" },
    )).rejects.toThrow(/did not exclude/i);
  });

  it("refuses a directive removal proposal whose replay excluded the proposed directive plus another one", async () => {
    // The exact hole this closes: a replay that measured "A and B both removed" is not evidence
    // for "remove A alone" — removing both together can improve a metric that removing A alone
    // would regress. Membership is not enough; the excluded set must equal the proposed removal.
    await expect(resolve(
      { agentConfigOverride: { authoredDirectives: [{ id: "kept-directive", action: "Keep answering refunds" }] } },
      { targetType: "directive", directiveId: "removed-directive" },
      ["removed-directive", "another-directive"],
    )).rejects.toThrow(/did not exclude/i);
  });

  it("refuses a directive removal proposal whose replay excluded a different single directive", async () => {
    await expect(resolve(
      { agentConfigOverride: { authoredDirectives: [{ id: "kept-directive", action: "Keep answering refunds" }] } },
      { targetType: "directive", directiveId: "removed-directive" },
      ["another-directive"],
    )).rejects.toThrow(/did not exclude/i);
  });

  it("refuses a directive removal proposal whose replay also swapped the chat model", async () => {
    // The exact hole this closes: a replay that improved because it also used a different model
    // could be cited as proof that removing the directive helped, even though the exact-set
    // directivesExcluded check passed.
    await expect(resolve(
      {
        agentConfigOverride: { authoredDirectives: [{ id: "kept-directive", action: "Keep answering refunds" }] },
        modelOverride: { provider: "openai", model: "gpt-test-2" },
      },
      { targetType: "directive", directiveId: "removed-directive" },
      ["removed-directive"],
    )).rejects.toThrow(/isolate/i);
  });

  it("refuses a directive removal proposal whose replay also changed the instructions", async () => {
    await expect(resolve(
      {
        agentConfigOverride: { authoredDirectives: [{ id: "kept-directive", action: "Keep answering refunds" }] },
        assistantInstructionsOverride: { customInstruction: "Be terse." },
      },
      { targetType: "directive", directiveId: "removed-directive" },
      ["removed-directive"],
    )).rejects.toThrow(/isolate/i);
  });

  it("refuses a directive removal proposal whose replay also changed retrieval settings", async () => {
    await expect(resolve(
      {
        agentConfigOverride: { authoredDirectives: [{ id: "kept-directive", action: "Keep answering refunds" }] },
        retrievalSettingsOverride: { vectorTopK: 20 },
      },
      { targetType: "directive", directiveId: "removed-directive" },
      ["removed-directive"],
    )).rejects.toThrow(/isolate/i);
  });

  it("refuses a directive removal proposal whose replay also seeded a routine start state", async () => {
    await expect(resolve(
      {
        agentConfigOverride: { authoredDirectives: [{ id: "kept-directive", action: "Keep answering refunds" }] },
        routineStartState: { routineId: "refund-routine", path: [], variables: {}, status: "active" },
      },
      { targetType: "directive", directiveId: "removed-directive" },
      ["removed-directive"],
    )).rejects.toThrow(/isolate/i);
  });

  it("refuses a directive removal proposal whose replay also changed the custom instruction", async () => {
    await expect(resolve(
      {
        agentConfigOverride: {
          authoredDirectives: [{ id: "kept-directive", action: "Keep answering refunds" }],
          customInstruction: "Always mention the refund window.",
        },
      },
      { targetType: "directive", directiveId: "removed-directive" },
      ["removed-directive"],
    )).rejects.toThrow(/isolate/i);
  });

  it("refuses a directive removal proposal whose replay also changed a skill's settings", async () => {
    await expect(resolve(
      {
        agentConfigOverride: {
          authoredDirectives: [{ id: "kept-directive", action: "Keep answering refunds" }],
          skillSettings: { "retrieval.answer": { settings: { vectorTopK: 40 } } },
        },
      },
      { targetType: "directive", directiveId: "removed-directive" },
      ["removed-directive"],
    )).rejects.toThrow(/isolate/i);
  });

  it("refuses to attach replay evidence to a routine proposal at all", async () => {
    // No replay override installs a routine, so a passing replay says nothing about a proposed
    // one. test_agent_turn runs a real turn against an unpublished draft instead.
    await expect(resolve(
      { agentConfigOverride: { authoredDirectives: [{ action: "State the refund window" }] } },
      { targetType: "routine" },
    )).rejects.toThrow(/routine/i);
  });

  it("refuses to attach replay evidence to a context variable proposal at all", async () => {
    // CopilotEvalCaseReplayOverrides has no seam that installs a pushed, browser, or resolver
    // value — a replay never sees visitor context, so a passing replay says nothing about a
    // proposed variable or enablement.
    await expect(resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { vectorTopK: 20 } } } },
      { targetType: "context_variable" },
    )).rejects.toThrow(/context variable/i);
  });

  it("accepts a skill config proposal whose configuration is the one the replay measured", async () => {
    // agentConfig.ts's replay materialization merges skillSettings[key] onto the baseline's
    // { enabled, settings } envelope, so the override must nest its tuning fields under `settings`
    // for materializeAgentFromConfig to ever read them.
    const evidence = await resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: { vectorTopK: 40 } } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { vectorTopK: 40 } },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("refuses evidence whose override set the config outside the envelope's settings key, since materialization ignores it there", async () => {
    // The exact hole this closes: a flat `skillSettings["retrieval.answer"]: { vectorTopK: 40 }`
    // override used to byte-match a proposal's plain `config`, even though applyAgentConfigOverride
    // merges it onto the sibling of `settings` in the real envelope and materializeAgentFromConfig
    // never reads it from there — the replay measured the *baseline* configuration, unchanged, and
    // evidence still reported it as proof of the proposed values.
    await expect(resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { vectorTopK: 40 } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { vectorTopK: 40 } },
    )).rejects.toThrow(/did not measure/i);
  });

  it("refuses evidence that measured a different skill configuration than the one proposed", async () => {
    await expect(resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: { vectorTopK: 20 } } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { vectorTopK: 40 } },
    )).rejects.toThrow(/did not measure/i);
  });

  it("refuses a skill config proposal no replay override can express, rather than accepting unrelated evidence", async () => {
    // Only the retrieve capability's default-answer skill is synced onto a legacy skillSettings
    // slot a replay can override; every other capability/invocation-mode combination has no seam.
    await expect(resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: {} } } } },
      { targetType: "agent_skill", skillSettingsKey: null, config: { delivery: { recipientEmails: ["ops@example.com"] } } },
    )).rejects.toThrow(/cannot be measured/i);
  });

  it("accepts a skill config proposal whose enabled state is the one the replay measured", async () => {
    const evidence = await resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { enabled: false, settings: { vectorTopK: 40 } } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { vectorTopK: 40 }, enabled: false },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("refuses a skill config proposal whose enabled state the replay did not measure", async () => {
    // The exact hole this closes: a proposal that disables retrieval used to cite a replay whose
    // override never touched enablement at all, so the replay actually ran with retrieval on.
    await expect(resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: { vectorTopK: 40 } } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { vectorTopK: 40 }, enabled: false },
    )).rejects.toThrow(/enabled state/i);
  });

  it("does not require enablement evidence when the proposal does not state one", async () => {
    // Not every caller can express a target enabled value (see ProposalChange's agent_skill
    // variant); when the proposal is silent on it, only the configuration is checked.
    const evidence = await resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { enabled: false, settings: { vectorTopK: 40 } } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { vectorTopK: 40 } },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("refuses a skill config proposal that changed sourceScope when the replay's override set it flat instead of nested under the agent-level retrieval defaults", async () => {
    // The exact hole this closes: agentConfig.ts's materialization only reads sourceScope from
    // settings.__agentRetrievalDefaults.sourceScope. A flat settings.sourceScope sibling — the
    // proposal's own field name and shape — used to byte-match change.config.sourceScope and be
    // accepted, even though the replay actually ran with the baseline's source scope, unchanged.
    await expect(resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: { sourceScope: { sourceIds: ["source-1"] } } } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { sourceScope: { sourceIds: ["source-1"] } } },
    )).rejects.toThrow(/did not measure/i);
  });

  it("accepts a skill config proposal that changed sourceScope when the replay nested it under the agent-level retrieval defaults", async () => {
    const evidence = await resolve(
      {
        agentConfigOverride: {
          skillSettings: {
            "retrieval.answer": { settings: { __agentRetrievalDefaults: { sourceScope: { mode: "selected", sourceIds: ["source-1"] } } } },
          },
        },
      },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { sourceScope: { sourceIds: ["source-1"] } } },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("refuses a skill config proposal that changed the retrieval instruction when the replay's override used the proposal's own field name instead of customInstruction", async () => {
    // The exact hole this closes: the retrieve skill's `instruction` field is stored as
    // `customInstruction` in the tuning settings materialization reads; a flat
    // settings.instruction key — again the proposal's own field name — used to byte-match and be
    // accepted, even though nothing reads a key named "instruction" there.
    await expect(resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: { instruction: "Always cite the source document." } } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { instruction: "Always cite the source document." } },
    )).rejects.toThrow(/did not measure/i);
  });

  it("accepts a skill config proposal that changed the retrieval instruction when the replay set it as customInstruction", async () => {
    const evidence = await resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: { customInstruction: "Always cite the source document." } } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { instruction: "Always cite the source document." } },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("refuses a skill config proposal that changed suggestedQuestionsEnabled when the replay's override set it flat instead of nested under the agent-level retrieval defaults", async () => {
    // The exact hole this closes: agentConfig.ts's materialization only reads
    // suggestedQuestionsEnabled from settings.__agentRetrievalDefaults.suggestedQuestionsEnabled —
    // the same legacy slot sourceScope nests under. A flat settings.suggestedQuestionsEnabled
    // sibling — the proposal's own field name and shape — used to byte-match change.config's flat
    // suggestedQuestionsEnabled and be accepted, even though the replay actually ran with the
    // baseline's value, unchanged. This is the normal shape of an ordinary default-retrieve-skill
    // proposal, so this hole made replay evidence unattachable for the common case.
    await expect(resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: { suggestedQuestionsEnabled: false } } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { suggestedQuestionsEnabled: false } },
    )).rejects.toThrow(/did not measure/i);
  });

  it("accepts a skill config proposal that changed suggestedQuestionsEnabled when the replay nested it under the agent-level retrieval defaults", async () => {
    const evidence = await resolve(
      {
        agentConfigOverride: {
          skillSettings: {
            "retrieval.answer": { settings: { __agentRetrievalDefaults: { suggestedQuestionsEnabled: false } } },
          },
        },
      },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { suggestedQuestionsEnabled: false } },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("accepts a skill config proposal that changed sourceScope, the retrieval instruction, and a tuning field together when the replay measured all three correctly", async () => {
    // Exercises the full propose_skill_config mapping in one case: sourceScope nests under the
    // agent-level retrieval defaults, instruction renames to customInstruction, and an ordinary
    // tuning field (rerankEnabled) passes through by the same name on both sides.
    const evidence = await resolve(
      {
        agentConfigOverride: {
          skillSettings: {
            "retrieval.answer": {
              settings: {
                __agentRetrievalDefaults: { sourceScope: { mode: "selected", sourceIds: ["source-1"] } },
                customInstruction: "Always cite the source document.",
                rerankEnabled: true,
              },
            },
          },
        },
      },
      {
        targetType: "agent_skill",
        skillSettingsKey: "retrieval.answer",
        config: { sourceScope: { sourceIds: ["source-1"] }, instruction: "Always cite the source document.", rerankEnabled: true },
      },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  describe("an omitted replay-override field is measured against the captured baseline, not a schema default", () => {
    // agentConfig.ts's replay materialization deep-merges skillSettings[key] onto the case's
    // *captured* baseline envelope (applyAgentConfigOverride/mergeConfigValue) - an override field
    // the replay never touched means "ran with whatever the capture had", never a schema default.
    // These cases wire a `cases` dependency with a captured baseline directly, since the shared
    // `resolve()` helper above never does (proving the fallback used when no baseline is wired -
    // exercised by every other test in this file - stays behaviorally a no-op).
    const resolveWithCapturedBaseline = (
      measured: CopilotReplayEvidenceRecord["overrides"],
      change: Parameters<typeof resolveProposalEvidence>[1]["change"],
      snapshotDefaultAnswerSkill: { enabled: unknown; settings: Record<string, unknown> },
    ) => resolveProposalEvidence(
      {
        evidence: { record: vi.fn(), findMany: vi.fn(async () => [record(measured)]) },
        agentVersion: { get: vi.fn(async () => ({ updatedAt: new Date("2026-08-24T10:00:00.000Z") })) },
        cases: { findCase: vi.fn(async () => ({ snapshotDefaultAnswerSkill })) },
      } as never,
      {
        workspaceId: ids.workspace,
        operatorUserId: ids.operator,
        copilotConversationId: "conversation-1",
        agentId: ids.agent,
        evidenceIds: [ids.evidence],
        change,
      },
    );

    it("refuses evidence whose replay never touched sourceScope when the proposal's stated value only matches the schema default, not the captured baseline", async () => {
      // The exact hole this closes: an override that omits sourceScope entirely used to
      // canonicalize as the schema default "all" instead of "whatever the capture had". A
      // proposal stating "all" then byte-matched a replay that actually ran against a captured
      // `selected` scope, unchanged - evidence for behavior the replay never exercised.
      await expect(resolveWithCapturedBaseline(
        { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: { vectorTopK: 40 } } } } },
        { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { sourceScope: "all", vectorTopK: 40 } },
        { enabled: true, settings: { __agentRetrievalDefaults: { sourceScope: { mode: "selected", sourceIds: ["source-9"] } } } },
      )).rejects.toThrow(/did not measure/i);
    });

    it("accepts evidence whose replay never touched sourceScope when the proposal's stated value matches the captured baseline it actually ran against", async () => {
      const evidence = await resolveWithCapturedBaseline(
        { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: { vectorTopK: 40 } } } } },
        { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { sourceScope: { sourceIds: ["source-9"] }, vectorTopK: 40 } },
        { enabled: true, settings: { __agentRetrievalDefaults: { sourceScope: { mode: "selected", sourceIds: ["source-9"] } } } },
      );

      expect(evidence?.cases).toHaveLength(1);
    });

    it("accepts evidence whose replay never touched enabled when the proposal's stated enabled state matches the captured baseline it actually ran against", async () => {
      // Same confusion, the `enabled` field: comparing the raw override's `enabled` (undefined,
      // since this replay never touched it) directly against the proposal's stated value used to
      // always refuse this evidence, even when the replay genuinely ran with the proposed enabled
      // state by inheriting it unchanged from the baseline.
      const evidence = await resolveWithCapturedBaseline(
        { agentConfigOverride: { skillSettings: { "retrieval.answer": { settings: { vectorTopK: 40 } } } } },
        { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { vectorTopK: 40 }, enabled: false },
        { enabled: false, settings: {} },
      );

      expect(evidence?.cases).toHaveLength(1);
    });
  });
});
