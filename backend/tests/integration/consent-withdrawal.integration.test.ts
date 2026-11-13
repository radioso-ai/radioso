import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bindConsentMessageWithholding, createConsentWithdrawal } from "../../src/app/composition/consentWithdrawal.js";
import { createWorkspaceConversationDataErasure } from "../../src/app/composition/conversationErasure.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { ConsentRecordExporter, RoutineConsentRepository } from "../../src/db/repositories/routineConsentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { PostgresAssistantTurnPersistence } from "../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { Database } from "../../src/shared/infra/database.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";
import { CONSENT_ROUTINE_ID, classBooking, createRoutineConsentChatHarness } from "./support/routineConsentChatHarness.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const wording = {
  locale: "en",
  body: "We ask about your health to book the right session. Your answer stays with this booking.",
  agreeLabel: "I agree",
  declineLabel: "No thanks",
};

interface Seeded {
  accountId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  visitorId: string;
  recordId: string;
  carryingUserMessageId: string;
  carryingReplyId: string;
  otherSlotMessageId: string;
  plainMessageId: string;
  carryingImageId: string;
  /** Unmarked: the visitor named the value before any routine asked, and the reply repeated it. */
  beforeRoutineMessageId: string;
  beforeRoutineReplyId: string;
  /** Unmarked: a question after the routine ended, and the reply that repeated the value. */
  afterRoutineQuestionId: string;
  afterRoutineReplyId: string;
}

