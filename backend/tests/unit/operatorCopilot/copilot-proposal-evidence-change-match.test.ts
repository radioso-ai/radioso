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

const record = (overrides: CopilotReplayEvidenceRecord["overrides"]): CopilotReplayEvidenceRecord => ({
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
  createdAt: capturedAt,
});

const resolve = (
  measured: CopilotReplayEvidenceRecord["overrides"],
  change: Parameters<typeof resolveProposalEvidence>[1]["change"],
) => resolveProposalEvidence(
  {
    evidence: { record: vi.fn(), findMany: vi.fn(async () => [record(measured)]) },
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

  it("refuses to attach replay evidence to a routine proposal at all", async () => {
    // No replay override installs a routine, so a passing replay says nothing about a proposed
    // one. test_agent_turn runs a real turn against an unpublished draft instead.
    await expect(resolve(
      { agentConfigOverride: { authoredDirectives: [{ action: "State the refund window" }] } },
      { targetType: "routine" },
    )).rejects.toThrow(/routine/i);
  });

  it("accepts a skill config proposal whose configuration is the one the replay measured", async () => {
    const evidence = await resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { vectorTopK: 40 } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { vectorTopK: 40 } },
    );

    expect(evidence?.cases).toHaveLength(1);
  });

  it("refuses evidence that measured a different skill configuration than the one proposed", async () => {
    await expect(resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": { vectorTopK: 20 } } } },
      { targetType: "agent_skill", skillSettingsKey: "retrieval.answer", config: { vectorTopK: 40 } },
    )).rejects.toThrow(/did not measure/i);
  });

  it("refuses a skill config proposal no replay override can express, rather than accepting unrelated evidence", async () => {
    // Only the retrieve capability's default-answer skill is synced onto a legacy skillSettings
    // slot a replay can override; every other capability/invocation-mode combination has no seam.
    await expect(resolve(
      { agentConfigOverride: { skillSettings: { "retrieval.answer": {} } } },
      { targetType: "agent_skill", skillSettingsKey: null, config: { delivery: { recipientEmails: ["ops@example.com"] } } },
    )).rejects.toThrow(/cannot be measured/i);
  });
});
