import { describe, expect, it, vi } from "vitest";

import { ApprovalDecisionServiceError } from "../../../src/modules/approvals/public.js";
import { SlackInteractivityHandler } from "../../../src/modules/slack/public.js";
import type { PendingDecisionRecord } from "../../../src/db/repositories/pendingDecisionRepository.js";
import type { SlackInstallationRecord } from "../../../src/modules/slack/public.js";

const installation: SlackInstallationRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  connectionId: "conn_1",
  workspaceId: "ws_1",
  teamId: "T1",
  teamName: "Team",
  botUserId: "B1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const pendingDecision: PendingDecisionRecord = {
  id: "dec_1",
  handle: "pd_1",
  conversationId: "conv_1",
  sessionId: "session_1",
  workspaceId: "ws_1",
  agentId: "agent_1",
  routineId: "routine_1",
  stepId: "step_1",
  reason: "Pick the next branch",
  options: [
    { id: "ship", label: "Ship it" },
    { id: "hold", label: "Hold" },
  ],
  deciderScope: {},
  contentHash: "hash_1",
  status: "pending",
  decision: null,
  decidedBy: null,
  decidedAt: null,
  deadline: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const blockPayload = {
  type: "block_actions" as const,
  team: { id: "T1" },
  user: { id: "U1" },
  response_url: "https://hooks.slack.com/actions/1",
  actions: [{
    action_id: "decision_resolve",
    value: JSON.stringify({
      handle: "pd_1",
      optionId: "ship",
      contentHash: "hash_1",
      agentId: "agent_1",
    }),
  }],
};

const createHandler = (overrides: {
  identity?: { accountId: string; userId: string | null; displayName: string | null } | { rejected: true };
  resolveError?: Error;
} = {}) => {
  const responsePosts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const resolve = vi.fn(async () => {
    if (overrides.resolveError) {
      throw overrides.resolveError;
    }
    return { status: "resolved" as const, optionId: "ship", conversationId: "conv_1", resumed: true };
  });
  const audit = { record: vi.fn(async () => {}) };
  const metrics = { incrementCounter: vi.fn() };
  const handler = new SlackInteractivityHandler({
    installations: { findByTeamId: vi.fn(async () => installation) },
    identityResolver: {
      resolve: vi.fn(async () => overrides.identity ?? {
        accountId: "acct_1",
        userId: "user_1",
        displayName: "Dana",
      }),
    },
    approvalDecisions: { resolve },
    pendingDecisions: { loadByHandle: vi.fn(async () => pendingDecision) },
    responseUrlClient: {
      postToResponseUrl: vi.fn(async (url, body) => {
        responsePosts.push({ url, body });
      }),
    },
    audit,
    metrics,
  });
  return { handler, resolve, responsePosts, audit, metrics };
};

describe("SlackInteractivityHandler decision branch", () => {
  it("resolves the decoded decision and updates the original Slack message", async () => {
    const { handler, resolve, responsePosts, audit, metrics } = createHandler();

    await handler.handleBlockActions(blockPayload);

    expect(resolve).toHaveBeenCalledWith({
      agentId: "agent_1",
      handle: "pd_1",
      optionId: "ship",
      contentHash: "hash_1",
      caller: {
        accountId: "acct_1",
        workspaceId: "ws_1",
        userId: "user_1",
      },
    });
    expect(responsePosts).toHaveLength(1);
    expect(responsePosts[0]!.url).toBe("https://hooks.slack.com/actions/1");
    expect(responsePosts[0]!.body).toMatchObject({ replace_original: true });
    expect(JSON.stringify(responsePosts[0]!.body.blocks)).toContain("Ship it");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "acct_1",
      workspaceId: "ws_1",
      eventType: "hitl.decision.slack_resolve",
      eventStatus: "success",
    }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith("slack_operator_decisions_total", expect.objectContaining({
      labels: { outcome: "resolved" },
    }));
  });

  it("posts an ephemeral rejection when Slack identity is not an operator", async () => {
    const { handler, resolve, responsePosts, metrics } = createHandler({ identity: { rejected: true } });

    await handler.handleBlockActions(blockPayload);

    expect(resolve).not.toHaveBeenCalled();
    expect(responsePosts).toHaveLength(1);
    expect(responsePosts[0]!.body).toMatchObject({
      response_type: "ephemeral",
      text: "You're not a Radioso operator on this workspace.",
    });
    expect(metrics.incrementCounter).toHaveBeenCalledWith("slack_operator_decisions_total", expect.objectContaining({
      labels: { outcome: "rejected_identity" },
    }));
  });

  it("posts an ephemeral stale response and does not crash", async () => {
    const { handler, responsePosts, metrics } = createHandler({
      resolveError: new ApprovalDecisionServiceError("stale_proposal"),
    });

    await expect(handler.handleBlockActions(blockPayload)).resolves.toBeUndefined();

    expect(responsePosts).toHaveLength(1);
    expect(responsePosts[0]!.body).toMatchObject({
      response_type: "ephemeral",
      text: "This decision is already resolved or out of date. Refreshing.",
    });
    expect(metrics.incrementCounter).toHaveBeenCalledWith("slack_operator_decisions_total", expect.objectContaining({
      labels: { outcome: "stale" },
    }));
  });
});
