import { describe, expect, it, vi } from "vitest";

import {
  createPostgresHeldReplyUnitOfWork,
  emailHeldReplyChannelRegistration,
  type HeldReplyChannelRegistration,
} from "../../../src/app/composition/heldReplyUnitOfWork.js";
import type { ConversationRecord } from "../../../src/db/repositories/conversationRepository.js";
import { emailMailboxPolicyRef, EMAIL_SEND_ACTION_TYPE } from "../../../src/modules/emailChannel/public.js";
import { HeldReplyService, type OwnershipActor } from "../../../src/modules/handoff/public.js";
import { createRecordingKysely, type RecordedAnswer } from "../../support/recordingKysely.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const heldReplyId = "33333333-3333-4333-8333-333333333333";
const mailboxId = "44444444-4444-4444-8444-444444444444";
const domainId = "55555555-5555-4555-8555-555555555555";
const answersMessageId = "66666666-6666-4666-8666-666666666666";
const dana: OwnershipActor = { accountId: "account-1", userId: "77777777-7777-4777-8777-777777777777", workspaceId };
const at = new Date("2026-10-04T10:00:00.000Z");

const conversation = {
  id: conversationId,
  workspaceId,
  sourceChannel: "email",
  channelContext: { provider: "email", mailbox: { id: mailboxId, address: "support@customer.example" } },
} as unknown as ConversationRecord;

const heldReplyRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: heldReplyId,
  workspace_id: workspaceId,
  conversation_id: conversationId,
  agent_id: null,
  state: "pending",
  release_kind: null,
  review_ref: `email:${conversationId}:1`,
  answers_message_id: answersMessageId,
  ownership_version: 0,
  policy_ref: emailMailboxPolicyRef(mailboxId),
  policy_version: 4,
  hold_reason: "draft_mode",
  turn_facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, citationCount: 1 },
  suppressed_effects: [],
  draft_text: "Your order ships tomorrow.",
  draft_presentation: { skillName: "retrieval.answer", skillOutcome: "grounded", metadata: { citations: [] } },
  edited_text: null,
  editor_user_id: null,
  releaser_user_id: null,
  discarded_by_user_id: null,
  released_message_id: null,
  superseded_reason: null,
  attention_cleared_at: null,
  attention_cleared_reason: null,
  decided_at: null,
  created_at: at,
  updated_at: at,
  ...overrides,
});

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
  thread_context_messages: 10,
  spam_opt_in: false,
  silence_threshold_hours: 72,
  plus_address_verified_at: null,
  setup_check_step: null,
  setup_check_started_at: null,
  last_received_at: null,
  removed_at: null,
  created_by_user_id: null,
  created_at: at,
  updated_at: at,
  ...overrides,
});

const domainRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: domainId,
  workspace_id: workspaceId,
  domain: "customer.example",
  provider: "local",
  provider_domain_id: null,
  provider_region: null,
  dns_records: [],
  sending_status: "verified",
  receiving_status: "not_requested",
  receiving_confirmed_by_user_id: null,
  receiving_confirmed_at: null,
  last_checked_at: null,
  next_check_at: null,
  status_changed_at: null,
  removed_at: null,
  provider_cleanup_status: null,
  created_by_user_id: null,
  created_at: at,
  ...overrides,
});

/** Classifies a statement by what it reads, locks or writes; null for any other. */
const kindOf = (sql: string): string | null => {
  if (/^select "id" from "conversations" .*for no key update$/u.test(sql)) return "lock_conversation";
  if (/FROM conversation_ownership o[\s\S]*FOR UPDATE OF o/u.test(sql)) return "lock_ownership";
  if (/^select \* from "held_replies" where "id" = /u.test(sql)) return "read_held_reply";
  if (/^select \* from "email_mailboxes" .*for share$/u.test(sql)) return "lock_policy";
  if (/^update "held_replies" set .*"releaser_user_id" = .*"ownership_version" = /u.test(sql)) return "release_held_reply";
  if (/^insert into "messages"/u.test(sql)) return "insert_message";
  if (/^update "conversations" set "updated_at"/u.test(sql)) return "touch_conversation";
  if (/^select \* from "email_domains"/u.test(sql)) return "read_domain";
  if (/^insert into "routine_action_requests"/u.test(sql)) return "enqueue";
  if (/^update "held_replies" set "released_message_id"/u.test(sql)) return "attach_message";
  return null;
};

