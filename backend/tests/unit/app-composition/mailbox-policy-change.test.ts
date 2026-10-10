import { describe, expect, it, vi } from "vitest";

import { createPostgresMailboxPolicyChangeUnitOfWork } from "../../../src/app/composition/mailboxPolicyChange.js";
import { ConversationActivityRepository } from "../../../src/db/repositories/conversationActivityRepository.js";
import type { AuditEventInput } from "../../../src/modules/audit/contracts/index.js";
import { emailMailboxPolicyRef, MailboxService } from "../../../src/modules/emailChannel/public.js";
import { ConversationOwnershipService } from "../../../src/modules/handoff/public.js";
import { createRecordingKysely, type RecordedAnswer } from "../../support/recordingKysely.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";
const domainId = "33333333-3333-4333-8333-333333333333";
const actor = { userId: "44444444-4444-4444-8444-444444444444", accountId: null };
const createdAt = new Date("2026-10-01T09:00:00.000Z");

const mailboxRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: mailboxId,
  workspace_id: workspaceId,
  domain_id: domainId,
  agent_id: null,
  address: "support@customer.example",
  display_name: "Support",
  relay_token: "relaytoken",
  previous_relay_token: null,
  previous_relay_token_expires_at: null,
  engagement_mode: "draft",
  enabled: true,
  policy_version: 4,
  thread_send_budget: 3,
  hourly_generation_budget: 30,
  silence_threshold_hours: 72,
  plus_address_verified_at: null,
  setup_check_step: null,
  setup_check_started_at: null,
  last_received_at: null,
  removed_at: null,
  created_by_user_id: null,
  created_at: createdAt,
  updated_at: createdAt,
  ...overrides,
});

const ownershipRow = (conversationId: string, state: "ai_owned" | "human_owned", reason: string | null): Record<string, unknown> => ({
  conversation_id: conversationId,
  workspace_id: workspaceId,
  state,
  owner_account_id: null,
  owner_user_id: null,
  owner_display_name: null,
  owner_user_display_name: null,
  owner_user_email: null,
  reason,
  version: 1,
  taken_over_at: null,
  created_at: createdAt,
  updated_at: createdAt,
});

