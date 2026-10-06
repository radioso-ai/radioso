import { randomBytes } from "node:crypto";

import type { ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { createEmailHeldReplyChannelRegistration } from "../../src/app/composition/emailChannel.js";
import type { HeldReplyChannelRegistration } from "../../src/app/composition/heldReplyUnitOfWork.js";
import {
  EMAIL_SEND_ACTION_TYPE,
  EmailDomainRepository,
  EmailMailboxRepository,
  MailboxService,
  emailSendKey,
  type MailboxPolicyChangeUnitOfWork,
} from "../../src/modules/emailChannel/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { INBOUND_DOMAIN, createEmailChannelDatabase, createPolicyChanges, createSpool, createWorkerNode } from "./support/emailChannelHarness.js";
import {
  createApiNode,
  messagesOf,
  openEmailConversation,
  outboxActionsOf,
  providerAcceptsUnder,
  seedTeammate,
  sendIntentsOf,
} from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Releasing a held reply against Postgres (research B1, AS4.8, FR-029, SC-004): concurrent releases
// serialize on the conversation row and send the draft once, the loser is refused with the held
// reply as it is now, a release never changes who owns the conversation, a policy change racing a
// release has exactly one winner, a pending draft never has a send queued for it, and an unedited
// release goes out as the agent's mail, with `Auto-Submitted: auto-generated` (AS5.7).

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const DRAFTING = ["operator_only", "draft"] as const;
const DRAFT_TEXT = "Hi Alice, your invoice is attached to this reply.";

type WorkerNode = ReturnType<typeof createWorkerNode>;
type ApiNode = ReturnType<typeof createApiNode>;

interface HeldReplyRow {
  id: string;
  state: string;
  superseded_reason: string | null;
  released_message_id: string | null;
}

interface RefusalBody {
  error: { code: string; details: { heldReply: Record<string, unknown> | null } };
}

/** Holds the first caller inside its transaction until released, and says when it got there. */
const gate = () => {
  let reach: () => void = () => undefined;
  let open: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let used = false;
  return {
    reached,
    open,
    /** The first call waits for `open`; every later one passes. */
    hold: async (): Promise<void> => {
      if (used) return;
      used = true;
      reach();
      await opened;
    },
  };
};

type Gate = ReturnType<typeof gate>;

/** Email's held-reply registration, holding a release's transaction once it has locked the mailbox's policy. */
const gatedAfterPolicyLock = (held: Gate): HeldReplyChannelRegistration => {
  const email = createEmailHeldReplyChannelRegistration({ provider: "local" });
  return {
    policyRefPrefix: email.policyRefPrefix,
    bind: (trx) => {
      const scope = email.bind(trx);
      return {
        lockPolicy: async (policyRef) => {
          const locked = await scope.lockPolicy(policyRef);
          await held.hold();
          return locked;
        },
        enqueueRelease: (heldReply, messageId, outbox) => scope.enqueueRelease(heldReply, messageId, outbox),
        reserveAutoSend: (conversationId) => scope.reserveAutoSend(conversationId),
        enqueueAutoSend: (heldReply, outbox) => scope.enqueueAutoSend(heldReply, outbox),
        authorizeAutoDispatch: (heldReply) => scope.authorizeAutoDispatch(heldReply),
        recordMaterialized: (heldReply, messageId) => scope.recordMaterialized(heldReply, messageId),
      };
    },
  };
};

describeIntegration("held reply release (Postgres, research B1)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  const nodes: WorkerNode[] = [];
  const apiDatabases: Database[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "held_release");
    database = suite.database;
    spool = await createSpool();
  }, 60_000);

  afterEach(async () => {
    await Promise.all([
      ...nodes.splice(0).map((node) => node.close().catch(() => undefined)),
      ...apiDatabases.splice(0).map((pool) => pool.close().catch(() => undefined)),
    ]);
  });

  afterAll(async () => {
    await spool?.remove();
    await suite?.close();
  }, 30_000);

  /** The conversation's ownership row as it stands; null while it has none. */
  const ownershipRowOf = (conversationId: string) =>
    database.queryOptional<{ state: string; version: number; owner_user_id: string | null }>(
      "SELECT state, version, owner_user_id FROM conversation_ownership WHERE conversation_id = $1",
      [conversationId],
    );

  /** A review that drafts a reply at the conversation's current ownership. */
  const drafting = async (input: ConnectorRespondInput): Promise<ConnectorTurnResult> => ({
    kind: "draft",
    conversationId: input.conversationId,
    ownershipVersion: (await ownershipRowOf(input.conversationId))?.version ?? 0,
    facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, suppressedEffects: [], citationCount: 1 },
    draft: { text: DRAFT_TEXT, presentation: { citations: [] } },
  });

  const workerNode = (): WorkerNode => {
    const node = createWorkerNode(suite.url, { spoolDir: spool.dir, supportedModes: DRAFTING, respond: drafting });
    nodes.push(node);
    return node;
  };

  /** An API process with its own pool, as a second replica would have. */
  const apiNode = (options: { heldReplyChannels?: readonly HeldReplyChannelRegistration[] } = {}): ApiNode => {
    const pool = new Database(suite.url);
    apiDatabases.push(pool);
    return createApiNode(pool, { spoolDir: spool.dir, ...options });
  };

  const heldRepliesOf = (conversationId: string) =>
    database.query<HeldReplyRow>(
      "SELECT id, state, superseded_reason, released_message_id FROM held_replies WHERE conversation_id = $1 ORDER BY created_at, id",
      [conversationId],
    );

  const emailSendsOf = async (conversationId: string) =>
    (await outboxActionsOf(database, conversationId)).filter((action) => action.type === EMAIL_SEND_ACTION_TYPE);

  const policyVersionOf = async (mailboxId: string): Promise<number> =>
    (await database.queryOne<{ policy_version: number }>("SELECT policy_version FROM email_mailboxes WHERE id = $1", [mailboxId]))
      .policy_version;

  /**
   * Alice's first contact on a `draft` mailbox, reviewed: the conversation holds one pending draft
   * and no reply, and nothing is queued to send.
   */
  const pendingDraft = async () => {
    const worker = workerNode();
    const opened = await openEmailConversation(database, { node: worker, spool }, { engagementMode: "draft", withAgent: true });
    await database.execute(
      "UPDATE email_thread_links SET review_due_at = now() - interval '1 second' WHERE conversation_id = $1 AND review_due_at IS NOT NULL",
      [opened.conversationId],
    );
    expect(await worker.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });
    const [held, ...others] = await heldRepliesOf(opened.conversationId);
    expect(others).toEqual([]);
    expect(held).toMatchObject({ state: "pending" });
    return { ...opened, worker, heldReplyId: held.id, target: { conversationId: opened.conversationId, heldReplyId: held.id } };
  };

  /** Resolves once `count` backends of this database are waiting on a lock; fails instead of hanging. */
  const lockWaiters = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { waiting } = await database.queryOne<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (waiting >= count) return;
      if (Date.now() > deadline) throw new Error(`expected ${count} lock waiter(s), saw ${waiting}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** The settings path's policy change, as the channel composition builds it, over `policyChanges`. */
  const mailboxSettings = (policyChanges: MailboxPolicyChangeUnitOfWork): MailboxService =>
    new MailboxService({
      mailboxes: new EmailMailboxRepository(database.kysely),
      domainRecords: new EmailDomainRepository(database.kysely),
      sendingDomains: { ensureRegistered: () => Promise.reject(new Error("no domain is registered here")) },
      policyChanges,
      agents: { findByIdAndWorkspaceId: async (agentId) => ({ id: agentId }) },
      randomBytes: (size) => randomBytes(size),
      clock: () => new Date(),
      config: { inboundDomain: INBOUND_DOMAIN, supportedModes: DRAFTING },
      audit: { record: async () => undefined },
      logger: { warn: () => undefined },
    });

  /** A policy change that holds its transaction open, mailbox locked and drafts superseded, until `held` opens. */
  const gatedPolicyChange = (held: Gate): MailboxService => {
    const changes = createPolicyChanges(database);
    return mailboxSettings({
      run: (work) => changes.run(async (scope) => {
        const result = await work(scope);
        await held.hold();
        return result;
      }),
    });
  };

  const downgradeToOperatorOnly = (settings: MailboxService, scenario: Awaited<ReturnType<typeof pendingDraft>>) =>
    settings.update({ userId: scenario.teammate.userId }, scenario.workspaceId, scenario.mailbox.id, { engagementMode: "operator_only" });

  it("sends a draft once under concurrent releases: one message, one email.send, the loser refused with the held reply as it is now", async () => {
    const scenario = await pendingDraft();
    const second = await seedTeammate(database, scenario);
    const ownershipBefore = await ownershipRowOf(scenario.conversationId);
    const messagesBefore = await messagesOf(database, scenario.conversationId);

    // The first release holds its transaction open with the conversation, ownership and policy
    // locked; the second, on another replica, must queue behind it on the conversation row.
    const held = gate();
    const first = apiNode({ heldReplyChannels: [gatedAfterPolicyLock(held)] }).releaseHeldReply(scenario.teammate, scenario.target).then((response) => response);
    await held.reached;
    const late = apiNode().releaseHeldReply(second, scenario.target, { editedText: "Hi Alice, a teammate's edit." }).then((response) => response);
    await lockWaiters(1);
    held.open();
    const [won, lost] = await Promise.all([first, late]);

    expect(won.status).toBe(201);
    const messageId = (won.body as { messageId: string }).messageId;
    expect(lost.status).toBe(409);
    expect((lost.body as RefusalBody).error.code).toBe("held_reply_not_pending");
    expect((lost.body as RefusalBody).error.details.heldReply).toMatchObject({
      id: scenario.heldReplyId,
      state: "released",
      draftText: DRAFT_TEXT,
      editedText: null,
      releaserUserId: scenario.teammate.userId,
      attentionOpen: false,
    });

    // One message: the agent's, written from the draft. The edit was never written.
    const messagesAfter = await messagesOf(database, scenario.conversationId);
    expect(messagesAfter.slice(0, messagesBefore.length)).toEqual(messagesBefore);
    expect(messagesAfter.slice(messagesBefore.length)).toEqual([expect.objectContaining({ id: messageId, role: "assistant", content: DRAFT_TEXT })]);
    expect(await heldRepliesOf(scenario.conversationId)).toEqual([
      expect.objectContaining({ id: scenario.heldReplyId, state: "released", released_message_id: messageId }),
    ]);

    // One email.send, keyed by the message and naming the held reply, and one email out.
    const [send, ...otherSends] = await emailSendsOf(scenario.conversationId);
    expect(otherSends).toEqual([]);
    expect(send).toMatchObject({
      idempotency_key: emailSendKey.message(messageId),
      payload: expect.objectContaining({ trigger: "held_release", messageId, heldReplyId: scenario.heldReplyId }),
    });
    await scenario.worker.dispatch();
    expect(await providerAcceptsUnder(spool.dir, emailSendKey.message(messageId))).toHaveLength(1);
    expect(await sendIntentsOf(database, messageId)).toEqual([expect.objectContaining({ heldReplyId: scenario.heldReplyId, trigger: "held_release" })]);

    // A release never takes the conversation over (FR-029).
    expect(await ownershipRowOf(scenario.conversationId)).toEqual(ownershipBefore);
  }, 60_000);

  it("lets exactly one of several simultaneous releases through, unforced", async () => {
    const scenario = await pendingDraft();
    const teammates = [scenario.teammate, await seedTeammate(database, scenario), await seedTeammate(database, scenario)];
    const ownershipBefore = await ownershipRowOf(scenario.conversationId);

    const responses = await Promise.all(teammates.map((teammate) => apiNode().releaseHeldReply(teammate, scenario.target).then((response) => response)));

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    const messageId = (responses.find((response) => response.status === 201)!.body as { messageId: string }).messageId;
    for (const refused of responses.filter((response) => response.status === 409)) {
      expect(refused.body as RefusalBody).toMatchObject({
        error: { code: "held_reply_not_pending", details: { heldReply: { id: scenario.heldReplyId, state: "released" } } },
      });
    }
    expect((await messagesOf(database, scenario.conversationId)).filter((message) => message.role === "assistant"))
      .toEqual([expect.objectContaining({ id: messageId, content: DRAFT_TEXT })]);
    expect(await emailSendsOf(scenario.conversationId)).toEqual([expect.objectContaining({ idempotency_key: emailSendKey.message(messageId) })]);
    expect(await ownershipRowOf(scenario.conversationId)).toEqual(ownershipBefore);
  }, 60_000);

  it("refuses a release once a policy change that locked the conversation first superseded its draft, and sends nothing", async () => {
    const scenario = await pendingDraft();
    const versionBefore = await policyVersionOf(scenario.mailbox.id);
    const messagesBefore = await messagesOf(database, scenario.conversationId);

    // The policy change holds the draft's conversation and the mailbox with the draft superseded but
    // uncommitted; the release waits on the conversation row, and then finds the draft superseded.
    const held = gate();
    const change = downgradeToOperatorOnly(gatedPolicyChange(held), scenario);
    await held.reached;
    const release = apiNode().releaseHeldReply(scenario.teammate, scenario.target).then((response) => response);
    await lockWaiters(1);
    held.open();
    const [, refused] = await Promise.all([change, release]);

    expect(refused.status).toBe(409);
    expect((refused.body as RefusalBody).error.code).toBe("held_reply_not_pending");
    // The held reply as it is now: superseded by the change that won, waiting for no one.
    expect((refused.body as RefusalBody).error.details.heldReply).toMatchObject({
      id: scenario.heldReplyId,
      state: "superseded",
      attentionOpen: false,
    });
    expect(await policyVersionOf(scenario.mailbox.id)).toBe(versionBefore + 1);
    expect(await heldRepliesOf(scenario.conversationId)).toEqual([
      expect.objectContaining({ state: "superseded", superseded_reason: "policy_changed", released_message_id: null }),
    ]);
    expect(await messagesOf(database, scenario.conversationId)).toEqual(messagesBefore);
    expect(await emailSendsOf(scenario.conversationId)).toEqual([]);
    // The change that won handed the waiting customer to a person, unclaimed.
    expect(await ownershipRowOf(scenario.conversationId)).toMatchObject({ state: "human_owned", owner_user_id: null });
  }, 60_000);

  it("sends a release that locked the mailbox first; the policy change waits and then finds nothing to supersede", async () => {
    const scenario = await pendingDraft();
    const versionBefore = await policyVersionOf(scenario.mailbox.id);
    const ownershipBefore = await ownershipRowOf(scenario.conversationId);

    const held = gate();
    const release = apiNode({ heldReplyChannels: [gatedAfterPolicyLock(held)] }).releaseHeldReply(scenario.teammate, scenario.target).then((response) => response);
    await held.reached;
    const change = downgradeToOperatorOnly(mailboxSettings(createPolicyChanges(database)), scenario);
    await lockWaiters(1);
    held.open();
    const [sent, changed] = await Promise.all([release, change]);

    expect(sent.status).toBe(201);
    const messageId = (sent.body as { messageId: string }).messageId;
    expect(changed).toMatchObject({ engagementMode: "operator_only" });
    expect(await policyVersionOf(scenario.mailbox.id)).toBe(versionBefore + 1);
    expect(await heldRepliesOf(scenario.conversationId)).toEqual([
      expect.objectContaining({ state: "released", superseded_reason: null, released_message_id: messageId }),
    ]);
    // Sent under the authority the release locked: the version before the change.
    expect(await emailSendsOf(scenario.conversationId)).toEqual([
      expect.objectContaining({
        idempotency_key: emailSendKey.message(messageId),
        payload: expect.objectContaining({ authority: expect.objectContaining({ policyVersion: versionBefore, mode: "draft" }) }),
      }),
    ]);
    await scenario.worker.dispatch();
    expect(await providerAcceptsUnder(spool.dir, emailSendKey.message(messageId))).toHaveLength(1);
    expect(await ownershipRowOf(scenario.conversationId)).toEqual(ownershipBefore);
  }, 60_000);

  it("takes its locks in the conversation lock protocol's order against a release, so the two queue on the conversation and never deadlock", async () => {
    const scenario = await pendingDraft();
    // A conversation with an ownership row: the release locks it before the mailbox.
    await database.execute(
      "INSERT INTO conversation_ownership (conversation_id, workspace_id, state, version) VALUES ($1, $2, 'ai_owned', 0)",
      [scenario.conversationId, scenario.workspaceId],
    );
    const versionBefore = await policyVersionOf(scenario.mailbox.id);
    const blocker = new Database(suite.url);
    apiDatabases.push(blocker);
    const policyLogger = { warn: vi.fn() };

    // A third transaction holds the draft's row, so the change stops once it holds everything else it locks.
    let unblock: () => void = () => undefined;
    const unblocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const blocking = blocker.kysely.transaction().execute(async (trx) => {
      await sql`SELECT id FROM held_replies WHERE id = ${scenario.heldReplyId} FOR UPDATE`.execute(trx);
      await unblocked;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const change = downgradeToOperatorOnly(mailboxSettings(createPolicyChanges(database, { logger: policyLogger })), scenario);
    await lockWaiters(1);
    const release = apiNode().releaseHeldReply(scenario.teammate, scenario.target).then((response) => response);
    await lockWaiters(2);

    const waiting = (await database.query<{ query: string }>(
      "SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    )).map((row) => row.query);
    unblock();
    const [, changed, refused] = await Promise.all([blocking, change, release]);

    // The release waited on the conversation the change locked first, not on the mailbox it held.
    expect(waiting).toEqual(expect.arrayContaining([expect.stringMatching(/from "conversations"/u)]));
    expect(waiting).not.toEqual(expect.arrayContaining([expect.stringMatching(/from "email_mailboxes"/u)]));

    expect(changed).toMatchObject({ engagementMode: "operator_only", policyVersion: versionBefore + 1 });
    expect(refused.status).toBe(409);
    expect((refused.body as RefusalBody).error.code).toBe("held_reply_not_pending");
    expect(policyLogger.warn).not.toHaveBeenCalled();
    expect(await heldRepliesOf(scenario.conversationId)).toEqual([
      expect.objectContaining({ state: "superseded", superseded_reason: "policy_changed" }),
    ]);
    expect(await ownershipRowOf(scenario.conversationId)).toMatchObject({ state: "human_owned", owner_user_id: null });
    expect(await emailSendsOf(scenario.conversationId)).toEqual([]);
  }, 60_000);

  it("supersedes a removed mailbox's pending draft and hands its conversation to a person, so nothing waits on a mailbox that cannot send (S6)", async () => {
    const scenario = await pendingDraft();

    await mailboxSettings(createPolicyChanges(database)).remove({ userId: scenario.teammate.userId }, scenario.workspaceId, scenario.mailbox.id);

    expect(await heldRepliesOf(scenario.conversationId)).toEqual([
      expect.objectContaining({ id: scenario.heldReplyId, state: "superseded", superseded_reason: "policy_changed" }),
    ]);
    expect(await database.queryOne("SELECT state, reason, owner_user_id FROM conversation_ownership WHERE conversation_id = $1", [scenario.conversationId]))
      .toEqual({ state: "human_owned", reason: "operator_only_mailbox", owner_user_id: null });
    const refused = await apiNode().releaseHeldReply(scenario.teammate, scenario.target);
    expect(refused.status).toBe(409);
    expect(await emailSendsOf(scenario.conversationId)).toEqual([]);
  }, 60_000);

  it("gives an unforced race between a release and a policy change exactly one winner", async () => {
    for (let trial = 0; trial < 3; trial += 1) {
      const scenario = await pendingDraft();
      const settings = mailboxSettings(createPolicyChanges(database));

      const [response] = await Promise.all([
        apiNode().releaseHeldReply(scenario.teammate, scenario.target).then((result) => result),
        downgradeToOperatorOnly(settings, scenario),
      ]);

      const [heldReply] = await heldRepliesOf(scenario.conversationId);
      const sends = await emailSendsOf(scenario.conversationId);
      if (response.status === 201) {
        expect(heldReply).toMatchObject({ state: "released", released_message_id: (response.body as { messageId: string }).messageId });
        expect(sends).toHaveLength(1);
      } else {
        expect(response.status).toBe(409);
        expect(["policy_changed", "held_reply_not_pending"]).toContain((response.body as RefusalBody).error.code);
        expect(heldReply).toMatchObject({ state: "superseded", superseded_reason: "policy_changed", released_message_id: null });
        expect(sends).toEqual([]);
      }
    }
  }, 120_000);

  it("sends every agent-authored release with Auto-Submitted: auto-generated, and an edited one without it (AS5.7, FR-034)", async () => {
    const edit = "Hi Alice, a teammate's own words about your invoice.";
    const releases = [
      { scenario: await pendingDraft(), editedText: null },
      { scenario: await pendingDraft(), editedText: null },
      { scenario: await pendingDraft(), editedText: edit },
    ];

    const sent: { text: string; autoSubmitted: string | null }[] = [];
    for (const { scenario, editedText } of releases) {
      const response = await apiNode().releaseHeldReply(scenario.teammate, scenario.target, editedText === null ? {} : { editedText });
      expect(response.status).toBe(201);
      const messageId = (response.body as { messageId: string }).messageId;
      await scenario.worker.dispatch();
      // The driver request the provider accepted for the release: one email, with its threading headers.
      const [accept, ...others] = await providerAcceptsUnder(spool.dir, emailSendKey.message(messageId));
      expect(others).toEqual([]);
      sent.push({ text: accept.message.text, autoSubmitted: accept.message.threading?.autoSubmitted ?? null });
    }

    expect(sent).toEqual([
      { text: expect.stringContaining(DRAFT_TEXT), autoSubmitted: "auto-generated" },
      { text: expect.stringContaining(DRAFT_TEXT), autoSubmitted: "auto-generated" },
      { text: expect.stringContaining(edit), autoSubmitted: null },
    ]);
  }, 90_000);

  it("never queues a send for a pending draft (SC-004)", async () => {
    const scenario = await pendingDraft();

    // Every worker stage runs, the outbox included: a pending draft is still not sent.
    expect(await scenario.worker.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 0 });
    await scenario.worker.dispatch();

    expect(await heldRepliesOf(scenario.conversationId)).toEqual([expect.objectContaining({ state: "pending" })]);
    expect(await emailSendsOf(scenario.conversationId)).toEqual([]);
    expect((await messagesOf(database, scenario.conversationId)).map((message) => message.role)).toEqual(["user"]);
    // Across every draft this database holds: no send intent and no queued email.send names a pending one.
    expect(await database.queryOne<{ intents: number; sends: number }>(
      `SELECT (SELECT count(*)::int FROM email_send_intents i JOIN held_replies h ON h.id = i.held_reply_id WHERE h.state = 'pending') AS intents,
              (SELECT count(*)::int FROM routine_action_requests r JOIN held_replies h ON h.id::text = r.payload->>'heldReplyId'
                WHERE r.type = $1 AND h.state = 'pending') AS sends`,
      [EMAIL_SEND_ACTION_TYPE],
    )).toEqual({ intents: 0, sends: 0 });
  }, 60_000);
});
