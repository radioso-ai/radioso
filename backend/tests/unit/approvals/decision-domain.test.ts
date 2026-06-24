import { describe, expect, it } from "vitest";

import type { PendingDecisionRecord } from "../../../src/db/repositories/pendingDecisionRepository.js";
import {
  resolveDecisionDomain,
  satisfiesDeciderScope,
} from "../../../src/modules/approvals/domain.js";

const record = (overrides: Partial<PendingDecisionRecord> = {}): PendingDecisionRecord => ({
  id: "row_1",
  handle: "pd_1",
  conversationId: "conv_1",
  sessionId: "session_1",
  workspaceId: "workspace_1",
  agentId: "agent_1",
  routineId: "routine_1",
  stepId: "gate",
  reason: null,
  options: [
    { id: "approve", label: "Approve" },
    { id: "issue_partial_refund", label: "Issue a partial refund" },
  ],
  deciderScope: { kind: "workspace_member" },
  contentHash: "hash_1",
  status: "pending",
  decision: null,
  decidedBy: null,
  decidedAt: null,
  deadline: null,
  createdAt: new Date("2026-06-18T00:00:00.000Z"),
  updatedAt: new Date("2026-06-18T00:00:00.000Z"),
  ...overrides,
});

describe("approval decision domain", () => {
  it("resolves any declared option to the operator's exact choice (no binary outcome)", () => {
    expect(resolveDecisionDomain({
      record: record(),
      optionId: "approve",
      contentHash: "hash_1",
      caller: { accountId: "account_1", workspaceId: "workspace_1" },
    })).toEqual({
      decision: { optionId: "approve", label: "Approve" },
    });

    // An author-named option that never matched the old approve/reject keyword map still
    // resolves — the routine branches on this id.
    expect(resolveDecisionDomain({
      record: record(),
      optionId: "issue_partial_refund",
      contentHash: "hash_1",
      caller: { accountId: "account_1", workspaceId: "workspace_1" },
    })).toEqual({
      decision: { optionId: "issue_partial_refund", label: "Issue a partial refund" },
    });
  });

  it("uses the stored option payload when the resolver receives only an option id", () => {
    expect(resolveDecisionDomain({
      record: record({
        options: [
          { id: "approve", label: "Approve", payload: { internalCode: "approve_refund" } },
        ],
      }),
      optionId: "approve",
      contentHash: "hash_1",
      caller: { accountId: "account_1", workspaceId: "workspace_1" },
    })).toEqual({
      decision: {
        optionId: "approve",
        label: "Approve",
        payload: { internalCode: "approve_refund" },
      },
    });
  });

  it("rejects an option that is not in the pending decision option set", () => {
    expect(() => resolveDecisionDomain({
      record: record(),
      optionId: "escalate",
      contentHash: "hash_1",
      caller: { accountId: "account_1", workspaceId: "workspace_1" },
    })).toThrow("invalid_option");
  });

  it("rejects a stale proposal hash before option resolution", () => {
    expect(() => resolveDecisionDomain({
      record: record(),
      optionId: "approve",
      contentHash: "old_hash",
      caller: { accountId: "account_1", workspaceId: "workspace_1" },
    })).toThrow("stale_proposal");
  });

  it("requires the caller workspace to match the pending decision workspace", () => {
    expect(satisfiesDeciderScope({
      record: record({ deciderScope: { kind: "workspace_member" } }),
      caller: { accountId: "account_1", workspaceId: "workspace_1" },
    })).toBe(true);

    expect(satisfiesDeciderScope({
      record: record({ deciderScope: { kind: "workspace_member" } }),
      caller: { accountId: "account_1", workspaceId: "workspace_2" },
    })).toBe(false);
  });

  it("supports account-scoped deciders when the pending row narrows the workspace member scope", () => {
    const pending = record({
      deciderScope: { kind: "workspace_member", accountIds: ["account_2"] },
    });

    expect(satisfiesDeciderScope({
      record: pending,
      caller: { accountId: "account_2", workspaceId: "workspace_1" },
    })).toBe(true);

    expect(satisfiesDeciderScope({
      record: pending,
      caller: { accountId: "account_1", workspaceId: "workspace_1" },
    })).toBe(false);
  });

  it("supports workspace role deciders using effective role rank", () => {
    const pending = record({
      deciderScope: { kind: "workspace_role", role: "admin" },
    });

    expect(satisfiesDeciderScope({
      record: pending,
      caller: { accountId: "account_1", workspaceId: "workspace_1", workspaceRole: "owner" },
    })).toBe(true);
    expect(satisfiesDeciderScope({
      record: pending,
      caller: { accountId: "account_1", workspaceId: "workspace_1", workspaceRole: "admin" },
    })).toBe(true);
    expect(satisfiesDeciderScope({
      record: pending,
      caller: { accountId: "account_1", workspaceId: "workspace_1", workspaceRole: "member" },
    })).toBe(false);
    expect(satisfiesDeciderScope({
      record: pending,
      caller: { accountId: "account_1", workspaceId: "workspace_1" },
    })).toBe(false);
  });
});
