/**
 * The voice domain's view of a session an operator starts from the dashboard's Test Chat (#1536):
 * its turns run on one of the operator's private tests, known here only by an opaque id, through a
 * port composition implements over the test-execution module.
 */

/**
 * Where a session is started from, as `voice_session_start_total` counts it: a visitor's website
 * embed, or the dashboard's Test Chat. Closed: it is a metric label.
 */
export type VoiceSessionSurface = "website_embed" | "test_chat";

/**
 * The private test an operator starts a session from in Test Chat, and the account their dashboard
 * session acted for. The session's turns run on that test, never as a conversation; the test is an
 * opaque id here.
 */
export interface VoiceTestChatSubject {
  testExecutionId: string;
  accountId: string | null;
}

/**
 * A session started from Test Chat: the test its turns run on, the account that started it, and
 * until when it takes turns. Past `expiresAt` its turns are refused; they never run as a
 * conversation, whatever became of the test.
 */
export interface VoiceTestChatBinding extends VoiceTestChatSubject {
  expiresAt: Date;
}

/**
 * What a spoken turn on a private test hands back: the answer's text as it is written, then how the
 * turn settled. `answered` carries the stored answer, which is the authority over the text streamed
 * before it; `failed` carries the test's own failure code.
 */
export type VoiceTestChatTurnEvent =
  | { type: "text"; text: string }
  | { type: "answered"; answer: string }
  | { type: "failed"; code: string };

/**
 * Runs one utterance of a Test Chat session as a turn of the private test the session was started
 * from: the revision under test answers it, and the test records it as spoken. Rejects when the test
 * is gone or takes no spoken turn.
 */
export interface VoiceTestChatTurns {
  streamTurn(input: {
    workspaceId: string;
    agentId: string;
    testExecutionId: string;
    accountId: string | null;
    utterance: string;
    signal: AbortSignal;
  }): AsyncIterable<VoiceTestChatTurnEvent>;
}

/**
 * Radioso mints a Test Chat session's key as a UUID of version 8 (RFC 9562's custom version) and a
 * website start's as version 4, so a turn tells a Test Chat session apart by its key alone, even once
 * its row is gone, and never runs one as a conversation. `uuid` is a freshly minted version 4 UUID.
 */
export const testChatSessionKey = (uuid: string): string => `${uuid.slice(0, 14)}8${uuid.slice(15)}`;

const TEST_CHAT_SESSION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isTestChatSessionKey = (sessionKey: string): boolean => TEST_CHAT_SESSION_KEY.test(sessionKey);