/** Classifies a statement by the table it writes or locks; null for any other. */
const kindOf = (sql: string): string | null => {
  if (/^select distinct "conversation_id" from "held_replies"/u.test(sql)) return "read_live_drafts";
  if (/^select "id" from "conversations" .*for no key update$/u.test(sql)) return "lock_conversation";
  if (/insert into conversation_ownership/iu.test(sql)) return "request_handoff";
  if (/from conversation_ownership o/iu.test(sql)) return "load_ownership";
  if (/insert into conversation_activity/iu.test(sql)) return "record_handoff_activity";
  if (/^select .* from "email_mailboxes" .*for update$/u.test(sql)) return "lock_mailbox";
  if (/^with "bumped" as \(update "email_mailboxes" .*insert into "email_mailbox_policies"/u.test(sql)) return "bump_policy_with_history";
  if (/^update "email_mailboxes" set "display_name"/u.test(sql)) return "update_settings";
  if (/^update "email_mailboxes" set "thread_send_budget"/u.test(sql)) return "update_budget";
  if (/^update "email_mailboxes" set "removed_at"/u.test(sql)) return "mark_removed";
  if (/^update "held_replies" set .*"superseded_reason"/u.test(sql)) return "supersede_held_replies";
  if (/^update "held_replies" set .*"hold_reason"/u.test(sql)) return "return_queued_held_replies";
  if (/^update "held_replies"/u.test(sql)) return "rebind_held_replies";
  return null;
};

const harness = (options: {
  mode?: "operator_only" | "draft" | "auto";
  /** The conversations whose live draft the supersede finds. */
  superseded?: string[];
  supersedeFails?: boolean;
  /** Conversations a person already owns, so the hand-off writes nothing for them. */
  humanOwned?: string[];
  handoffFails?: boolean;
  returned?: number;
  rebound?: number;
  /** The conversations with a live draft on the mailbox before it is locked; the superseded ones unless given. */
  live?: string[];
  /** How many times the supersede is aborted as a deadlock victim before it goes through. */
  deadlocks?: number;
  /** Conversations deleted by the time they are locked. */
  gone?: string[];
} = {}) => {
  let deadlocks = options.deadlocks ?? 0;
  const { db, statements, log } = createRecordingKysely(({ sql, parameters }): RecordedAnswer => {
    switch (kindOf(sql)) {
      case "read_live_drafts":
        return { rows: (options.live ?? options.superseded ?? []).map((conversationId) => ({ conversation_id: conversationId })) };
      case "lock_conversation":
        return options.gone?.includes(String(parameters[0])) ? { rows: [] } : { rows: [{ id: parameters[0] }] };
      case "lock_mailbox":
        return { rows: [mailboxRow({ engagement_mode: options.mode ?? "draft" })] };
      case "update_budget":
        return { rows: [mailboxRow({ engagement_mode: options.mode ?? "draft", policy_version: 5, thread_send_budget: parameters[0] })] };
      case "mark_removed":
        return { rows: [mailboxRow({ removed_at: createdAt })] };
      case "bump_policy_with_history":
        return { rows: [mailboxRow({ engagement_mode: parameters[0], enabled: parameters[1], policy_version: 5 })] };
      case "update_settings":
        return { rows: [mailboxRow({ display_name: parameters[0] })] };
      case "supersede_held_replies":
        if (options.supersedeFails) throw new Error("held replies unavailable");
        if (deadlocks > 0) {
          deadlocks -= 1;
          throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        }
        return { rows: (options.superseded ?? []).map((conversationId) => ({ conversation_id: conversationId })) };
      case "request_handoff": {
        if (options.handoffFails) throw new Error("ownership unavailable");
        const conversationId = String(parameters[0]);
        return options.humanOwned?.includes(conversationId) ? { rows: [] } : { rows: [ownershipRow(conversationId, "human_owned", String(parameters[2]))] };
      }
      case "load_ownership":
        return { rows: [ownershipRow(String(parameters[0]), "human_owned", "operator_takeover")] };
      case "return_queued_held_replies":
        return { changed: options.returned ?? 0 };
      case "rebind_held_replies":
        return { changed: options.rebound ?? 0 };
      default:
        return undefined;
    }
  });
  const audit = { record: vi.fn(async (_event: AuditEventInput) => undefined) };
  /** What the dashboard was told, with what the database had received by then. */
  const published: { workspaceId: string; kinds: readonly string[]; sentBefore: string[] }[] = [];
  const publisher = {
    enqueue: (publishedWorkspaceId: string, kinds: readonly string[]) => {
      published.push({ workspaceId: publishedWorkspaceId, kinds, sentBefore: sent() });
      return { accepted: true as const, coalesced: false };
    },
  };
  const service = new MailboxService({
    mailboxes: {} as never,
    domainRecords: { findById: vi.fn(async () => null), listActive: vi.fn(async () => []) },
    sendingDomains: { ensureRegistered: vi.fn() },
    policyChanges: createPostgresMailboxPolicyChangeUnitOfWork({
      db,
      activity: new ConversationActivityRepository(db),
      // The ownership rules' hand-off reads nothing but the scope it is given.
      ownership: new ConversationOwnershipService({} as never),
      publisher,
    }),
    agents: { findByIdAndWorkspaceId: vi.fn(async () => null) },
    audit,
    logger: { warn: vi.fn() },
    randomBytes: (size) => new Uint8Array(size),
    clock: () => createdAt,
    config: { inboundDomain: "in.radioso.test", supportedModes: ["operator_only", "draft", "auto"] },
  });
  /** What the database received: BEGIN, COMMIT and ROLLBACK, and each statement by its kind. */
  const sent = () => log.map((entry) => (["BEGIN", "COMMIT", "ROLLBACK"].includes(entry) ? entry : kindOf(entry) ?? entry));
  const statementOf = (kind: string) => statements.find((statement) => kindOf(statement.sql) === kind);
  const supersede = () => statementOf("supersede_held_replies");
  const statementsOf = (kind: string) => statements.filter((statement) => kindOf(statement.sql) === kind);
  return { service, statements, sent, supersede, statementOf, statementsOf, audit, published };
};

describe("createPostgresMailboxPolicyChangeUnitOfWork", () => {
  it("locks the mailbox FOR UPDATE, bumps the version with its history row and supersedes its drafts, in one transaction", async () => {
    const { service, statements, sent, supersede, audit } = harness({ superseded: [] });

    const view = await service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" });

    expect(view).toMatchObject({ engagementMode: "operator_only", policyVersion: 5 });
    expect(sent()).toEqual(["BEGIN", "read_live_drafts", "lock_mailbox", "bump_policy_with_history", "supersede_held_replies", "COMMIT"]);
    expect(new Set(statements.map((statement) => statement.transaction))).toEqual(new Set([1]));
    // Every live draft bound to the mailbox's policy, whatever its conversation: pending or queued to send.
    expect(supersede()?.sql).toMatch(/where "policy_ref" = \$\d+ and "state" in \(\$\d+, \$\d+\) returning "conversation_id"$/u);
    expect(supersede()?.parameters).toEqual(expect.arrayContaining([
      "superseded",
      "policy_changed",
      emailMailboxPolicyRef(mailboxId),
      "pending",
      "queued_auto",
    ]));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "email_channel.mailbox",
      metadata: expect.objectContaining({
        action: "mode_changed",
        fromMode: "draft",
        toMode: "operator_only",
        policyVersion: 5,
        supersededHeldReplies: 0,
        handedOffConversations: 0,
      }),
    }));
  });

  it("hands each conversation whose draft it superseded to a person in the same transaction, and tells the dashboard once it commits", async () => {
    const { service, statements, sent, statementsOf, audit, published } = harness({ superseded: ["conversation-2", "conversation-1"] });

    await service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" });

    expect(sent()).toEqual([
      "BEGIN",
      // The lock protocol: each conversation with a live draft and its ownership row, in id order, before the mailbox.
      "read_live_drafts",
      "lock_conversation",
      "load_ownership",
      "lock_conversation",
      "load_ownership",
      "lock_mailbox",
      "bump_policy_with_history",
      "supersede_held_replies",
      "request_handoff",
      "record_handoff_activity",
      "request_handoff",
      "record_handoff_activity",
      "COMMIT",
    ]);
    expect(new Set(statements.map((statement) => statement.transaction))).toEqual(new Set([1]));
    expect(statementsOf("lock_conversation").map((statement) => statement.parameters)).toEqual([
      ["conversation-1", workspaceId],
      ["conversation-2", workspaceId],
    ]);
    expect(statementsOf("read_live_drafts")[0]?.parameters).toEqual(expect.arrayContaining([emailMailboxPolicyRef(mailboxId), "pending", "queued_auto"]));
    expect(statementsOf("request_handoff").map((statement) => statement.parameters)).toEqual([
      ["conversation-2", workspaceId, "operator_only_mailbox"],
      ["conversation-1", workspaceId, "operator_only_mailbox"],
    ]);
    expect(statementsOf("record_handoff_activity").map((statement) => statement.parameters.slice(0, 3))).toEqual([
      ["conversation-2", workspaceId, "handoff_requested"],
      ["conversation-1", workspaceId, "handoff_requested"],
    ]);
    // Told once, and only after the supersede and the hand-offs committed.
    expect(published).toEqual([{ workspaceId, kinds: ["hitl.decision_resolved", "conversation.ownership_changed"], sentBefore: sent() }]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ action: "mode_changed", supersededHeldReplies: 2, handedOffConversations: 2 }),
    }));
  });

  it("locks the conversation of a draft born after the change locked its conversations before creating its ownership row", async () => {
    const { service, sent, statementsOf, published } = harness({
      live: ["conversation-1"],
      superseded: ["conversation-1", "conversation-2"],
    });

    await service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" });

    expect(sent()).toEqual([
      "BEGIN",
      "read_live_drafts",
      "lock_conversation",
      "load_ownership",
      "lock_mailbox",
      "bump_policy_with_history",
      "supersede_held_replies",
      // Already locked, in order.
      "request_handoff",
      "record_handoff_activity",
      // Born after the change looked: its conversation is locked now, out of order, before an
      // ownership row is created for it. A deadlock that meets is retried whole.
      "lock_conversation",
      "request_handoff",
      "record_handoff_activity",
      "COMMIT",
    ]);
    expect(statementsOf("lock_conversation").map((statement) => statement.parameters)).toEqual([
      ["conversation-1", workspaceId],
      ["conversation-2", workspaceId],
    ]);
    expect(published).toEqual([{ workspaceId, kinds: ["hitl.decision_resolved", "conversation.ownership_changed"], sentBefore: sent() }]);
  });

  it("hands nothing off for a late draft's conversation that is gone by the time the change locks it", async () => {
    const { service, sent, audit } = harness({ live: [], superseded: ["conversation-1"], gone: ["conversation-1"] });

    await service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" });

    expect(sent()).toEqual([
      "BEGIN",
      "read_live_drafts",
      "lock_mailbox",
      "bump_policy_with_history",
      "supersede_held_replies",
      "lock_conversation",
      "COMMIT",
    ]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ supersededHeldReplies: 1, handedOffConversations: 0 }),
    }));
  });

  it("leaves a conversation a person already owns as it is: no activity, no dashboard notice", async () => {
    const { service, sent, published, audit } = harness({ superseded: ["conversation-1"], humanOwned: ["conversation-1"] });

    await service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" });

    expect(sent()).toEqual([
      "BEGIN",
      "read_live_drafts",
      "lock_conversation",
      "load_ownership",
      "lock_mailbox",
      "bump_policy_with_history",
      "supersede_held_replies",
      "request_handoff",
      "load_ownership",
      "COMMIT",
    ]);
    // The superseded draft leaves the approvals; the ownership did not change.
    expect(published).toEqual([{ workspaceId, kinds: ["hitl.decision_resolved"], sentBefore: sent() }]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ supersededHeldReplies: 1, handedOffConversations: 0 }),
    }));
  });

  it("rolls the policy change and its supersede back when a hand-off fails, telling and auditing nothing", async () => {
    const { service, sent, published, audit } = harness({ superseded: ["conversation-1"], handoffFails: true });

    await expect(service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" }))
      .rejects.toThrow("ownership unavailable");

    expect(sent()).toEqual([
      "BEGIN",
      "read_live_drafts",
      "lock_conversation",
      "load_ownership",
      "lock_mailbox",
      "bump_policy_with_history",
      "supersede_held_replies",
      "request_handoff",
      "ROLLBACK",
    ]);
    expect(published).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("holds the mailbox's live drafts for review under the new version when auto drops to draft, in the same transaction", async () => {
    const { service, statements, sent, statementOf, audit, published } = harness({ mode: "auto", returned: 2, rebound: 1 });

    const view = await service.update(actor, workspaceId, mailboxId, { engagementMode: "draft" });

    expect(view).toMatchObject({ engagementMode: "draft", policyVersion: 5 });
    // Pending drafts are re-bound first, so the queued sends returned after them are counted once.
    expect(sent()).toEqual(["BEGIN", "read_live_drafts", "lock_mailbox", "bump_policy_with_history", "rebind_held_replies", "return_queued_held_replies", "COMMIT"]);
    // The returned replies are approvals again: the dashboard hears once the change commits.
    expect(published).toEqual([{ workspaceId, kinds: ["hitl.decision_created"], sentBefore: sent() }]);
    expect(new Set(statements.map((statement) => statement.transaction))).toEqual(new Set([1]));
    const rebind = statementOf("rebind_held_replies");
    expect(rebind?.sql).toMatch(/"policy_version" = \$\d+.* where "policy_ref" = \$\d+ and "state" in \(\$\d+\)$/u);
    expect(rebind?.parameters).toEqual(expect.arrayContaining([5, emailMailboxPolicyRef(mailboxId), "pending"]));
    const returned = statementOf("return_queued_held_replies");
    expect(returned?.sql).toMatch(/where "policy_ref" = \$\d+ and "state" in \(\$\d+\)$/u);
    expect(returned?.parameters).toEqual(expect.arrayContaining(["pending", "policy_changed", 5, emailMailboxPolicyRef(mailboxId), "queued_auto"]));
    expect(returned?.parameters).not.toContain("superseded");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        action: "mode_changed",
        fromMode: "auto",
        toMode: "draft",
        policyVersion: 5,
        supersededHeldReplies: 0,
        returnedHeldReplies: 2,
        reboundHeldReplies: 1,
      }),
    }));
  });

  it("supersedes the live drafts, queued sends included, when auto drops to operator_only", async () => {
    const { service, sent, supersede } = harness({ mode: "auto", superseded: ["conversation-1"] });

    await service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" });

    expect(sent()).toEqual([
      "BEGIN",
      "read_live_drafts",
      "lock_conversation",
      "load_ownership",
      "lock_mailbox",
      "bump_policy_with_history",
      "supersede_held_replies",
      "request_handoff",
      "record_handoff_activity",
      "COMMIT",
    ]);
    expect(supersede()?.parameters).toEqual(expect.arrayContaining(["superseded", "policy_changed", "pending", "queued_auto"]));
  });

  it("leaves drafts alone for a settings change that is not policy, and for a stale policy version", async () => {
    const settingsOnly = harness();
    await settingsOnly.service.update(actor, workspaceId, mailboxId, { displayName: "Help desk" });
    expect(settingsOnly.sent()).toEqual(["BEGIN", "read_live_drafts", "lock_mailbox", "update_settings", "COMMIT"]);

    const stale = harness();
    await expect(stale.service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only", expectedPolicyVersion: 3 }))
      .rejects.toMatchObject({ statusCode: 409, code: "stale_policy_version" });
    expect(stale.sent()).toEqual(["BEGIN", "read_live_drafts", "lock_mailbox", "COMMIT"]);
  });

  it("rolls the policy change back when its drafts cannot be superseded, auditing nothing", async () => {
    const { service, sent, audit } = harness({ supersedeFails: true });

    await expect(service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" }))
      .rejects.toThrow("held replies unavailable");

    expect(sent()).toEqual(["BEGIN", "read_live_drafts", "lock_mailbox", "bump_policy_with_history", "supersede_held_replies", "ROLLBACK"]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("writes a version for a send budget change and holds the live drafts for review under it, in one transaction", async () => {
    const { service, sent, statementOf, published } = harness({ mode: "auto", returned: 1 });

    const view = await service.update(actor, workspaceId, mailboxId, { threadSendBudget: 1 });

    expect(view).toMatchObject({ engagementMode: "auto", threadSendBudget: 1, policyVersion: 5 });
    expect(sent()).toEqual([
      "BEGIN",
      "read_live_drafts",
      "lock_mailbox",
      "bump_policy_with_history",
      "rebind_held_replies",
      "return_queued_held_replies",
      "update_budget",
      "COMMIT",
    ]);
    // The history row keeps the policy as it was; only the version moves.
    expect(statementOf("bump_policy_with_history")?.parameters.slice(0, 3)).toEqual(["auto", true, null]);
    expect(published).toEqual([{ workspaceId, kinds: ["hitl.decision_created"], sentBefore: sent() }]);
  });

  it("removes the mailbox, supersedes its live drafts and hands their conversations to a person, in one transaction", async () => {
    const { service, statements, sent, statementsOf, audit, published } = harness({ superseded: ["conversation-1"] });

    await service.remove(actor, workspaceId, mailboxId);

    expect(sent()).toEqual([
      "BEGIN",
      "read_live_drafts",
      "lock_conversation",
      "load_ownership",
      "lock_mailbox",
      "mark_removed",
      "supersede_held_replies",
      "request_handoff",
      "record_handoff_activity",
      "COMMIT",
    ]);
    expect(new Set(statements.map((statement) => statement.transaction))).toEqual(new Set([1]));
    expect(statementsOf("request_handoff").map((statement) => statement.parameters)).toEqual([["conversation-1", workspaceId, "operator_only_mailbox"]]);
    expect(published).toEqual([{ workspaceId, kinds: ["hitl.decision_resolved", "conversation.ownership_changed"], sentBefore: sent() }]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ action: "removed", mailboxId, supersededHeldReplies: 1, handedOffConversations: 1 }),
    }));
  });

  it("runs the whole change again when Postgres aborted it as a deadlock victim, telling the dashboard once", async () => {
    const { service, sent, published, audit } = harness({ superseded: ["conversation-1"], deadlocks: 1 });

    await service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" });

    const attempt = ["read_live_drafts", "lock_conversation", "load_ownership", "lock_mailbox", "bump_policy_with_history", "supersede_held_replies"];
    expect(sent()).toEqual([
      "BEGIN",
      ...attempt,
      "ROLLBACK",
      "BEGIN",
      ...attempt,
      "request_handoff",
      "record_handoff_activity",
      "COMMIT",
    ]);
    expect(published).toEqual([{ workspaceId, kinds: ["hitl.decision_resolved", "conversation.ownership_changed"], sentBefore: sent() }]);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});