const harness = (options: {
  heldReply?: Record<string, unknown>;
  mailbox?: Record<string, unknown>;
  domain?: Record<string, unknown>;
  channels?: readonly HeldReplyChannelRegistration[];
  drainFails?: boolean;
} = {}) => {
  let messageId: string | null = null;
  const { db, statements, log } = createRecordingKysely(({ sql, parameters }): RecordedAnswer => {
    switch (kindOf(sql)) {
      case "lock_conversation":
        return { rows: [{ id: conversationId }] };
      case "read_held_reply":
        return { rows: [heldReplyRow(options.heldReply)] };
      case "lock_policy":
        return { rows: [mailboxRow(options.mailbox)] };
      case "release_held_reply":
        return { rows: [heldReplyRow({ ...options.heldReply, state: "released", release_kind: "operator", releaser_user_id: dana.userId })] };
      case "insert_message":
        messageId = String(parameters[0]);
        return {
          rows: [{
            id: messageId,
            conversation_id: conversationId,
            workspace_id: workspaceId,
            role: "assistant",
            content: parameters[4],
            source: parameters[5],
            metadata_json: {},
            skill_name: null,
            skill_outcome: null,
            skill_status: null,
            total_latency_ms: null,
            grounding_verdict: null,
            grounding_claim_count: null,
            grounding_sourced_claim_count: null,
            grounding_unsourced_claim_count: null,
            grounding_invalid_source_count: null,
            created_at: at,
          }],
        };
      case "read_domain":
        return { rows: [domainRow(options.domain)] };
      case "enqueue":
        return { rows: [{ id: "action-1" }] };
      case "attach_message":
        return { rows: [heldReplyRow({ state: "released", release_kind: "operator", releaser_user_id: dana.userId, released_message_id: messageId })] };
      default:
        return undefined;
    }
  });
  const activity = {
    record: vi.fn(async (_db: unknown, event: { kind: string }) => {
      log.push(`activity:${event.kind}`);
    }),
  };
  const actionDrain = {
    requestDrain: vi.fn(async () => {
      log.push("drain");
      if (options.drainFails) throw new Error("drain unavailable");
    }),
  };
  const logger = { warn: vi.fn() };
  const replies = { write: vi.fn(), announce: vi.fn() };
  const service = new HeldReplyService({
    conversations: { findByIdAndWorkspaceId: vi.fn(async () => conversation) },
    writes: createPostgresHeldReplyUnitOfWork({
      db,
      channels: options.channels ?? [emailHeldReplyChannelRegistration],
      activity,
      actionDrain,
      logger,
    }),
    reads: {} as never,
    operatorIdentities: { resolve: vi.fn(async () => ({ userId: dana.userId, teammateLabel: "Dana Scully", replySignature: null })) },
    customerReplyDelivery: { route: vi.fn(async () => ({ enqueue: vi.fn() })) },
    replies,
    audit: { record: vi.fn(async () => undefined) },
    logger,
  });
  /** What the database received, by kind, with the transaction markers, the activity and the drain push. */
  const sent = () => log.map((entry) => kindOf(entry) ?? entry);
  const enqueued = () => statements.find((statement) => kindOf(statement.sql) === "enqueue");
  return { service, statements, sent, enqueued, actionDrain, logger, replies, messageId: () => messageId };
};

const release = (service: HeldReplyService) => service.release(dana, { conversationId, heldReplyId, editedText: null });

