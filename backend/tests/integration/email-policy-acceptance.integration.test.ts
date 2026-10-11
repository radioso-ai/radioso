import type { ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { EMAIL_SEND_ACTION_TYPE } from "../../src/modules/emailChannel/public.js";
import type { Database } from "../../src/shared/infra/database.js";
import {
  changeMailboxPolicy,
  createEmailChannelDatabase,
  createSpool,
  createWorkerNode,
  customerMessagesOf,
  deliveryOfEmail,
  ownershipOf,
  postReceived,
  readFixture,
  relayAddressOf,
  seedSupportMailbox,
  type SeededMailbox,
} from "./support/emailChannelHarness.js";
import { counterValue, outboxActionsOf } from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// The policy in force when the webhook accepted mail caps what processing it later may do (FR-025,
// research B16): mail accepted under `draft` keeps `draft` through an upgrade to `auto`, and takes
// `operator_only` from a downgrade, whether the change lands before stage 1 runs or between stage 1
// and its review. The worker here runs every mode, so only the accepted policy stands between the
// mail and the more autonomous one.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const ALL_MODES = ["operator_only", "draft", "auto"] as const;
const FIRST = "mime/first-contact.eml";

type WorkerNode = ReturnType<typeof createWorkerNode>;
type ChangeLands = "before stage 1" | "between stage 1 and the review";

/** A draft an `auto` mailbox would publish: grounded, fully answered, no hand-off, no suppressed effect. */
const publishable = (input: ConnectorRespondInput): ConnectorTurnResult => ({
  kind: "draft",
  conversationId: input.conversationId,
  ownershipVersion: 0,
  facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, suppressedEffects: [], citationCount: 1 },
  draft: { text: "Your order ships on Monday.", presentation: { citations: [] } },
});

describeIntegration("policy effective at acceptance (Postgres, FR-025, research B16)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  const nodes: WorkerNode[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "policy_acceptance");
    database = suite.database;
    spool = await createSpool();
  }, 60_000);

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((node) => node.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await spool?.remove();
    await suite?.close();
  }, 30_000);

  /** A worker that runs every mode, and the review turns it ran. */
  const allModesWorker = () => {
    const turns: ConnectorRespondInput[] = [];
    const node = createWorkerNode(suite.url, {
      spoolDir: spool.dir,
      supportedModes: ALL_MODES,
      respond: async (input) => {
        turns.push(input);
        return publishable(input);
      },
    });
    nodes.push(node);
    return { node, turns };
  };

  /** Alice's first contact, accepted by the webhook while the mailbox is `draft` (policy version 1). */
  const acceptUnderDraft = async (node: WorkerNode) => {
    const { mailbox, agentId, domain } = await seedSupportMailbox(database, { engagementMode: "draft", withAgent: true });
    const emailId = await spool.put(await readFixture(FIRST, { relayToken: mailbox.relayToken, domain: domain.domain }));
    expect(await postReceived(await node.webhook(), { emailId, receivedFor: [relayAddressOf(mailbox)] })).toBe(200);
    return { mailbox, agentId, emailId };
  };

  /** Runs stage 1, then every review the mailbox has scheduled, due by the database's clock; returns the delivery. */
  const processAccepted = async (
    node: WorkerNode,
    accepted: { mailbox: SeededMailbox; emailId: string },
    changePolicy: () => Promise<void>,
    lands: ChangeLands,
  ) => {
    if (lands === "before stage 1") await changePolicy();
    expect(await node.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ processed: 1, errored: 0 });
    if (lands === "between stage 1 and the review") await changePolicy();
    await database.execute(
      "UPDATE email_thread_links SET review_due_at = now() - interval '1 second' WHERE mailbox_id = $1 AND review_due_at IS NOT NULL",
      [accepted.mailbox.id],
    );
    await node.worker.drain({ maxJobs: 5, stage: "review" });
    return deliveryOfEmail(database, accepted.emailId);
  };

  const heldRepliesOf = (conversationId: string) =>
    database.query<{ state: string; hold_reason: string }>(
      "SELECT state, hold_reason FROM held_replies WHERE conversation_id = $1 ORDER BY created_at, id",
      [conversationId],
    );

  const emailSendsOf = async (conversationId: string) =>
    (await outboxActionsOf(database, conversationId)).filter((action) => action.type === EMAIL_SEND_ACTION_TYPE);

  describe.each<ChangeLands>(["before stage 1", "between stage 1 and the review"])("with the change landing %s", (lands) => {
    it("runs mail accepted under draft as draft after an upgrade to auto", async () => {
      const { node, turns } = allModesWorker();
      const accepted = await acceptUnderDraft(node);
      const upgrade = () => changeMailboxPolicy(database, accepted.mailbox, { engagementMode: "auto", enabled: true, agentId: accepted.agentId });

      const delivery = await processAccepted(node, accepted, upgrade, lands);

      expect(delivery).toMatchObject({ accepted_policy_version: 1, disposition: "run_review_turn", disposition_reason: "accepted" });
      const conversationId = delivery.conversation_id ?? "";
      expect(turns).toEqual([expect.objectContaining({ conversationId, executionMode: "review" })]);
      // Decided under draft: a reply `auto` would publish is held for a teammate, and nothing is queued to send.
      expect(counterValue(node.metrics, "email_publication_decisions_total", { decision: "hold", reason: "draft_mode" })).toBe(1);
      expect(counterValue(node.metrics, "email_publication_decisions_total", { decision: "publish" })).toBe(0);
      expect(await heldRepliesOf(conversationId)).toEqual([{ state: "pending", hold_reason: "draft_mode" }]);
      expect(await emailSendsOf(conversationId)).toEqual([]);
      expect((await customerMessagesOf(database, conversationId)).map((message) => message.role)).toEqual(["user"]);
    }, 30_000);

    it("runs mail accepted under draft as operator_only after a downgrade", async () => {
      const { node, turns } = allModesWorker();
      const accepted = await acceptUnderDraft(node);
      const downgrade = () =>
        changeMailboxPolicy(database, accepted.mailbox, { engagementMode: "operator_only", enabled: true, agentId: accepted.agentId });

      const delivery = await processAccepted(node, accepted, downgrade, lands);

      expect(delivery.accepted_policy_version).toBe(1);
      // Stage 1 sees the downgrade only when it lands first; the review sees it either way.
      expect([delivery.disposition, delivery.disposition_reason]).toEqual(
        lands === "before stage 1" ? ["ingest_only", "operator_only_mailbox"] : ["run_review_turn", "accepted"],
      );
      const conversationId = delivery.conversation_id ?? "";
      expect(turns).toEqual([]);
      expect(await ownershipOf(database, conversationId)).toMatchObject({ state: "human_owned", reason: "operator_only_mailbox" });
      expect(await heldRepliesOf(conversationId)).toEqual([]);
      expect(await emailSendsOf(conversationId)).toEqual([]);
      expect((await customerMessagesOf(database, conversationId)).map((message) => message.role)).toEqual(["user"]);
    }, 30_000);
  });
});
