import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createTestChatVoiceTurns } from "../../src/app/composition/voiceChannel.js";
import { AgentRevisionRuntimeRepository } from "../../src/db/repositories/agentRevisionRuntimeRepository.js";
import { TestExecutionRepository } from "../../src/db/repositories/testExecutionRepository.js";
import { TestExecutionService, type TrustedTestExecutionRunnerPort } from "../../src/modules/test-execution/testExecution.js";
import {
  TestChatVoiceTurnService,
  VoiceSessionRepository,
  VoiceSessionTurnRouter,
  type VoiceSessionRef,
  type VoiceTurnPort,
} from "../../src/modules/voiceChannel/public.js";
import type { VoiceTurnEvent, VoiceTurnInput } from "../../src/modules/voiceChannel/domain.js";
import { testChatSessionKey } from "../../src/modules/voiceChannel/testChatSessionDomain.js";
import { Database } from "../../src/shared/infra/database.js";
import type { UsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const snapshotWith = (customInstruction: string) => ({ customInstruction, directives: [], routines: [], contextVariableEnablements: [] });

const collect = async (events: AsyncIterable<VoiceTurnEvent>): Promise<VoiceTurnEvent[]> => {
  const seen: VoiceTurnEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

const spoken = (events: readonly VoiceTurnEvent[]): string =>
  events.filter((event): event is Extract<VoiceTurnEvent, { type: "speech" }> => event.type === "speech").map((event) => event.text).join("");

describeIntegration("talking to the draft from Test Chat (#1536, Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const sessions = new VoiceSessionRepository(database.kysely);
  const executions = new TestExecutionRepository(database.kysely);
  const releases = new AgentRevisionRuntimeRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const publishedRevisionId = randomUUID();
  const draftRevisionId = randomUUID();
  const vendorAgent = { agentId: "agent_42", region: "eu" as const };

  /** The agent's published persona; only the draft says it differently. */
  const PUBLISHED = "Answer as the published agent.";
  const DRAFT = "Answer as the draft agent.";

  const reservations: Array<Parameters<UsageLimitPolicy["reserveAnswer"]>[0]> = [];
  const audits: Array<{ eventType: string; metadata: Record<string, unknown> }> = [];
  /** The trusted runner's seam: it answers in the voice of the revision it was handed. */
  const stream = vi.fn<TrustedTestExecutionRunnerPort["stream"]>(async function* (input) {
    yield "Speaking. ";
    return { answer: `Speaking. ${input.candidateRevision.snapshot.customInstruction ?? ""}`, messageId: randomUUID(), continuation: { version: 1 } };
  });
  const testExecutionService = new TestExecutionService({
    revisions: executions,
    contextCatalog: { get: async () => null },
    repository: executions,
    runner: { stream },
    usageLimitPolicy: {
      reserveAnswer: async (input) => {
        reservations.push(input);
        return { commit: async () => undefined, release: async () => undefined };
      },
    },
    audit: { record: async (event) => { audits.push(event); } },
    createId: randomUUID,
  });

  /** The conversation path stands in for chat on the published release: it answers in that release's voice. */
  const conversationTurns = vi.fn<VoiceTurnPort["runTurn"]>(async function* (input) {
    const release = await releases.findCurrentPublished({ workspaceId: input.session.workspaceId, agentId: input.session.agentId });
    yield { type: "speech", text: `Speaking. ${release?.snapshot.customInstruction ?? ""}`, last: true };
    yield { type: "outcome", outcome: { kind: "continue" } };
  });
  const router = new VoiceSessionTurnRouter({
    bindings: sessions,
    conversations: { runTurn: conversationTurns },
    testChats: new TestChatVoiceTurnService({ turns: createTestChatVoiceTurns(testExecutionService), logger: { info: vi.fn(), warn: vi.fn() } }),
    logger: { warn: vi.fn() },
  });

  const turn = (session: VoiceSessionRef, utterance: string): VoiceTurnInput => ({ session, transport: "web", utterance, streamsSpeech: true });
  /** A website start's session, and a Test Chat start's, whose key Radioso mints in Test Chat's namespace. */
  const sessionOf = (): VoiceSessionRef => ({ workspaceId, agentId, vendor: "elevenlabs", sessionKey: randomUUID() });
  const testChatSessionOf = (): VoiceSessionRef => ({ ...sessionOf(), sessionKey: testChatSessionKey(randomUUID()) });

  const startTest = async (): Promise<string> => {
    const execution = await testExecutionService.start({
      workspaceId, agentId, accountId, mode: "single", revisionIds: [draftRevisionId], testValues: [], idempotencyKey: randomUUID(),
    });
    return execution.id;
  };

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [accountId, "Test Chat Voice Co", `test-chat-voice-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [workspaceId, accountId, "Test Chat Voice", `test-chat-voice-${workspaceId}`]);
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, "Voice Agent"]);
    await database.query("INSERT INTO agent_drafts (agent_id, workspace_id, generation, snapshot) VALUES ($1, $2, 2, $3::jsonb)", [agentId, workspaceId, JSON.stringify(snapshotWith(DRAFT))]);
    await database.query(
      "INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation, published_at, published_version) VALUES ($1, $2, $3, $4::jsonb, 1, now(), 1)",
      [publishedRevisionId, agentId, workspaceId, JSON.stringify(snapshotWith(PUBLISHED))],
    );
    await database.query(
      "INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation, source_base_published_revision_id) VALUES ($1, $2, $3, $4::jsonb, 2, $5)",
      [draftRevisionId, agentId, workspaceId, JSON.stringify(snapshotWith(DRAFT)), publishedRevisionId],
    );
    await database.query("UPDATE agents SET published_revision_id = $1 WHERE id = $2", [publishedRevisionId, agentId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("runs a Test Chat session's turn on the draft under test, while a website session's turn runs the published agent", async () => {
    const executionId = await startTest();
    const testChat = testChatSessionOf();
    const website = sessionOf();
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await sessions.register({ session: testChat, test: { testExecutionId: executionId, accountId }, expiresAt, vendorAgent });
    await sessions.register({ session: website, visitor: { publicSessionId: randomUUID(), visitorKey: null }, expiresAt, vendorAgent });

    const draftHeard = await collect(router.runTurn(turn(testChat, "Who am I talking to?"), new AbortController().signal));
    const publishedHeard = await collect(router.runTurn(turn(website, "Who am I talking to?"), new AbortController().signal));

    expect(spoken(draftHeard)).toBe(`Speaking. ${DRAFT}`);
    expect(spoken(publishedHeard)).toBe(`Speaking. ${PUBLISHED}`);
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ candidateRevision: expect.objectContaining({ id: draftRevisionId }) }));
    expect(conversationTurns).toHaveBeenCalledTimes(1);
    expect(conversationTurns.mock.calls[0][0].session).toEqual(website);
  });

  it("records the call's turns in the test as spoken, charges them as test runs, and leaves no conversation behind", async () => {
    const executionId = await startTest();
    const testChat = testChatSessionOf();
    await sessions.register({ session: testChat, test: { testExecutionId: executionId, accountId }, expiresAt: new Date(Date.now() + 60_000), vendorAgent });
    reservations.length = 0;
    audits.length = 0;
    const conversationsBefore = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM conversations WHERE workspace_id = $1", [workspaceId]);

    await collect(router.runTurn(turn(testChat, "Do you open on Sundays?"), new AbortController().signal));

    const execution = await executions.find({ workspaceId, agentId, executionId });
    expect(execution?.sides[0]?.history).toEqual([
      expect.objectContaining({ role: "user", content: "Do you open on Sundays?", spoken: true }),
      expect.objectContaining({ role: "assistant", content: `Speaking. ${DRAFT}`, spoken: true }),
    ]);
    expect(reservations).toEqual([{ accountId, workspaceId, surface: "test_execution", usage: "test_run" }]);
    // The test settles the spoken turn and audits it, as it does a typed one.
    expect(audits).toEqual([expect.objectContaining({ eventType: "agent.test_execution.completed", metadata: expect.objectContaining({ executionId }) })]);
    const conversationsAfter = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM conversations WHERE workspace_id = $1", [workspaceId]);
    expect(conversationsAfter[0]?.count).toBe(conversationsBefore[0]?.count);
    await expect(sessions.findConversationId(testChat)).resolves.toBeNull();
  });

  it("never lets a Test Chat session bind a conversation, join a visitor, or take a recording report", async () => {
    const executionId = await startTest();
    const testChat = testChatSessionOf();
    await sessions.register({ session: testChat, test: { testExecutionId: executionId, accountId }, expiresAt: new Date(Date.now() + 60_000), vendorAgent });
    const conversationId = randomUUID();
    await database.query("INSERT INTO conversations (id, workspace_id, agent_id, source_channel) VALUES ($1, $2, $3, 'voice')", [conversationId, workspaceId, agentId]);

    await expect(sessions.bind(testChat, conversationId)).rejects.toThrow(/voice_sessions_test_chat_session/);
    await expect(sessions.findStartedVisitor(testChat)).resolves.toBeNull();
    await expect(sessions.findReportableSession({ workspaceId, agentId, sessionKey: testChat.sessionKey, publicSessionId: randomUUID() })).resolves.toBeNull();
    await expect(sessions.findTestChatBinding(testChat)).resolves.toEqual({ testExecutionId: executionId, accountId, expiresAt: expect.any(Date) });
  });

  it("refuses turns once the test is gone or the session's window passed, and never runs them as a conversation", async () => {
    const goneExecutionId = await startTest();
    const gone = testChatSessionOf();
    const ended = testChatSessionOf();
    await sessions.register({ session: gone, test: { testExecutionId: goneExecutionId, accountId }, expiresAt: new Date(Date.now() + 60_000), vendorAgent });
    await sessions.register({ session: ended, test: { testExecutionId: await startTest(), accountId }, expiresAt: new Date(Date.now() - 1_000), vendorAgent });
    await database.query("DELETE FROM agent_test_executions WHERE id = $1", [goneExecutionId]);
    conversationTurns.mockClear();

    await expect(collect(router.runTurn(turn(gone, "Hello?"), new AbortController().signal))).rejects.toMatchObject({ statusCode: 404 });
    await expect(collect(router.runTurn(turn(ended, "Hello?"), new AbortController().signal))).rejects.toMatchObject({ statusCode: 404 });
    expect(conversationTurns).not.toHaveBeenCalled();
    // The gone test's session still names it, so its next turn is refused the same way.
    await expect(sessions.findTestChatBinding(gone)).resolves.toMatchObject({ testExecutionId: goneExecutionId });
  });

  it("refuses a late turn on a Test Chat session whose row a start's cleanup removed, and never runs it as a conversation", async () => {
    const lapsed = testChatSessionOf();
    const visitorStart = sessionOf();
    await sessions.register({ session: lapsed, test: { testExecutionId: await startTest(), accountId }, expiresAt: new Date(Date.now() - 60_000), vendorAgent });
    await sessions.register({ session: visitorStart, visitor: { publicSessionId: randomUUID(), visitorKey: null }, expiresAt: new Date(Date.now() - 60_000), vendorAgent });

    // The next start clears out expired starts, the Test Chat one included, as an older revision's cleanup does.
    await sessions.register({ session: sessionOf(), visitor: { publicSessionId: randomUUID(), visitorKey: null }, expiresAt: new Date(Date.now() + 60_000), vendorAgent });
    await expect(sessions.findTestChatBinding(lapsed)).resolves.toBeNull();
    expect(await database.query("SELECT 1 FROM voice_sessions WHERE session_key = $1", [visitorStart.sessionKey])).toHaveLength(0);
    conversationTurns.mockClear();

    await expect(collect(router.runTurn(turn(lapsed, "Are you still there?"), new AbortController().signal))).rejects.toMatchObject({ statusCode: 404 });
    expect(conversationTurns).not.toHaveBeenCalled();
  });
});
