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
  conversationsOfMailbox,
  createEmailChannelDatabase,
  createSpool,
  createWorkerNode,
  postReceived,
  readFixture,
  relayAddressOf,
  seedDomain,
  seedMailbox,
  uniqueCustomerDomain,
  type SeededMailbox,
} from "./support/emailChannelHarness.js";
import { createApiNode, openEmailConversation, replyFromInbox } from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Research B9, FR-027, SC-004 against Postgres: a held reply is operator-only. Its text, in every
// state a teammate has not sent it from — pending, discarded, superseded, queued for an automatic
// send, and returned to pending when that send's authority failed — never reaches a surface a
// customer, a model turn or a conversation reader sees: the message rows and their readers, the
// conversation history and its API, the public conversation events, the next review's model
// context, conversation summaries, and Ray's transcript. Each review here also records the audit
// row a real review turn records, which does carry the draft, so the suite proves the readers
// exclude it rather than never meeting it.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const MODES = ["operator_only", "draft", "auto"] as const;
const FIRST_CONTACT = "mime/first-contact.eml";
const FOLLOW_UP = "mime/pre-reply-follow-up.eml";
/** A phrase of Alice's first message: every surface that shows the conversation shows it. */
const CUSTOMER_PHRASE = "update my billing address";

/** The states of the draft mailbox's thread, in the order its reviews write them. */
const DRAFT_STATES = ["discarded", "superseded", "pending"] as const;
/** `returned` is a queued automatic send its dispatch returned to pending; it is reviewed before `queued_auto`. */
const HELD_STATES = [...DRAFT_STATES, "returned", "queued_auto"] as const;
type HeldState = (typeof HELD_STATES)[number];

