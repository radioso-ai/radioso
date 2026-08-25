import { describe, expect, it, vi } from "vitest";

import { resolveProposalEvidence } from "../../../src/modules/operatorCopilot/services/proposalEvidenceService.js";
import type { CopilotReplayEvidenceRecord } from "../../../src/modules/operatorCopilot/contracts/evalCases.js";

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  operator: "00000000-0000-4000-8000-000000000002",
  agent: "00000000-0000-4000-8000-000000000003",
  otherAgent: "00000000-0000-4000-8000-000000000004",
  evidence: "00000000-0000-4000-8000-000000000005",
  otherEvidence: "00000000-0000-4000-8000-000000000006",
  case: "00000000-0000-4000-8000-000000000007",
  run: "00000000-0000-4000-8000-000000000008",
};

/** When the eval case froze the agent configuration the replay ran against. */
const baselineCapturedAt = new Date("2026-08-25T10:00:00.000Z");

const record = (overrides: Partial<CopilotReplayEvidenceRecord> = {}): CopilotReplayEvidenceRecord => ({
  id: ids.evidence,
  workspaceId: ids.workspace,
  operatorUserId: ids.operator,
  conversationId: "conversation-1",
  agentId: ids.agent,
  caseId: ids.case,
  caseName: "Refund window",
  runId: ids.run,
  baselineCapturedAt,
  recordedStatus: "failing",
  verdict: "pass",
  overrides: {},
  createdAt: new Date("2026-08-25T10:05:00.000Z"),
  ...overrides,
});

const harness = (options: { records?: ReadonlyArray<CopilotReplayEvidenceRecord>; updatedAt?: Date } = {}) => {
  const findMany = vi.fn(async () => options.records ?? [record()]);
  const get = vi.fn(async () => ({ updatedAt: options.updatedAt ?? baselineCapturedAt }));
  return { findMany, get, deps: { evidence: { record: vi.fn(), findMany }, agentVersion: { get } } };
};

describe("proposal evidence resolution", () => {
  it("carries the measured verdicts onto the proposal", async () => {
    const { deps, findMany } = harness();

    const evidence = await resolveProposalEvidence(deps as never, {
      workspaceId: ids.workspace,
      operatorUserId: ids.operator,
      agentId: ids.agent,
      evidenceIds: [ids.evidence],
    });

    expect(findMany).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      operatorUserId: ids.operator,
      ids: [ids.evidence],
    });
    expect(evidence).toEqual({
      cases: [{ caseId: ids.case, caseName: "Refund window", runId: ids.run, before: "failing", after: "pass", stale: false }],
    });
  });

  it("marks a measurement stale when the agent moved after the replay", async () => {
    const { deps } = harness({ updatedAt: new Date("2026-08-25T12:00:00.000Z") });

    const evidence = await resolveProposalEvidence(deps as never, {
      workspaceId: ids.workspace,
      operatorUserId: ids.operator,
      agentId: ids.agent,
      evidenceIds: [ids.evidence],
    });

    expect(evidence?.cases[0]).toMatchObject({ stale: true });
  });

  it("refuses evidence measured against a different agent", async () => {
    // Evidence is only about the agent it was measured on; letting it decorate another agent's
    // proposal would attach a real measurement to a claim it never supported.
    const { deps } = harness({ records: [record({ agentId: ids.otherAgent })] });

    await expect(resolveProposalEvidence(deps as never, {
      workspaceId: ids.workspace,
      operatorUserId: ids.operator,
      agentId: ids.agent,
      evidenceIds: [ids.evidence],
    })).rejects.toThrow(/different agent/i);
  });

  it("refuses a proposal that cites evidence which cannot be found", async () => {
    // Dropping the id silently would understate the claim to "verified against 1 case" while the
    // operator asked for two.
    const { deps } = harness({ records: [record()] });

    await expect(resolveProposalEvidence(deps as never, {
      workspaceId: ids.workspace,
      operatorUserId: ids.operator,
      agentId: ids.agent,
      evidenceIds: [ids.evidence, ids.otherEvidence],
    })).rejects.toThrow(/not found/i);
  });

  it("returns nothing when no evidence is cited, so an unmeasured proposal stays unmeasured", async () => {
    const { deps, get } = harness();

    const evidence = await resolveProposalEvidence(deps as never, {
      workspaceId: ids.workspace,
      operatorUserId: ids.operator,
      agentId: ids.agent,
      evidenceIds: [],
    });

    expect(evidence).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps one entry per cited id even when the same case was replayed twice", async () => {
    const second = record({ id: ids.otherEvidence, runId: "run-2", verdict: "fail" });
    const { deps } = harness({ records: [record(), second] });

    const evidence = await resolveProposalEvidence(deps as never, {
      workspaceId: ids.workspace,
      operatorUserId: ids.operator,
      agentId: ids.agent,
      evidenceIds: [ids.evidence, ids.otherEvidence],
    });

    expect(evidence?.cases).toHaveLength(2);
  });
});

describe("proposal evidence staleness window", () => {
  it("marks a measurement stale when the agent moved before the replay ran", async () => {
    // A replay runs against the configuration the eval case froze, not the live agent. An agent
    // edited after that capture makes the measurement describe an older agent even though the
    // replay itself just happened — comparing against the live agent at replay time would have
    // called this fresh.
    const captured = new Date("2026-08-20T10:00:00.000Z");
    const findMany = vi.fn(async () => [record({ baselineCapturedAt: captured })]);
    const get = vi.fn(async () => ({ updatedAt: new Date("2026-08-24T10:00:00.000Z") }));

    const evidence = await resolveProposalEvidence(
      { evidence: { record: vi.fn(), findMany }, agentVersion: { get } } as never,
      { workspaceId: ids.workspace, operatorUserId: ids.operator, agentId: ids.agent, evidenceIds: [ids.evidence] },
    );

    expect(evidence?.cases[0]).toMatchObject({ stale: true });
  });

  it("keeps a measurement fresh when the agent has not changed since the capture", async () => {
    const captured = new Date("2026-08-20T10:00:00.000Z");
    const findMany = vi.fn(async () => [record({ baselineCapturedAt: captured })]);
    const get = vi.fn(async () => ({ updatedAt: new Date("2026-08-19T09:00:00.000Z") }));

    const evidence = await resolveProposalEvidence(
      { evidence: { record: vi.fn(), findMany }, agentVersion: { get } } as never,
      { workspaceId: ids.workspace, operatorUserId: ids.operator, agentId: ids.agent, evidenceIds: [ids.evidence] },
    );

    expect(evidence?.cases[0]).toMatchObject({ stale: false });
  });
});
