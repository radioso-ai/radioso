import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { buildContactDeliveryResolver } from "../../../src/app/composition/contactDelivery.js";
import { ActionRequestRepository } from "../../../src/db/repositories/actionRequestRepository.js";
import { EmailWebhookOperatorNotificationSink } from "../../../src/modules/chat/services/actions/emailWebhookSink.js";
import { ActionDispatcher, ActionHandlerRegistry } from "../../../src/modules/chat/services/actions/actionDispatcher.js";
import { RoutineEndingNotifyActionHandler } from "../../../src/modules/chat/services/actions/routineEndingNotifyActionHandler.js";
import { buildHandoffNotifyAction } from "../../../src/modules/chat/services/handoffOwnership.js";
import { ROUTINE_ENDING_NOTICE_ACTIONS } from "../../../src/modules/chat/services/operatorNoticeAction.js";
import { HANDOFF_NOTIFY_ACTION_TYPE } from "../../../src/modules/chat/services/routines/contactRoutine.js";
import type { ContactNotificationMailer } from "../../../src/modules/chat/services/actions/contactSendActionHandler.js";
import { OperatorNotificationDispatcher } from "../../../src/modules/operatorNotifications/public.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("handoff notify delivery through the action outbox (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const outbox = new ActionRequestRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const createdConversationIds: string[] = [];

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Handoff delivery test", `account-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Handoff delivery workspace", `handoff-delivery-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name, internal_name) VALUES ($1, $2, $3, $4)`,
      [agentId, workspaceId, "Handoff agent", "handoff-agent"],
    );
    await database.query(
      `INSERT INTO agent_skills
        (id, workspace_id, agent_id, skill_name, kind, target_type, target_id, config, invocation_mode, enabled)
       VALUES ($1, $2, $3, 'contact_human', 'notify', 'notify_delivery', NULL, $4::jsonb, 'routine_named', TRUE)`,
      [
        randomUUID(),
        workspaceId,
        agentId,
        JSON.stringify({ delivery: { recipientEmails: ["handoff-team@example.com"], webhook: null } }),
      ],
    );
  });

  afterEach(async () => {
    await database.query(`DELETE FROM routine_action_requests WHERE workspace_id = $1`, [workspaceId]);
    await database.query(`DELETE FROM conversations WHERE id = ANY($1::uuid[])`, [createdConversationIds.splice(0)]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const enqueueHandoff = async (): Promise<{ actionId: string; conversationId: string }> => {
    const conversationId = randomUUID();
    createdConversationIds.push(conversationId);
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id) VALUES ($1, $2, $3)`,
      [conversationId, workspaceId, agentId],
    );
    const action = buildHandoffNotifyAction({
      workspaceId,
      conversationId,
      agentId,
      userMessageId: randomUUID(),
      reason: "routine_handoff",
    });
    const { id: actionId } = await outbox.enqueue({
      ...action,
      workspaceId,
      accountId,
      conversationId,
      idempotencyKey: randomUUID(),
    });
    return { actionId, conversationId };
  };

  const dispatcherFor = (mailer: ContactNotificationMailer, maxAttempts = 5): ActionDispatcher => {
    const handler = new RoutineEndingNotifyActionHandler({
      ending: ROUTINE_ENDING_NOTICE_ACTIONS.handoff,
      dispatcher: new OperatorNotificationDispatcher([
        new EmailWebhookOperatorNotificationSink(mailer, buildContactDeliveryResolver(database)),
      ]),
      subjects: {
        resolve: async () => ({ agentId, agentName: "Handoff agent", routineName: null }),
      },
    });
    return new ActionDispatcher(
      outbox,
      new ActionHandlerRegistry([{ type: HANDOFF_NOTIFY_ACTION_TYPE, handler }]),
      { maxAttempts, retryBackoffSeconds: 0 },
    );
  };

  const actionOutcome = (actionId: string) => database.queryOne<{
    status: string;
    last_error: string | null;
  }>(`SELECT status, last_error FROM routine_action_requests WHERE id = $1`, [actionId]);

  it("delivers a contact_human hand-off to its configured recipient and records the action as dispatched", async () => {
    const sent: Array<{ to: string; subject: string }> = [];
    const { actionId } = await enqueueHandoff();

    await dispatcherFor({
      send: async (message) => {
        sent.push({ to: message.to, subject: message.subject });
        return { dispatched: true, driver: "capturing" };
      },
    }).dispatchPending();

    expect(sent).toEqual([{ to: "handoff-team@example.com", subject: "Conversation needs a human" }]);
    await expect(actionOutcome(actionId)).resolves.toEqual({ status: "dispatched", last_error: null });
  });

  it("records a mail-driver failure on the action instead of losing it", async () => {
    const { actionId } = await enqueueHandoff();

    await dispatcherFor({
      send: async () => {
        throw new Error("capturing mail driver rejected delivery");
      },
    }, 1).dispatchPending();

    await expect(actionOutcome(actionId)).resolves.toEqual({
      status: "failed",
      last_error: "Operator notification delivery failed",
    });
  });

  it("records the log driver as a skipped action rather than a delivered hand-off", async () => {
    const { actionId } = await enqueueHandoff();

    await dispatcherFor({
      send: async () => ({ dispatched: false, driver: "log" }),
    }).dispatchPending();

    await expect(actionOutcome(actionId)).resolves.toEqual({
      status: "skipped",
      last_error: "mail_not_dispatched:driver=log",
    });
  });
});