/** One email conversation of the workspace and how many customer messages it holds. */
interface Thread {
  name: string;
  conversationId: string;
  customerMessages: number;
}

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
  /** The draft mailbox's thread, then the auto mailboxes' threads with a queued and a returned send. */
  let threads: Thread[] = [];

  /** One draft text per state, unique to this run, in the order the reviews write them. */
  const heldText: Record<HeldState, string> = {
    discarded: `Held draft, later discarded ${randomUUID()}`,
    superseded: `Held draft, later superseded ${randomUUID()}`,
    pending: `Held draft, still pending ${randomUUID()}`,
    returned: `Automatic reply, returned to pending ${randomUUID()}`,
    queued_auto: `Automatic reply, still queued ${randomUUID()}`,
  };
  const heldReplyIds: Record<HeldState, string> = { discarded: "", superseded: "", pending: "", returned: "", queued_auto: "" };

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
   * The host's review turn for this suite: it drafts each state's text in turn, grounded and
   * complete so an `auto` mailbox publishes it, and, as `ChatService.review` does, records the
   * turn's `chat.answer` audit row — the draft's text in its trace — correlated on the request it
   * answered and naming no assistant message.
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

  /** Posts a fixture's webhook for `mailbox` and runs stage 1 for it, which schedules the thread's review. */
  const receive = async (raw: Buffer, mailbox: SeededMailbox = scenario.mailbox): Promise<void> => {
    const emailId = await spool.put(raw);
    expect(await postReceived(await worker.webhook(), { emailId, receivedFor: [relayAddressOf(mailbox)] })).toBe(200);
    expect(await worker.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ processed: 1, errored: 0 });
  };

  /** Brings the thread's scheduled review due and runs it; it holds or queues the next state's draft, as `state`. */
  const review = async (thread: string, state: "pending" | "queued_auto"): Promise<string> => {
    await database.execute(
      "UPDATE email_thread_links SET review_due_at = now() - interval '1 second' WHERE conversation_id = $1 AND review_due_at IS NOT NULL",
      [thread],
    );
    expect(await worker.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });
    const { id } = await database.queryOne<{ id: string }>(
      "SELECT id FROM held_replies WHERE conversation_id = $1 AND state = $2",
      [thread, state],
    );
    return id;
  };

  /** Alice's first contact on a new `auto` mailbox of the workspace, on its own domain; its conversation. */
  const openAutoThread = async () => {
    const domain = await seedDomain(database, workspaceId(), uniqueCustomerDomain());
    const mailbox = await seedMailbox(database, { workspaceId: workspaceId(), domain, agentId: scenario.agentId, engagementMode: "auto" });
    await receive(await readFixture(FIRST_CONTACT, { relayToken: mailbox.relayToken, domain: domain.domain }), mailbox);
    const [opened, ...others] = await conversationsOfMailbox(database, mailbox);
    expect(others).toEqual([]);
    return { domain, conversationId: opened };
  };

  const customerMessages = (thread: string) =>
    database.query<{ id: string; content: string }>(
      "SELECT id, content FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at, id",
      [thread],
    );

  /**
   * Alice writes three times on a `draft` mailbox and each review holds a draft: a teammate
   * discards the first; her third message supersedes the second; the third waits, pending. She
   * also writes once to each of two `auto` mailboxes of the workspace, and each review publishes:
   * one send's domain stops being verified before it is dispatched, so dispatch returns it to
   * pending; the other is never dispatched, and stays queued.
   */
  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "held_visibility");
    database = suite.database;
    spool = await createSpool();
    api = createApiNode(database, { spoolDir: spool.dir });
    worker = createWorkerNode(suite.url, { spoolDir: spool.dir, supportedModes: MODES, respond });
    scenario = await openEmailConversation(database, { node: worker, spool }, { engagementMode: "draft", withAgent: true });
    const addressing = { relayToken: scenario.mailbox.relayToken, domain: scenario.domain.domain };

    heldReplyIds.discarded = await review(conversationId(), "pending");
    const discarded = await api.discardHeldReply(scenario.teammate, { conversationId: conversationId(), heldReplyId: heldReplyIds.discarded });
    expect(discarded.status).toBe(200);

    await receive(await readFixture(FOLLOW_UP, addressing));
    heldReplyIds.superseded = await review(conversationId(), "pending");

    const third = (await readFixture(FOLLOW_UP, addressing)).toString("latin1")
      .replace("Message-ID: <msg-0002@example.test>", "Message-ID: <msg-0003@example.test>")
      .replace("One more thing", "And one last thing");
    await receive(Buffer.from(third, "latin1"));
    heldReplyIds.pending = await review(conversationId(), "pending");

    const returned = await openAutoThread();
    heldReplyIds.returned = await review(returned.conversationId, "queued_auto");
    await database.execute("UPDATE email_domains SET sending_status = 'failed' WHERE id = $1", [returned.domain.id]);
    expect(await worker.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

    const queued = await openAutoThread();
    heldReplyIds.queued_auto = await review(queued.conversationId, "queued_auto");

    threads = [
      { name: "draft thread", conversationId: conversationId(), customerMessages: 3 },
      { name: "returned auto thread", conversationId: returned.conversationId, customerMessages: 1 },
      { name: "queued auto thread", conversationId: queued.conversationId, customerMessages: 1 },
    ];
    const states = await database.query<{ id: string; state: string; hold_reason: string; draft_text: string }>(
      "SELECT id, state, hold_reason, draft_text FROM held_replies WHERE workspace_id = $1 ORDER BY created_at, id",
      [workspaceId()],
    );
    expect(states).toEqual(HELD_STATES.map((state) => expect.objectContaining({
      id: heldReplyIds[state],
      state: state === "returned" ? "pending" : state,
      draft_text: heldText[state],
    })));
    expect(states.find((row) => row.id === heldReplyIds.returned)?.hold_reason).toBe("authority_changed");
    // The leak source the readers must exclude: each review's audit row carries its draft.
    const reviewAudits = await database.query<{ metadata_json: unknown }>(
      "SELECT metadata_json FROM audit_events WHERE workspace_id = $1 AND event_type = 'chat.answer' ORDER BY created_at",
      [workspaceId()],
    );
    expect(reviewAudits).toHaveLength(HELD_STATES.length);
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
    for (const { name, conversationId: id, customerMessages: count } of threads) {
      const customer = await customerMessages(id);

      expect(customer, name).toHaveLength(count);
      expectCustomerViewOnly(`${name} messages rows`, await database.query("SELECT * FROM messages WHERE conversation_id = $1", [id]));
      expectCustomerViewOnly(`${name} listByConversationId`, await messages.listByConversationId(ws, id));
      expectCustomerViewOnly(`${name} listRecentByConversationId`, await messages.listRecentByConversationId(ws, id, 50));
      expect(await messages.countByConversationId(ws, id), name).toBe(count);
      const window = await messages.listWindowByConversationId(ws, id, { limit: 50 });
      expect(window.total, name).toBe(count);
      expectCustomerViewOnly(`${name} listWindowByConversationId`, window);
      expectCustomerViewOnly(`${name} listSinceByConversationId`, await messages.listSinceByConversationId(ws, id, { limit: 50 }));
      const summaries = await messages.summarizeByConversationIds(ws, [id]);
      expect(summaries.get(id), name).toMatchObject({ messageCount: count, userMessageCount: count, assistantMessageCount: 0 });
      expectNoHeldText(`${name} summarizeByConversationIds`, [...summaries.values()]);
    }
    for (const state of HELD_STATES) {
      expect(await messages.findByIdAndWorkspaceId(ws, heldReplyIds[state])).toBeNull();
    }
  });

  it("keeps held drafts out of the conversation history and its detail, for the visitor and for operators", async () => {
    const { history } = api;
    const ws = workspaceId();
    const operator = {
      includeAnswerFeedback: true,
      includeOwnership: true,
      includeAgentInternalName: true,
      includeTurnFailureDebug: true,
      includeLatency: true,
      includeOperatorLabel: true,
      activity: { includeFeedback: true },
    };

    for (const { name, conversationId: id, customerMessages: count } of threads) {
      // The visitor's read (the embed shares this method, with no options) and the dashboard's.
      expectCustomerViewOnly(`${name} history (visitor)`, await history.getConversation(ws, id));
      const detail = await history.getConversation(ws, id, { limit: 50 }, operator);
      expectCustomerViewOnly(`${name} history (operator)`, detail);
      expect(detail.messages.map((message) => message.role), name).toEqual(Array.from({ length: count }, () => "user"));
      expectCustomerViewOnly(`${name} history tail`, await history.tailConversation(ws, id, { limit: 50 }, operator));
      for (const message of await customerMessages(id)) {
        expectNoHeldText(`${name} turn detail of ${message.id}`, await history.getConversationTurn(ws, message.id, operator));
      }
    }
    expectCustomerViewOnly("conversation list", await history.listConversations(ws, { limit: 50 }));
  });

  it("keeps held drafts out of the history API", async () => {
    for (const { name, conversationId: id } of threads) {
      for (const path of [`/chat/${id}`, `/${id}`, `/chat/${id}/tail`]) {
        const response = await api.readHistory(scenario.teammate, path);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
        expectNoHeldText(`${name} GET /api/v1/history${path}`, response.body);
      }
      expectCustomerViewOnly(`${name} GET /api/v1/history/chat/{id}`, (await api.readHistory(scenario.teammate, `/chat/${id}`)).body);
    }
    for (const path of ["/chat", "/"]) {
      const response = await api.readHistory(scenario.teammate, path);
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
      expectNoHeldText(`GET /api/v1/history${path}`, response.body);
    }
  });

  it("publishes no message.created for a held draft, and no draft text to the dashboard", async () => {
    // Holding, discarding, superseding, queueing and returning drafts published nothing a visitor hears.
    const held = new Set(threads.map((thread) => thread.conversationId));
    expect(api.events.filter((event) => held.has(event.conversationId))).toEqual([]);
    expectNoHeldText("dashboard invalidations", api.invalidations);
    expect(api.invalidations.map((invalidation) => invalidation.kinds)).toEqual([["hitl.decision_resolved"]]);

    // The bus is live: a teammate's reply elsewhere is announced, by its message id alone.
    const elsewhere = await openEmailConversation(database, { node: worker, spool });
    const replyId = await replyFromInbox(database, api, elsewhere, "A teammate's reply elsewhere.");
    expect(api.events).toEqual([expect.objectContaining({ type: "message.created", conversationId: elsewhere.conversationId, messageId: replyId })]);
    expectNoHeldText("message.created events", api.events);
  });

  it("keeps held drafts out of the next review's model context", async () => {
    // Each conversation runs on its agent's published release, as its first review bound it.
    const revisionId = randomUUID();
    await database.execute(
      `INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation, published_at, published_version)
       VALUES ($1, $2, $3, $4::jsonb, 1, now(), 1)`,
      [revisionId, scenario.agentId, workspaceId(), JSON.stringify({ customInstruction: "", directives: [], routines: [], contextVariableEnablements: [] })],
    );
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

    for (const { name, conversationId: id, customerMessages: count } of threads) {
      await database.execute("UPDATE conversations SET agent_revision_id = $1 WHERE id = $2", [revisionId, id]);
      const latest = (await customerMessages(id)).at(-1)!;

      // As `ChatService.review` prepares a review: on the recorded message, within the mailbox's window.
      const message = await preparer.loadExistingUserMessage({ workspaceId: workspaceId(), conversationId: id, messageId: latest.id });
      const session = await preparer.prepare(
        { workspaceId: workspaceId(), conversationId: id, query: message.content, executionMode: "review" },
        { skipRetrieval: true, existingUserMessage: { message, historyWindow: { maxMessages: scenario.mailbox.threadContextMessages } } },
      );

      expect(session.history.map((entry) => entry.role), name).toEqual(Array.from({ length: count - 1 }, () => "user"));
      expectCustomerViewOnly(`${name} review context`, { history: session.history, query: session.effectiveQuery });
    }
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

    for (const { name, conversationId: id } of threads) {
      prompts.length = 0;
      await summaries.refresh({ workspaceId: workspaceId(), conversationId: id });

      expect(prompts, name).toHaveLength(1);
      expectCustomerViewOnly(`${name} summary prompt`, prompts);
      const stored = await database.query("SELECT * FROM conversation_summaries WHERE session_id = $1", [id]);
      expect(stored, name).toHaveLength(1);
      expectCustomerViewOnly(`${name} conversation_summaries`, stored);
    }
  });

  it("keeps held drafts out of Ray's conversation transcript and turn traces", async () => {
    const tools = createChatCopilotTools({ chatHistoryService: api.history });
    for (const { name, conversationId: id } of threads) {
      const context = {
        workspaceId: workspaceId(),
        accountId: scenario.accountId,
        operatorUserId: scenario.teammate.userId,
        surface: "dashboard" as const,
        currentAuthorization: { hasAllPermissions: async () => true },
        pageContext: { view: "conversation" as const, agentId: null, conversationId: id, selection: null, entities: [] },
      };
      const invoke = (tool: string, input: Record<string, unknown>): Promise<unknown> => {
        const created = tools.find((descriptor) => descriptor.name === tool)!.createTool(context as never) as {
          invoke: (input: Record<string, unknown>, options: unknown) => Promise<unknown>;
        };
        return created.invoke(input, {});
      };

      expectCustomerViewOnly(`${name} conversation_transcript`, await invoke("conversation_transcript", { conversationId: id }));
      for (const message of await customerMessages(id)) {
        expectNoHeldText(`${name} turn_trace of ${message.id}`, await invoke("turn_trace", { messageId: message.id }));
      }
    }
  });

  it("shows a queued_auto draft, and one returned to pending, only on the teammate's held-reply surface", async () => {
    // The positive control: the text the readers above exclude is there for a teammate to decide on.
    const [, returned, queued] = threads;
    const teammate = scenario.teammate;
    expect(await api.heldReplies.current(teammate, returned.conversationId)).toEqual({ heldReply: expect.objectContaining({
      id: heldReplyIds.returned,
      state: "pending",
      holdReason: "authority_changed",
      draftText: heldText.returned,
      attentionOpen: true,
    }) });
    expect(await api.heldReplies.current(teammate, queued.conversationId)).toEqual({ heldReply: expect.objectContaining({
      id: heldReplyIds.queued_auto,
      state: "queued_auto",
      draftText: heldText.queued_auto,
      attentionOpen: false,
    }) });
    // A queued send waits for no one, so it asks for no attention; the returned one does.
    const open = (await api.heldReplies.list(teammate, { attention: "open", limit: 50 })).items.map((item) => item.id);
    expect(open).toContain(heldReplyIds.returned);
    expect(open).not.toContain(heldReplyIds.queued_auto);
    const all = (await api.heldReplies.list(teammate, { attention: "all", limit: 50 })).items.map((item) => item.id);
    expect(all).toEqual(expect.arrayContaining([heldReplyIds.returned, heldReplyIds.queued_auto]));
  });
});
