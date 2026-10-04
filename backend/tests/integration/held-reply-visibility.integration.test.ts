import { randomUUID } from "node:crypto";

import type { ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { afterAll, beforeAll, expect, it } from "vitest";

import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { AgentRevisionRuntimeRepository } from "../../src/db/repositories/agentRevisionRuntimeRepository.js";
import { AuditEventRepository } from "../../src/db/repositories/auditEventRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { ConversationSummaryRepository } from "../../src/db/repositories/conversationSummaryRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentRevisionRuntimeResolver } from "../../src/modules/agents/runtime/agentRevisionRuntimeResolver.js";
import { AgentService } from "../../src/modules/agents/services/agentService.js";
import { AuditService } from "../../src/modules/audit/services/auditService.js";
import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { reviewedTurnAuditEvent } from "../../src/modules/chat/services/reviewDraft.js";
import { ConversationSummaryService } from "../../src/modules/chat/services/summary/conversationSummaryService.js";
import { createChatCopilotTools } from "../../src/modules/operatorCopilot/tools/chat.js";
import type { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import {
  createEmailChannelDatabase,
  createSpool,
  createWorkerNode,
  postReceived,
  readFixture,
  relayAddressOf,
} from "./support/emailChannelHarness.js";
import { createApiNode, openEmailConversation, replyFromInbox } from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Research B9, FR-027, SC-004 against Postgres: a held reply is operator-only. Its text, in every
// state a teammate has not sent it from — pending, discarded, superseded — never reaches a surface
// a customer, a model turn or a conversation reader sees: the message rows and their readers, the
// conversation history and its API, the public conversation events, the next review's model
// context, conversation summaries, and Ray's transcript. Each review here also records the audit
// row a real review turn records, which does carry the draft, so the suite proves the readers
// exclude it rather than never meeting it.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const DRAFTING = ["operator_only", "draft"] as const;
const FOLLOW_UP = "mime/pre-reply-follow-up.eml";
/** A phrase of Alice's first message: every surface that shows the conversation shows it. */
const CUSTOMER_PHRASE = "update my billing address";

const HELD_STATES = ["discarded", "superseded", "pending"] as const;
type HeldState = (typeof HELD_STATES)[number];

const directOnlyRetrievalTurn = () =>
  new RetrievalTurnController({
    async interpret() {
      throw new Error("retrieval is not prepared for the review's context here");
    },
    async runInterpreted() {
      throw new Error("retrieval is not prepared for the review's context here");
    },
    async runWithoutRetrieval() {
      throw new Error("retrieval is not prepared for the review's context here");
    },
  } as never);

describeIntegration("held reply visibility (Postgres, research B9)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  let api: ReturnType<typeof createApiNode>;
  let worker: ReturnType<typeof createWorkerNode>;
  let scenario: Awaited<ReturnType<typeof openEmailConversation>>;

  /** One draft text per state, unique to this run, in the order the reviews write them. */
  const heldText: Record<HeldState, string> = {
    discarded: `Held draft, later discarded ${randomUUID()}`,
    superseded: `Held draft, later superseded ${randomUUID()}`,
    pending: `Held draft, still pending ${randomUUID()}`,
  };
  const heldReplyIds: Record<HeldState, string> = { discarded: "", superseded: "", pending: "" };

  /** Fails naming the surface and the state whose draft text it shows. */
  const expectNoHeldText = (surface: string, value: unknown): void => {
    const serialized = JSON.stringify(value);
    for (const state of HELD_STATES) {
      expect(serialized, `${surface} shows the ${state} draft`).not.toContain(heldText[state]);
    }
  };

  /** Shows the conversation — Alice's words are there — and no held draft. */
  const expectCustomerViewOnly = (surface: string, value: unknown): void => {
    expect(JSON.stringify(value), `${surface} does not show the conversation`).toContain(CUSTOMER_PHRASE);
    expectNoHeldText(surface, value);
  };

  /**
   * The host's review turn for this suite: it drafts each state's text in turn and, as
   * `ChatService.review` does, records the turn's `chat.answer` audit row — the draft's text in
   * its trace — correlated on the request it answered and naming no assistant message.
   */
  const reviews: HeldState[] = [...HELD_STATES];
  const respond = async (input: ConnectorRespondInput): Promise<ConnectorTurnResult> => {
    const state = reviews.shift();
    if (!state) throw new Error("no review was expected");
    const text = heldText[state];
    const turnId = randomUUID();
    await new AuditService(createLogger("silent"), new AuditEventRepository(database.kysely)).record(reviewedTurnAuditEvent({
      accountId: null,
      workspaceId: input.workspaceId,
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        stage: "chat.answer",
        executionMode: "review",
        conversationId: input.conversationId,
        userMessageId: input.respondToMessageId,
        assistantMessageId: turnId,
        citationCount: 0,
        activityTrace: { outcome: { answer: text } },
        turnTrace: { answer: { text } },
      },
    }, { requestMessageId: input.respondToMessageId, turnId }));
    const ownership = await database.queryOptional<{ version: number }>(
      "SELECT version FROM conversation_ownership WHERE conversation_id = $1",
      [input.conversationId],
    );
    return {
      kind: "draft",
      conversationId: input.conversationId,
      ownershipVersion: ownership?.version ?? 0,
      facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, suppressedEffects: [], citationCount: 0 },
      draft: { text, presentation: { citations: [] } },
    };
  };

  const workspaceId = () => scenario.workspaceId;
  const conversationId = () => scenario.conversationId;

  /** Posts a fixture's webhook and runs stage 1 for it, which schedules the thread's review. */
  const receive = async (raw: Buffer): Promise<void> => {
    const emailId = await spool.put(raw);
    expect(await postReceived(await worker.webhook(), { emailId, receivedFor: [relayAddressOf(scenario.mailbox)] })).toBe(200);
    expect(await worker.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ processed: 1, errored: 0 });
  };

  /** Brings the scheduled review due and runs it; it holds the next state's draft. */
  const review = async (): Promise<string> => {
    await database.execute(
      "UPDATE email_thread_links SET review_due_at = now() - interval '1 second' WHERE conversation_id = $1 AND review_due_at IS NOT NULL",
      [conversationId()],
    );
    expect(await worker.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });
    const { id } = await database.queryOne<{ id: string }>(
      "SELECT id FROM held_replies WHERE conversation_id = $1 AND state = 'pending'",
      [conversationId()],
    );
    return id;
  };

  const customerMessages = () =>
    database.query<{ id: string; content: string }>(
      "SELECT id, content FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at, id",
      [conversationId()],
    );

  /**
   * Alice writes three times on a `draft` mailbox and each review holds a draft: a teammate
   * discards the first; her third message supersedes the second; the third waits, pending.
   */
  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "held_visibility");
    database = suite.database;
    spool = await createSpool();
    api = createApiNode(database, { spoolDir: spool.dir });
    worker = createWorkerNode(suite.url, { spoolDir: spool.dir, supportedModes: DRAFTING, respond });
    scenario = await openEmailConversation(database, { node: worker, spool }, { engagementMode: "draft", withAgent: true });
    const addressing = { relayToken: scenario.mailbox.relayToken, domain: scenario.domain.domain };

    heldReplyIds.discarded = await review();
    const discarded = await api.discardHeldReply(scenario.teammate, { conversationId: conversationId(), heldReplyId: heldReplyIds.discarded });
    expect(discarded.status).toBe(200);

    await receive(await readFixture(FOLLOW_UP, addressing));
    heldReplyIds.superseded = await review();

    const third = (await readFixture(FOLLOW_UP, addressing)).toString("latin1")
      .replace("Message-ID: <msg-0002@example.test>", "Message-ID: <msg-0003@example.test>")
      .replace("One more thing", "And one last thing");
    await receive(Buffer.from(third, "latin1"));
    heldReplyIds.pending = await review();

    const states = await database.query<{ id: string; state: string; draft_text: string }>(
      "SELECT id, state, draft_text FROM held_replies WHERE conversation_id = $1 ORDER BY created_at, id",
      [conversationId()],
    );
    expect(states).toEqual(HELD_STATES.map((state) => ({ id: heldReplyIds[state], state, draft_text: heldText[state] })));
    // The leak source the readers must exclude: each review's audit row carries its draft.
    const reviewAudits = await database.query<{ metadata_json: unknown }>(
      "SELECT metadata_json FROM audit_events WHERE workspace_id = $1 AND event_type = 'chat.answer' ORDER BY created_at",
      [workspaceId()],
    );
    expect(reviewAudits).toHaveLength(3);
    for (const state of HELD_STATES) {
      expect(JSON.stringify(reviewAudits)).toContain(heldText[state]);
    }
  }, 120_000);

  afterAll(async () => {
    await worker?.close().catch(() => undefined);
    await spool?.remove();
    await suite?.close();
  }, 30_000);

  it("keeps held drafts out of the message rows and every message reader", async () => {
    const messages = new MessageRepository(database.kysely);
    const ws = workspaceId();
    const id = conversationId();
    const customer = await customerMessages();

    expect(customer).toHaveLength(3);
    expectCustomerViewOnly("messages rows", await database.query("SELECT * FROM messages WHERE conversation_id = $1", [id]));
    expectCustomerViewOnly("listByConversationId", await messages.listByConversationId(ws, id));
    expectCustomerViewOnly("listRecentByConversationId", await messages.listRecentByConversationId(ws, id, 50));
    expect(await messages.countByConversationId(ws, id)).toBe(customer.length);
    const window = await messages.listWindowByConversationId(ws, id, { limit: 50 });
    expect(window.total).toBe(customer.length);
    expectCustomerViewOnly("listWindowByConversationId", window);
    expectCustomerViewOnly("listSinceByConversationId", await messages.listSinceByConversationId(ws, id, { limit: 50 }));
    const summaries = await messages.summarizeByConversationIds(ws, [id]);
    expect(summaries.get(id)).toMatchObject({ messageCount: 3, userMessageCount: 3, assistantMessageCount: 0 });
    expectNoHeldText("summarizeByConversationIds", [...summaries.values()]);
    for (const state of HELD_STATES) {
      expect(await messages.findByIdAndWorkspaceId(ws, heldReplyIds[state])).toBeNull();
    }
  });

  it("keeps held drafts out of the conversation history and its detail, for the visitor and for operators", async () => {
    const { history } = api;
    const ws = workspaceId();
    const id = conversationId();
    const operator = {
      includeAnswerFeedback: true,
      includeOwnership: true,
      includeAgentInternalName: true,
      includeTurnFailureDebug: true,
      includeLatency: true,
      includeOperatorLabel: true,
      activity: { includeFeedback: true },
    };

    // The visitor's read (the embed shares this method, with no options) and the dashboard's.
    expectCustomerViewOnly("history (visitor)", await history.getConversation(ws, id));
    const detail = await history.getConversation(ws, id, { limit: 50 }, operator);
    expectCustomerViewOnly("history (operator)", detail);
    expect(detail.messages.map((message) => message.role)).toEqual(["user", "user", "user"]);
    expectCustomerViewOnly("history tail", await history.tailConversation(ws, id, { limit: 50 }, operator));
    expectCustomerViewOnly("conversation list", await history.listConversations(ws, { limit: 50 }));
    for (const message of await customerMessages()) {
      expectNoHeldText(`turn detail of ${message.id}`, await history.getConversationTurn(ws, message.id, operator));
    }
  });

  it("keeps held drafts out of the history API", async () => {
    const id = conversationId();
    for (const path of [`/chat/${id}`, `/${id}`, `/chat/${id}/tail`, "/chat", "/"]) {
      const response = await api.readHistory(scenario.teammate, path);
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
      expectNoHeldText(`GET /api/v1/history${path}`, response.body);
    }
    expectCustomerViewOnly("GET /api/v1/history/chat/{id}", (await api.readHistory(scenario.teammate, `/chat/${id}`)).body);
  });

  it("publishes no message.created for a held draft, and no draft text to the dashboard", async () => {
    // Holding, discarding and superseding drafts published nothing a visitor hears.
    expect(api.events.filter((event) => event.conversationId === conversationId())).toEqual([]);
    expectNoHeldText("dashboard invalidations", api.invalidations);
    expect(api.invalidations.map((invalidation) => invalidation.kinds)).toEqual([["hitl.decision_resolved"]]);

    // The bus is live: a teammate's reply elsewhere is announced, by its message id alone.
    const elsewhere = await openEmailConversation(database, { node: worker, spool });
    const replyId = await replyFromInbox(database, api, elsewhere, "A teammate's reply elsewhere.");
    expect(api.events).toEqual([expect.objectContaining({ type: "message.created", conversationId: elsewhere.conversationId, messageId: replyId })]);
    expectNoHeldText("message.created events", api.events);
  });

  it("keeps held drafts out of the next review's model context", async () => {
    // The conversation runs on its agent's published release, as its first review bound it.
    const revisionId = randomUUID();
    await database.execute(
      `INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation, published_at, published_version)
       VALUES ($1, $2, $3, $4::jsonb, 1, now(), 1)`,
      [revisionId, scenario.agentId, workspaceId(), JSON.stringify({ customInstruction: "", directives: [], routines: [], contextVariableEnablements: [] })],
    );
    await database.execute("UPDATE conversations SET agent_revision_id = $1 WHERE id = $2", [revisionId, conversationId()]);
    const messages = new MessageRepository(database.kysely);
    const preparer = new ChatSessionPreparer(
      new ConversationRepository(database.kysely),
      messages,
      directOnlyRetrievalTurn(),
      new AuditService(createLogger("silent"), new AuditEventRepository(database.kysely)),
      new WorkspaceRepository(database.kysely),
      new AgentService(new AgentRepository(database.kysely), new WorkspaceRepository(database.kysely)),
      undefined,
      undefined,
      new ConversationSummaryRepository(database.kysely),
      undefined,
      undefined,
      undefined,
      new AgentRevisionRuntimeResolver(new AgentRevisionRuntimeRepository(database.kysely)),
    );
    const latest = (await customerMessages()).at(-1)!;

    // As `ChatService.review` prepares a review: on the recorded message, within the mailbox's window.
    const message = await preparer.loadExistingUserMessage({ workspaceId: workspaceId(), conversationId: conversationId(), messageId: latest.id });
    const session = await preparer.prepare(
      { workspaceId: workspaceId(), conversationId: conversationId(), query: message.content, executionMode: "review" },
      { skipRetrieval: true, existingUserMessage: { message, historyWindow: { maxMessages: scenario.mailbox.threadContextMessages } } },
    );

    expect(session.history.map((entry) => entry.role)).toEqual(["user", "user"]);
    expectCustomerViewOnly("review history window", session.history);
    expectNoHeldText("review query", session.effectiveQuery);
  });

  it("keeps held drafts out of conversation summaries", async () => {
    const prompts: string[] = [];
    const summaries = new ConversationSummaryService(
      new ConversationSummaryRepository(database.kysely),
      new MessageRepository(database.kysely),
      {
        // The summary is the prompt itself, so what the summarizer saw is what is stored.
        generate: async ({ prompt }) => {
          prompts.push(prompt);
          return { summary: prompt, title: "Billing address" };
        },
      },
      new ConversationRepository(database.kysely),
      { generate: async () => ({ title: "Billing address" }) },
      undefined,
      { minMessages: 1, refreshEveryMessages: 1, maxSummaryChars: 100_000 },
    );

    await summaries.refresh({ workspaceId: workspaceId(), conversationId: conversationId() });

    expect(prompts).toHaveLength(1);
    expectCustomerViewOnly("summary prompt", prompts);
    const stored = await database.query("SELECT * FROM conversation_summaries WHERE session_id = $1", [conversationId()]);
    expect(stored).toHaveLength(1);
    expectCustomerViewOnly("conversation_summaries", stored);
  });

  it("keeps held drafts out of Ray's conversation transcript and turn traces", async () => {
    const tools = createChatCopilotTools({ chatHistoryService: api.history });
    const context = {
      workspaceId: workspaceId(),
      accountId: scenario.accountId,
      operatorUserId: scenario.teammate.userId,
      surface: "dashboard" as const,
      currentAuthorization: { hasAllPermissions: async () => true },
      pageContext: { view: "conversation" as const, agentId: null, conversationId: conversationId(), selection: null, entities: [] },
    };
    const invoke = (name: string, input: Record<string, unknown>): Promise<unknown> => {
      const tool = tools.find((descriptor) => descriptor.name === name)!.createTool(context as never) as {
        invoke: (input: Record<string, unknown>, options: unknown) => Promise<unknown>;
      };
      return tool.invoke(input, {});
    };

    expectCustomerViewOnly("conversation_transcript", await invoke("conversation_transcript", { conversationId: conversationId() }));
    for (const message of await customerMessages()) {
      expectNoHeldText(`turn_trace of ${message.id}`, await invoke("turn_trace", { messageId: message.id }));
    }
  });

  it.todo("keeps queued_auto drafts, and those returned to pending, out of every surface (T228, S6)");
});