describe("createPostgresHeldReplyUnitOfWork", () => {
  it("releases in one transaction, in lock order: conversation, ownership, policy, held reply, message, delivery", async () => {
    const { service, statements, sent } = harness();

    const released = await release(service);

    expect(released).toMatchObject({ ok: true, heldReply: { state: "released" } });
    expect(sent()).toEqual([
      "BEGIN",
      "lock_conversation",
      "lock_ownership",
      "read_held_reply",
      "lock_policy",
      "release_held_reply",
      "insert_message",
      "touch_conversation",
      "lock_policy",
      "read_domain",
      "enqueue",
      "attach_message",
      "activity:held_reply_released",
      "COMMIT",
      "drain",
    ]);
    expect(new Set(statements.map((statement) => statement.transaction))).toEqual(new Set([1]));
  });

  it("writes the unchanged draft as the agent's message, with the presentation its review produced", async () => {
    const { service, statements } = harness();

    await release(service);

    const message = statements.find((statement) => kindOf(statement.sql) === "insert_message");
    expect(message?.sql).toMatch(/"skill_name", "skill_outcome"/u);
    expect(message?.parameters).toEqual(expect.arrayContaining([
      conversationId,
      workspaceId,
      "assistant",
      "Your order ships tomorrow.",
      "retrieval.answer",
      "grounded",
    ]));
  });

  it("queues the release on the transaction's outbox as email's held_release send, keyed by the message", async () => {
    const { service, enqueued, messageId } = harness();

    const released = await release(service);

    expect(released).toMatchObject({ ok: true, messageId: messageId() });
    const payload = JSON.parse(String(enqueued()?.parameters[1])) as Record<string, unknown>;
    expect(enqueued()?.parameters).toEqual(expect.arrayContaining([EMAIL_SEND_ACTION_TYPE, `email:send:msg:${messageId()}`]));
    expect(payload).toEqual({
      version: 1,
      trigger: "held_release",
      mailboxId,
      conversationId,
      messageId: messageId(),
      heldReplyId,
      authority: { policyVersion: 4, ownershipVersion: 0, mode: "draft", domainId },
    });
  });

  it("resolves the channel scope by the policy ref's prefix, and none for a prefix no channel registered", async () => {
    const unclaimed = harness({ heldReply: { policy_ref: `other_channel:${mailboxId}` } });

    expect(await release(unclaimed.service)).toMatchObject({ ok: false, refusal: "channel_not_ready" });
    expect(unclaimed.sent()).toEqual(["BEGIN", "lock_conversation", "lock_ownership", "read_held_reply", "COMMIT"]);

    const unregistered = harness({ channels: [] });
    expect(await release(unregistered.service)).toMatchObject({ ok: false, refusal: "channel_not_ready" });
    expect(unregistered.sent()).not.toContain("lock_policy");

    // Email's prefix with no mailbox id after it: email claims it, and vouches for no policy.
    const malformed = harness({ heldReply: { policy_ref: "email_mailbox:not-a-mailbox" } });
    expect(await release(malformed.service)).toMatchObject({ ok: false, refusal: "channel_not_ready" });
    expect(malformed.sent()).not.toContain("lock_policy");
  });

  it("refuses channel prefixes that overlap, since a policy ref would name two channels", () => {
    const scope = emailHeldReplyChannelRegistration.bind;
    expect(() => createPostgresHeldReplyUnitOfWork({
      db: createRecordingKysely(() => undefined).db,
      channels: [{ policyRefPrefix: "email_", bind: scope }, emailHeldReplyChannelRegistration],
      activity: { record: vi.fn() },
      actionDrain: { requestDrain: vi.fn() },
      logger: { warn: vi.fn() },
    })).toThrow(/overlap/u);
  });

  it("refuses a release whose mailbox policy moved on, writing nothing and pushing no drain", async () => {
    const { service, sent, actionDrain } = harness({ mailbox: { policy_version: 5 } });

    expect(await release(service)).toMatchObject({ ok: false, refusal: "policy_changed", current: { state: "pending" } });
    expect(sent()).toEqual(["BEGIN", "lock_conversation", "lock_ownership", "read_held_reply", "lock_policy", "COMMIT"]);
    expect(actionDrain.requestDrain).not.toHaveBeenCalled();
  });

  it("rolls the release back, pushing no drain, when the mailbox can no longer send as its address", async () => {
    const { service, sent, actionDrain, replies } = harness({ domain: { sending_status: "pending" } });

    await expect(release(service)).rejects.toMatchObject({ statusCode: 409, code: "email_sending_not_verified" });
    expect(sent().slice(-3)).toEqual(["lock_policy", "read_domain", "ROLLBACK"]);
    expect(sent()).not.toContain("enqueue");
    expect(actionDrain.requestDrain).not.toHaveBeenCalled();
    expect(replies.announce).not.toHaveBeenCalled();
  });

  it("keeps a committed release when the drain push fails, logging it by ids", async () => {
    const { service, logger } = harness({ drainFails: true });

    await expect(release(service)).resolves.toMatchObject({ ok: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "held_reply_release_drain_push_failed", workspaceId, conversationId }),
      expect.any(String),
    );
  });
});