describeIntegration("consent withdrawal (Postgres, #1544)", () => {
  const database = new Database(integrationDatabaseUrl);
  const seededAccountIds: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const metrics = new MetricsRegistry();
  const logger = {
    debug: () => undefined,
    info: (fields: Record<string, unknown>) => void logged.push(fields),
    warn: () => undefined,
    error: (fields: Record<string, unknown>) => void logged.push(fields),
  };
  const auditLogged: string[] = [];
  const invalidations: Array<{ workspaceId: string; kinds: readonly string[] }> = [];
  const withdrawal = createConsentWithdrawal({
    db: database.kysely,
    logger,
    metricsRegistry: metrics,
    auditLog: { logRecorded: (event) => void auditLogged.push(event.eventType) },
    invalidation: {
      enqueue: (workspaceId, kinds) => {
        invalidations.push({ workspaceId, kinds });
        return { accepted: true, coalesced: false };
      },
    },
  });

  beforeAll(async () => {
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const accountId of seededAccountIds) {
      await lifecycle.deleteAccount({
        accountId,
        auditEvent: { accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
      });
    }
    await database.close().catch(() => undefined);
  });

  const insertMessage = async (seed: { workspaceId: string; conversationId: string }, input: {
    role: "user" | "assistant";
    content: string;
    metadata: Record<string, unknown>;
  }): Promise<string> => {
    const id = randomUUID();
    await database.query(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content, metadata_json, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())",
      [id, seed.conversationId, seed.workspaceId, input.role, input.content, JSON.stringify(input.metadata)],
    );
    return id;
  };

  /**
   * A finished class booking whose visitor granted the health consent and named an injury: the
   * routine state, the turn's two messages and every copy of them Radioso keeps, beside a message
   * that carries another slot and one that carries none.
   */
  const seed = async (decision: "granted" | "declined" = "granted"): Promise<Seeded> => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Withdrawal",
      email: `withdrawal-${randomUUID()}@classes.example`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Withdrawal");
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Classes')", [agentId, workspace.id]);
    const [visitor] = await database.query<{ id: string }>(
      "INSERT INTO visitors (workspace_id, visitor_key, conversation_count) VALUES ($1, $2, 1) RETURNING id",
      [workspace.id, `visitor-${randomUUID()}`],
    );
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, visitor_id, source_channel) VALUES ($1, $2, $3, $4, 'email')",
      [conversationId, workspace.id, agentId, visitor.id],
    );
    const base = { workspaceId: workspace.id, conversationId };

    // Retrieval answered these before any routine ran, so no turn marked them.
    const beforeRoutineMessageId = await insertMessage(base, { role: "user", content: "Do you run classes for a SORE\n knee?", metadata: {} });
    // The reply showed a picture card from the class guide beside its text.
    const beforeRoutineReplyId = await insertMessage(base, {
      role: "assistant",
      content: "Yes, we adapt classes for a sore knee.",
      metadata: {
        blocks: [{
          type: "item_list",
          id: "b1",
          layout: "carousel",
          selection: "none",
          caption: "Classes for a sore knee",
          items: [{
            key: "image-1",
            title: "Gentle mobility class",
            image: { imageId: "image-1", width: 1280, height: 960, alt: "A knee brace on a mat" },
            actions: [],
          }],
        }],
      },
    });
    const plainMessageId = await insertMessage(base, { role: "user", content: "I want to book a class", metadata: {} });
    const carryingImageId = randomUUID();
    const carryingUserMessageId = await insertMessage(base, {
      role: "user",
      content: "I have a sore knee",
      metadata: {
        method: "typed",
        sensitiveSlotKeys: ["injury"],
        imageInput: { typedText: "I have a sore knee", images: [{ id: carryingImageId, reading: "A knee brace." }] },
      },
    });
    const carryingReplyId = await insertMessage(base, {
      role: "assistant",
      content: "Thanks, I noted the sore knee. When would you like to come?",
      metadata: {
        sensitiveSlotKeys: ["injury"],
        skillTurn: { skillName: "routine", outcome: "routine_step" },
        answerSegments: [{ text: "Thanks, I noted the sore knee." }],
        composedInstructions: "The visitor said: sore knee",
      },
    });
    const otherSlotMessageId = await insertMessage(base, {
      role: "user",
      content: "My date of birth is 1 May 1990",
      metadata: { sensitiveSlotKeys: ["birth_date"] },
    });
    // After the routine ended: no transition saved, so the turn marked neither message.
    const afterRoutineQuestionId = await insertMessage(base, { role: "user", content: "What did I tell you?", metadata: {} });
    const afterRoutineReplyId = await insertMessage(base, {
      role: "assistant",
      content: "You told me about your sore knee.",
      metadata: { answerSegments: [{ text: "You told me about your sore knee." }] },
    });

    const repository = new RoutineConsentRepository(database.kysely);
    const wordingVersionId = await repository.upsertWordingVersion({ workspaceId: workspace.id, wording });
    await repository.insertRecord({
      workspaceId: workspace.id,
      agentId,
      conversationId,
      visitorId: visitor.id,
      routineId: CONSENT_ROUTINE_ID,
      consentKey: "health",
      slotKeys: ["injury"],
      wordingVersionId,
      locale: "en",
      decision,
      method: "reply",
      defaulted: false,
      channel: "email",
      decisionMessageId: plainMessageId,
    });
    const [record] = await database.query<{ id: string }>("SELECT id FROM routine_consent_records WHERE conversation_id = $1", [conversationId]);
    await database.query(
      `INSERT INTO routine_states (session_id, routine_id, path, variables, status)
       VALUES ($1, $2, ARRAY['ask_name', 'ask_injury', 'done'], '{"name": "Ada", "injury": "sore knee", "time": "Tuesday"}'::jsonb, 'completed')`,
      [conversationId, CONSENT_ROUTINE_ID],
    );

    // The summary and title the worker wrote from the transcript, before any routine asked.
    await database.query(
      `INSERT INTO conversation_summaries (session_id, summary, covered_message_count, covered_through, expires_at)
       VALUES ($1, 'The visitor asked about classes for a sore knee.', 4, now(), now() + interval '1 day')`,
      [conversationId],
    );
    await database.query("UPDATE conversations SET title = 'Classes for a sore knee' WHERE id = $1", [conversationId]);

    // The copies: a facet, the inbound mail, the turn's audit, its coverage assessment, the photo.
    for (const messageId of [carryingUserMessageId, plainMessageId]) {
      await database.query(
        "INSERT INTO message_facets (message_id, workspace_id, facet_text, prompt_version) VALUES ($1, $2, 'A visitor with a sore knee', 'v1')",
        [messageId, workspace.id],
      );
    }
    for (const [messageId, body] of [[carryingUserMessageId, "I have a sore knee"], [plainMessageId, "I want to book a class"]] as const) {
      const [event] = await database.query<{ id: string }>(
        `INSERT INTO email_inbound_events (provider, provider_event_id, event_kind, envelope, state)
         VALUES ('local', $1, 'message_received', '{"from": "ada@classes.example"}'::jsonb, 'processed') RETURNING id`,
        [`evt-${randomUUID()}`],
      );
      await database.query(
        `INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, state, sender_address, subject, body_text, raw_mime, conversation_id, message_id)
         VALUES ($1, $2, 'done', 'ada@classes.example', 'Booking', $3, $4, $5, $6)`,
        [event.id, workspace.id, body, Buffer.from(`Subject: Booking\r\n\r\n${body}`), conversationId, messageId],
      );
    }
    await database.query(
      `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json) VALUES
         ($1, $3, $4, 'chat.answer', 'success', jsonb_build_object('conversationId', $5::text, 'userMessageId', $6::text, 'assistantMessageId', $7::text, 'answerSegments', '[{"text": "Thanks, I noted the sore knee."}]'::jsonb)),
         ($2, $3, $4, 'chat.answer', 'success', jsonb_build_object('conversationId', $5::text, 'userMessageId', $8::text, 'assistantMessageId', $8::text))`,
      [randomUUID(), randomUUID(), account.id, workspace.id, conversationId, carryingUserMessageId, carryingReplyId, plainMessageId],
    );
    // The question after the routine ended states no value; the request its coverage framed does.
    await database.query(
      `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json) VALUES
         ($1, $2, $3, 'chat.answer', 'success', jsonb_build_object('conversationId', $4::text, 'userMessageId', $5::text, 'assistantMessageId', $5::text, 'rewrittenQuery', 'classes for a sore knee'))`,
      [randomUUID(), account.id, workspace.id, conversationId, afterRoutineQuestionId],
    );
    await database.query(
      `INSERT INTO answer_coverage_assessments (id, workspace_id, conversation_id, request_message_id, originating_turn_id, contextualized_request, availability, schema_version)
       VALUES ($1, $2, $3, $4, $4, 'user: I have a sore knee', 'not_recorded', 1),
              ($5, $2, $3, $6, $6, 'user: Do you run classes for a sore knee? user: What did I tell you?', 'not_recorded', 1),
              ($7, $2, $3, $8, $8, 'user: I want to book a class', 'not_recorded', 1)`,
      [randomUUID(), workspace.id, conversationId, carryingUserMessageId, randomUUID(), afterRoutineQuestionId, randomUUID(), plainMessageId],
    );
    await database.query(
      `INSERT INTO visitor_images (id, workspace_id, agent_id, owner_kind, owner_id, conversation_id, message_id, storage_bucket, storage_object_path,
                                   byte_size, width, height, sha256, reading_status, reading, bound_at)
       VALUES ($1, $2, $3, 'public_session', $4, $5, $6, 'local', $7, 1024, 800, 600, $8, 'read', 'A knee brace.', now())`,
      [carryingImageId, workspace.id, agentId, randomUUID(), conversationId, carryingUserMessageId, `workspaces/${workspace.id}/visitor-images/${carryingImageId}`, "a".repeat(64)],
    );

    return {
      accountId: account.id,
      userId: randomUUID(),
      workspaceId: workspace.id,
      agentId,
      conversationId,
      visitorId: visitor.id,
      recordId: record.id,
      carryingUserMessageId,
      carryingReplyId,
      otherSlotMessageId,
      plainMessageId,
      carryingImageId,
      beforeRoutineMessageId,
      beforeRoutineReplyId,
      afterRoutineQuestionId,
      afterRoutineReplyId,
    };
  };

  const withdraw = (seeded: Seeded, recordId = seeded.recordId) => withdrawal.withdraw({
    workspaceId: seeded.workspaceId,
    conversationId: seeded.conversationId,
    recordId,
    actor: { accountId: seeded.accountId, userId: seeded.userId },
  });

  const message = async (id: string) => (await database.query<{ content: string; metadata_json: Record<string, unknown> }>(
    "SELECT content, metadata_json FROM messages WHERE id = $1",
    [id],
  ))[0];

  const routineVariables = async (conversationId: string) => (await database.query<{ variables: Record<string, unknown>; status: string }>(
    "SELECT variables, status FROM routine_states WHERE session_id = $1",
    [conversationId],
  ))[0];

  describe("a granted consent", () => {
    let seeded: Seeded;
    let withdrawnAt: Date | null = null;

    beforeAll(async () => {
      seeded = await seed();
      const outcome = await withdraw(seeded);
      if (outcome.kind !== "withdrawn") throw new Error(`expected a withdrawal, got ${outcome.kind}`);
      withdrawnAt = outcome.consent.withdrawnAt;
    });

    it("erases the covered values from the routine state, a completed run's included", async () => {
      expect(await routineVariables(seeded.conversationId)).toEqual({ variables: { name: "Ada", time: "Tuesday" }, status: "completed" });
    });

    it("overwrites the messages that carried them with the redaction marker and marks them withheld", async () => {
      const at = withdrawnAt!.toISOString();
      const visitorMessage = await message(seeded.carryingUserMessageId);
      expect(visitorMessage.content).toBe("[redacted]");
      expect(visitorMessage.metadata_json).toEqual({ method: "typed", sensitiveSlotKeys: ["injury"], withheld: { reason: "consent_withdrawn", at } });
      const reply = await message(seeded.carryingReplyId);
      expect(reply.content).toBe("[redacted]");
      expect(reply.metadata_json).toEqual({
        sensitiveSlotKeys: ["injury"],
        skillTurn: { skillName: "routine", outcome: "routine_step" },
        withheld: { reason: "consent_withdrawn", at },
      });
      // A message that carried another slot, or none, keeps its text.
      expect((await message(seeded.otherSlotMessageId)).content).toBe("My date of birth is 1 May 1990");
      expect((await message(seeded.plainMessageId)).content).toBe("I want to book a class");
      expect((await message(seeded.afterRoutineQuestionId)).content).toBe("What did I tell you?");
    });

    it("withholds the messages that state an erased value though no turn marked them, before the routine and after it, picture cards included", async () => {
      const at = withdrawnAt!.toISOString();
      for (const id of [seeded.beforeRoutineMessageId, seeded.beforeRoutineReplyId]) {
        expect(await message(id)).toEqual({ content: "[redacted]", metadata_json: { withheld: { reason: "consent_withdrawn", at } } });
      }
      expect(await message(seeded.afterRoutineReplyId)).toEqual({ content: "[redacted]", metadata_json: { withheld: { reason: "consent_withdrawn", at } } });
    });

    it("clears the summary and title written from the transcript, and queues them to be written again from it", async () => {
      expect(await database.query("SELECT summary FROM conversation_summaries WHERE session_id = $1", [seeded.conversationId])).toEqual([]);
      expect(await database.query("SELECT title FROM conversations WHERE id = $1", [seeded.conversationId])).toEqual([{ title: null }]);
      const refreshes = await database.query<{ payload: { conversationId: string } }>(
        "SELECT payload FROM background_jobs WHERE kind = 'conversation.summary_refresh' AND idempotency_key = $1",
        [seeded.conversationId],
      );
      expect(refreshes).toEqual([{ payload: { workspaceId: seeded.workspaceId, conversationId: seeded.conversationId } }]);
    });

    it("tells the operator views listing the conversation to re-read it", () => {
      expect(invalidations).toContainEqual({ workspaceId: seeded.workspaceId, kinds: ["conversation.turn_committed"] });
    });

    it("drops the withheld message's facet and keeps the others", async () => {
      const facets = await database.query<{ message_id: string }>(
        "SELECT message_id FROM message_facets WHERE workspace_id = $1",
        [seeded.workspaceId],
      );
      expect(facets.map((facet) => facet.message_id)).toEqual([seeded.plainMessageId]);
    });

    it("withholds the email channel's copy of the mail, raw MIME included", async () => {
      const deliveries = await database.query<{ message_id: string; body_text: string | null; raw_mime: Buffer | null; subject: string | null }>(
        "SELECT message_id, body_text, raw_mime, subject FROM email_inbound_deliveries WHERE workspace_id = $1 ORDER BY body_text",
        [seeded.workspaceId],
      );
      expect(deliveries.map(({ message_id, body_text, raw_mime }) => ({ message_id, body_text, raw: raw_mime?.toString() ?? null }))).toEqual([
        { message_id: seeded.plainMessageId, body_text: "I want to book a class", raw: "Subject: Booking\r\n\r\nI want to book a class" },
        { message_id: seeded.carryingUserMessageId, body_text: "[redacted]", raw: null },
      ]);
    });

    it("removes the turn's content audit, its coverage text and the photo the message carried", async () => {
      const turnAudits = await database.query<{ user_message_id: string }>(
        "SELECT metadata_json->>'userMessageId' AS user_message_id FROM audit_events WHERE workspace_id = $1 AND event_type = 'chat.answer'",
        [seeded.workspaceId],
      );
      // The after-routine turn's audit goes for the value its own text held.
      expect(turnAudits.map((audit) => audit.user_message_id)).toEqual([seeded.plainMessageId]);
      const assessments = await database.query<{ request_message_id: string; contextualized_request: string }>(
        "SELECT request_message_id, contextualized_request FROM answer_coverage_assessments WHERE conversation_id = $1",
        [seeded.conversationId],
      );
      // The after-routine request goes for the earlier turn's words its framing restated.
      expect(Object.fromEntries(assessments.map((row) => [row.request_message_id, row.contextualized_request]))).toEqual({
        [seeded.carryingUserMessageId]: "[redacted]",
        [seeded.afterRoutineQuestionId]: "[redacted]",
        [seeded.plainMessageId]: "user: I want to book a class",
      });
      expect(await database.query("SELECT id FROM visitor_images WHERE id = $1", [seeded.carryingImageId])).toEqual([]);
      const deletionJobs = await database.query<{ payload: { objects: Array<{ objectPath: string }> } }>(
        "SELECT payload FROM background_jobs WHERE kind = 'visitor_images.object_deletion'",
      );
      expect(deletionJobs.flatMap((job) => job.payload.objects.map((object) => object.objectPath)))
        .toContain(`workspaces/${seeded.workspaceId}/visitor-images/${seeded.carryingImageId}`);
    });

    it("marks the record withdrawn by the acting member and keeps its proof", async () => {
      const [record] = await database.query<{ decision: string; withdrawn_at: Date | null; withdrawn_by_account_id: string; withdrawn_by_user_id: string }>(
        "SELECT decision, withdrawn_at, withdrawn_by_account_id, withdrawn_by_user_id FROM routine_consent_records WHERE id = $1",
        [seeded.recordId],
      );
      expect(record).toEqual({ decision: "granted", withdrawn_at: withdrawnAt, withdrawn_by_account_id: seeded.accountId, withdrawn_by_user_id: seeded.userId });
      expect(await withdrawal.list({ workspaceId: seeded.workspaceId, conversationId: seeded.conversationId })).toEqual([
        expect.objectContaining({ id: seeded.recordId, decision: "granted", withdrawnAt, wording: { body: wording.body, agreeLabel: wording.agreeLabel, declineLabel: wording.declineLabel } }),
      ]);
    });

    it("writes one audit event with ids alone, and logs and counts the withdrawal", async () => {
      const audits = await database.query<{ account_id: string; metadata_json: Record<string, unknown> }>(
        "SELECT account_id, metadata_json FROM audit_events WHERE workspace_id = $1 AND event_type = 'routine_consent.withdrawn'",
        [seeded.workspaceId],
      );
      expect(audits).toEqual([{
        account_id: seeded.accountId,
        metadata_json: expect.objectContaining({
          actorUserId: seeded.userId,
          conversationId: seeded.conversationId,
          routineId: CONSENT_ROUTINE_ID,
          consentKey: "health",
          recordId: seeded.recordId,
          withheldMessageCount: 5,
          rowsByOwner: { "audit": 2, "answer-coverage": 2, "email-channel": 1, "visitor-images": 1, "conversation-summary": 2 },
        }),
      }]);
      expect(JSON.stringify(audits)).not.toContain("sore knee");
      expect(auditLogged).toContain("routine_consent.withdrawn");
      const withdrawnLog = logged.find((fields) => fields.event === "routine_consent_withdrawn" && fields.conversationId === seeded.conversationId);
      expect(withdrawnLog).toMatchObject({ workspaceId: seeded.workspaceId, routineId: CONSENT_ROUTINE_ID, consentKey: "health", recordId: seeded.recordId, withheldMessageCount: 5 });
      expect(JSON.stringify(withdrawnLog)).not.toContain("sore knee");
      expect(metrics.renderPrometheus()).toMatch(/routine_consent_outcomes_total\{outcome="withdrawn"\} [1-9]/);
    });

    it("lists the record as withdrawn in the data subject's export", async () => {
      const exported = await new ConsentRecordExporter(database.kysely).export({
        workspaceId: seeded.workspaceId,
        conversationIds: [seeded.conversationId],
        visitorIds: [],
        verifiedCustomerIds: [],
      });
      expect(exported).toEqual([expect.objectContaining({ id: seeded.recordId, decision: "granted", withdrawnAt: withdrawnAt!.toISOString() })]);
    });

    it("refuses a second withdrawal and changes nothing more", async () => {
      const outcome = await withdraw(seeded);
      expect(outcome).toEqual({ kind: "not_withdrawable", reason: "already_withdrawn", consent: expect.objectContaining({ id: seeded.recordId, withdrawnAt }) });
      const audits = await database.query(
        "SELECT id FROM audit_events WHERE workspace_id = $1 AND event_type = 'routine_consent.withdrawn'",
        [seeded.workspaceId],
      );
      expect(audits).toHaveLength(1);
    });

    it("keeps the erased value out of the state a turn still running saves", async () => {
      // The turn read the value before the withdrawal committed and saves it after.
      await new PostgresAssistantTurnPersistence(database.kysely, new ConversationActivityRepository(database.kysely), 60_000).completeAssistantTurn({
        workspaceId: seeded.workspaceId,
        conversationId: seeded.conversationId,
        routineStateTransition: {
          kind: "save",
          state: {
            sessionId: seeded.conversationId,
            routineId: CONSENT_ROUTINE_ID,
            path: ["ask_name", "ask_injury", "ask_time"],
            variables: { name: "Ada", injury: "sore knee" },
            status: "active",
          },
        },
        assistantMessage: { conversationId: seeded.conversationId, workspaceId: seeded.workspaceId, role: "assistant", content: "When would you like to come?" },
        auditEvent: { workspaceId: seeded.workspaceId, eventType: "chat.answer", eventStatus: "success", metadata: {} },
      });
      expect((await routineVariables(seeded.conversationId))?.variables).toEqual({ name: "Ada" });
    });

    it("withholds what a turn that raced the withdrawal writes: a marked reply, and a visitor message stating the value its state held", async () => {
      // The turn read the value before the withdrawal committed, and commits after it.
      const visitorMessageId = await insertMessage(seeded, { role: "user", content: "Actually my sore knee is a bit better", metadata: {} });
      await database.query(
        `INSERT INTO answer_coverage_assessments (id, workspace_id, conversation_id, request_message_id, originating_turn_id, contextualized_request, availability, schema_version)
         VALUES ($1, $2, $3, $4, $4, 'user: Actually my sore knee is a bit better', 'not_recorded', 1)`,
        [randomUUID(), seeded.workspaceId, seeded.conversationId, visitorMessageId],
      );
      const persistence = new PostgresAssistantTurnPersistence(
        database.kysely,
        new ConversationActivityRepository(database.kysely),
        60_000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        bindConsentMessageWithholding,
      );
      const receipt = await persistence.completeAssistantTurn({
        workspaceId: seeded.workspaceId,
        conversationId: seeded.conversationId,
        visitorMessageId,
        answerCoverageRequestMessageId: visitorMessageId,
        routineStateTransition: {
          kind: "save",
          state: {
            sessionId: seeded.conversationId,
            routineId: CONSENT_ROUTINE_ID,
            path: ["ask_name", "ask_injury", "ask_time"],
            variables: { name: "Ada", injury: "sore knee" },
            status: "active",
          },
        },
        sensitiveVisitorMessage: { id: visitorMessageId, sensitiveSlotKeys: ["injury"] },
        assistantMessage: {
          conversationId: seeded.conversationId,
          workspaceId: seeded.workspaceId,
          role: "assistant",
          content: "Glad the knee is better. When would you like to come?",
          metadata: { sensitiveSlotKeys: ["injury"], answerSegments: [{ text: "Glad the knee is better." }] },
        },
        auditEvent: {
          workspaceId: seeded.workspaceId,
          eventType: "chat.answer",
          eventStatus: "success",
          metadata: { conversationId: seeded.conversationId, userMessageId: visitorMessageId },
        },
      });

      const at = withdrawnAt!.toISOString();
      expect(await message(visitorMessageId)).toEqual({ content: "[redacted]", metadata_json: { sensitiveSlotKeys: ["injury"], withheld: { reason: "consent_withdrawn", at } } });
      expect(await message(receipt.message.id)).toEqual({ content: "[redacted]", metadata_json: { sensitiveSlotKeys: ["injury"], withheld: { reason: "consent_withdrawn", at } } });
      expect(receipt.message.content).toBe("[redacted]");
      // Its copies go as the withdrawal's own do: the turn's content audit and its coverage text.
      expect(await database.query(
        "SELECT id FROM audit_events WHERE workspace_id = $1 AND event_type = 'chat.answer' AND metadata_json->>'userMessageId' = $2",
        [seeded.workspaceId, visitorMessageId],
      )).toEqual([]);
      expect(await database.query(
        "SELECT contextualized_request FROM answer_coverage_assessments WHERE request_message_id = $1",
        [visitorMessageId],
      )).toEqual([{ contextualized_request: "[redacted]" }]);
      expect((await routineVariables(seeded.conversationId))?.variables).toEqual({ name: "Ada" });
    });

    it("leaves a turn after the withdrawal alone when it carries none of the withdrawn values", async () => {
      const visitorMessageId = await insertMessage(seeded, { role: "user", content: "Tuesday works", metadata: {} });
      const receipt = await new PostgresAssistantTurnPersistence(
        database.kysely,
        new ConversationActivityRepository(database.kysely),
        60_000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        bindConsentMessageWithholding,
      ).completeAssistantTurn({
        workspaceId: seeded.workspaceId,
        conversationId: seeded.conversationId,
        visitorMessageId,
        routineStateTransition: {
          kind: "save",
          state: {
            sessionId: seeded.conversationId,
            routineId: CONSENT_ROUTINE_ID,
            path: ["ask_name", "ask_injury", "ask_time", "done"],
            variables: { name: "Ada", time: "Tuesday" },
            status: "completed",
          },
        },
        assistantMessage: { conversationId: seeded.conversationId, workspaceId: seeded.workspaceId, role: "assistant", content: "Booked for Tuesday." },
        auditEvent: { workspaceId: seeded.workspaceId, eventType: "chat.answer", eventStatus: "success", metadata: {} },
      });
      expect((await message(visitorMessageId)).content).toBe("Tuesday works");
      expect((await message(receipt.message.id)).content).toBe("Booked for Tuesday.");
    });
  });

  it("refuses a declined consent and changes nothing", async () => {
    const seeded = await seed("declined");

    const outcome = await withdraw(seeded);

    expect(outcome).toEqual({ kind: "not_withdrawable", reason: "declined", consent: expect.objectContaining({ id: seeded.recordId, decision: "declined", withdrawnAt: null }) });
    expect((await routineVariables(seeded.conversationId))?.variables).toEqual({ name: "Ada", injury: "sore knee", time: "Tuesday" });
    expect((await message(seeded.carryingUserMessageId)).content).toBe("I have a sore knee");
  });

  it("answers not found for a record of another conversation or workspace", async () => {
    const seeded = await seed();
    const other = await seed();

    expect(await withdraw(seeded, other.recordId)).toEqual({ kind: "not_found" });
    expect(await withdrawal.withdraw({
      workspaceId: other.workspaceId,
      conversationId: seeded.conversationId,
      recordId: seeded.recordId,
      actor: { accountId: other.accountId, userId: null },
    })).toEqual({ kind: "not_found" });
    expect(await withdrawal.list({ workspaceId: other.workspaceId, conversationId: seeded.conversationId })).toEqual([]);
  });
});

describeIntegration("a routine still running after consent is withdrawn (Postgres, #1544)", () => {
  const database = new Database(integrationDatabaseUrl);
  const prompts: string[] = [];
  const slotValues: Record<string, Record<string, string>> = {
    "My name is Ada": { name: "Ada" },
    "I have a sore knee": { injury: "sore knee" },
    "Tuesday at 10": { time: "Tuesday at 10" },
  };
  // A question retrieval answers before the visitor asks to book; no routine starts for it.
  const BEFORE_ROUTINE = "Do you run classes for a sore knee?";
  // Confirms what the visitor said before the consent, which only the earlier-message rule can read.
  const CONFIRMS_EARLIER = "Yes, the one I mentioned";
  const AFTER_ROUTINE = "What did I tell you?";
  const model: ChatGateway = {
    async answer(input) {
      const prompt = input.systemPrompt ?? "";
      prompts.push(`${prompt}\n${input.query}`);
      if (prompt.includes("wants to start any registered routine")) {
        return JSON.stringify({ matches: input.query === BEFORE_ROUTINE ? [] : [{ routineId: CONSENT_ROUTINE_ID, confidence: 0.95, variables: {} }] });
      }
      if (prompt.includes("A person was just shown the consent request")) {
        return JSON.stringify({ decision: input.query === "Yes, I agree" ? "granted" : "unclear" });
      }
      if (prompt.includes("claimsAuthority") || prompt.includes("Declared slots")) {
        const earlier = input.query === CONFIRMS_EARLIER && prompt.includes("said earlier in this conversation") ? { injury: "sore knee" } : {};
        return JSON.stringify({ variables: { ...slotValues[input.query], ...earlier }, claimsAuthority: false, condition: null, offTopic: false });
      }
      if (input.query === AFTER_ROUTINE) {
        return "You told me about your sore knee.";
      }
      return `[step reply to: ${input.query}]`;
    },
    async *streamAnswer() {
      throw new Error("consent turns run the non-streaming path");
    },
  };
  const harness = createRoutineConsentChatHarness(database, model);
  const withdrawal = createConsentWithdrawal({
    db: database.kysely,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    metricsRegistry: null,
    auditLog: {},
    invalidation: { enqueue: () => ({ accepted: true, coalesced: false }) },
  });

  beforeAll(async () => {
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await harness.cleanup();
    await database.close().catch(() => undefined);
  });

  it("neither asks consent again nor uses the erased value on a later turn", async () => {
    const conversation = await harness.startConversation({ definition: classBooking("continue", { askTime: true }) });
    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");
    await conversation.send("Yes, I agree");
    await conversation.send("I have a sore knee");
    expect(await conversation.routineState()).toMatchObject({ status: "active", variables: { name: "Ada", injury: "sore knee" } });
    const [record] = await conversation.records();

    const outcome = await withdrawal.withdraw({
      workspaceId: conversation.workspaceId,
      conversationId: conversation.conversationId,
      recordId: record.id,
      actor: { accountId: conversation.accountId, userId: null },
    });
    expect(outcome.kind).toBe("withdrawn");
    const before = (await conversation.messages()).length;
    prompts.length = 0;

    await conversation.send("Tuesday at 10");

    const after = (await conversation.messages()).slice(before);
    expect(after.some((message) => message.metadata_json?.consentPrompt)).toBe(false);
    expect(await conversation.routineState()).toMatchObject({ status: "completed", variables: { name: "Ada", time: "Tuesday at 10" } });
    expect((await conversation.routineState())?.variables).not.toHaveProperty("injury");
    expect(prompts.join("\n")).not.toContain("sore knee");
    // The messages that carried the value read as withheld, in the database and in the history a dashboard reads.
    expect((await conversation.messages()).filter((message) => message.content.includes("sore knee"))).toEqual([]);
    const history = await conversation.reloaded();
    const withheld = history.filter((message) => message.withheld);
    // The grant's turn and the injury's turn: each visitor message and the reply to it.
    expect(withheld.map((message) => ({ role: message.role, content: message.content, reason: message.withheld?.reason }))).toEqual([
      { role: "user", content: "[redacted]", reason: "consent_withdrawn" },
      { role: "assistant", content: "[redacted]", reason: "consent_withdrawn" },
      { role: "user", content: "[redacted]", reason: "consent_withdrawn" },
      { role: "assistant", content: "[redacted]", reason: "consent_withdrawn" },
    ]);
    expect(history.find((message) => message.content === "My name is Ada")?.withheld).toBeUndefined();
  });

  it("marks what the visitor said before the consent once the step takes the value from it, and withholds it with every reply that repeated it", async () => {
    const conversation = await harness.startConversation({ definition: classBooking("continue") });
    await conversation.send(BEFORE_ROUTINE);
    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");
    await conversation.send("Yes, I agree");
    await conversation.send(CONFIRMS_EARLIER);
    expect(await conversation.routineState()).toMatchObject({ status: "completed", variables: { name: "Ada", injury: "sore knee" } });

    // Marked when the step read the value from it, so summaries, facets and evals withhold it from then on.
    const byContent = async () => new Map((await conversation.messages()).map((message) => [message.content, message]));
    const before = (await byContent()).get(BEFORE_ROUTINE);
    expect(before?.metadata_json).toMatchObject({ sensitiveSlotKeys: ["injury"] });
    // Only the message that stated it: the booking request and the name stay unmarked. (The grant
    // answered the consent, so its own turn marked it.)
    for (const content of ["I want to book a class", "My name is Ada"]) {
      expect((await byContent()).get(content)?.metadata_json?.sensitiveSlotKeys).toBeUndefined();
    }

    // After the routine ended, a reply repeats the value; no routine saved, so no turn marked it.
    await conversation.send(AFTER_ROUTINE);
    expect((await byContent()).get("You told me about your sore knee.")?.metadata_json?.sensitiveSlotKeys).toBeUndefined();

    const [record] = await conversation.records();
    const outcome = await withdrawal.withdraw({
      workspaceId: conversation.workspaceId,
      conversationId: conversation.conversationId,
      recordId: record.id,
      actor: { accountId: conversation.accountId, userId: null },
    });
    expect(outcome.kind).toBe("withdrawn");

    const remaining = await conversation.messages();
    expect(remaining.filter((message) => message.content.toLowerCase().includes("sore knee"))).toEqual([]);
    const history = await conversation.reloaded();
    expect(history.find((message) => message.id === before?.id)).toMatchObject({ content: "[redacted]", withheld: { reason: "consent_withdrawn" } });
    for (const content of ["I want to book a class", "My name is Ada", AFTER_ROUTINE]) {
      expect(history.find((message) => message.content === content)?.withheld).toBeUndefined();
    }
  });
});
