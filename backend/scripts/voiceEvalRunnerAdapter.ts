import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";

import type { AgentVoiceSettings } from "../src/modules/agents/public.js";
import {
  VOICE_OUTCOME_KINDS,
  type ConversationQualityCase,
  type ConversationQualityRunnerPort,
  type ConversationQualityVoiceCallStep,
  type VoicePieceKind,
  type VoiceTurnObservation,
} from "../src/modules/eval/suite/index.js";
import type { ConversationOwnershipService, OwnershipActor } from "../src/modules/handoff/public.js";
import type { VoiceTurnObserver, VoiceTurnSummary } from "../src/modules/voiceChannel/public.js";

/**
 * The voice cases' runner: it calls the agent the way a voice runtime does, through the
 * `generic` dialect of the OpenAI-compatible completions door, one streamed request per caller
 * turn, and reads what the runtime would hear off the socket. Both halves of the suite run it:
 * the deterministic half against the test app on a fake clock, the live half against the
 * composed stack on the wall clock.
 */

/** A voice runtime's door on one agent: the backend's origin, and the `agent-api` credential it posts with. */
export interface VoiceRuntimeDoor {
  origin: string;
  agentId: string;
  token: string;
}

/** The generic dialect's wire, as `docs/voice-channel.md` documents it for a runtime. */
const SESSION_HEADER = "x-radioso-voice-session";
const LOCALE_HEADER = "x-radioso-voice-locale";
const OUTCOME_FIELD = "x-radioso-voice-outcome";
const CONVERSATION_HEADER = "x-radioso-conversation-id";
const DONE_DATA = "[DONE]";
/** A turn's response goes quiet for at most the turn limit and its drain; past this the socket is given up. */
const SOCKET_IDLE_TIMEOUT_MS = 60_000;

const completionsPath = (agentId: string): string =>
  `/api/v1/agents/${encodeURIComponent(agentId)}/voice/generic/v1/chat/completions`;

/** One chunk of a streamed body, with when it arrived, in ms since the request left. */
export interface VoiceWireChunk {
  atMs: number;
  text: string;
}

/** One caller turn's response as it came off the socket. */
export interface VoiceWireRecording {
  status: number;
  chunks: VoiceWireChunk[];
  /** The outcome trailer of a stream. */
  outcome: string | null;
  conversationId: string | null;
  endedAtMs: number;
}

const headerValue = (value: string | string[] | undefined): string | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

/**
 * Posts one caller turn and records the response as it arrives. `clock` stamps the chunks: the
 * deterministic half passes its fake clock, so the times are the policy's own. Once the response's
 * headers have arrived, the recording always resolves: a stream the server or the socket cuts off
 * resolves with the chunks it carried, which the suite then reads as a cut stream. Only a request
 * that never got a response rejects.
 */
export const postVoiceTurn = (
  door: VoiceRuntimeDoor,
  turn: { sessionKey: string; utterance: string; locale?: string },
  clock: () => number = Date.now,
  /** Told the chunks so far each time one arrives, while the response streams. */
  onChunk?: (chunks: readonly VoiceWireChunk[]) => void,
): Promise<VoiceWireRecording> =>
  new Promise((resolve, reject) => {
    const url = new URL(completionsPath(door.agentId), door.origin);
    const startedAt = clock();
    const client = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${door.token}`,
        [SESSION_HEADER]: turn.sessionKey,
        ...(turn.locale ? { [LOCALE_HEADER]: turn.locale } : {}),
      },
    });
    let responded = false;
    client.on("error", (error) => {
      // After the headers, the response's own close settles the recording.
      if (!responded) reject(error);
    });
    client.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => client.destroy(new Error(`The voice turn went silent for ${SOCKET_IDLE_TIMEOUT_MS} ms.`)));
    client.on("response", (response) => {
      responded = true;
      const chunks: VoiceWireChunk[] = [];
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          chunks,
          // A trailer arrives only with a whole stream; a cut one carries none.
          outcome: headerValue(response.trailers[OUTCOME_FIELD]) ?? headerValue(response.headers[OUTCOME_FIELD]),
          conversationId: headerValue(response.headers[CONVERSATION_HEADER]),
          endedAtMs: clock() - startedAt,
        });
      };
      response.setEncoding("utf8");
      response.on("data", (text: string) => {
        chunks.push({ atMs: clock() - startedAt, text });
        onChunk?.(chunks);
      });
      response.on("end", settle);
      response.on("error", settle);
      response.on("close", settle);
    });
    client.end(JSON.stringify({ model: "radioso-voice-eval", stream: true, messages: [{ role: "user", content: turn.utterance }] }));
  });

/** What a stream's frames said: each content delta with when its frame completed, and how the stream ended. */
interface VoiceStreamReading {
  deltas: Array<{ text: string; atMs: number }>;
  done: boolean;
  errorFrame: boolean;
  /** Frames that are not `chat.completion.chunk` JSON, a partial frame at the end included. */
  unreadableFrames: number;
}

type ChunkFrame = { error?: unknown; choices?: Array<{ delta?: { content?: unknown } }> };

/** Whitespace and zero-width spaces are wire padding (a flush or a keep-alive), never speech. */
const isAudible = (text: string): boolean => text.replace(/[\s\u200B]/gu, "").length > 0;

/**
 * Splits a stream into its SSE frames, however the socket cut it; a frame is stamped with the chunk
 * that completed it, and only a delta with something to hear counts.
 */
export const readVoiceStream = (chunks: readonly VoiceWireChunk[]): VoiceStreamReading => {
  const reading: VoiceStreamReading = { deltas: [], done: false, errorFrame: false, unreadableFrames: 0 };
  let buffer = "";
  for (const chunk of chunks) {
    buffer += chunk.text;
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const data = buffer.slice(0, end).split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      buffer = buffer.slice(end + 2);
      if (data === DONE_DATA) {
        reading.done = true;
      } else if (data.length > 0) {
        try {
          const frame = JSON.parse(data) as ChunkFrame;
          const content = frame.choices?.[0]?.delta?.content;
          if (frame.error !== undefined) {
            reading.errorFrame = true;
          } else if (typeof content === "string" && isAudible(content)) {
            reading.deltas.push({ text: content, atMs: chunk.atMs });
          }
        } catch {
          reading.unreadableFrames += 1;
        }
      }
    }
  }
  if (buffer.trim().length > 0) {
    reading.unreadableFrames += 1;
  }
  return reading;
};

/** The agent's authored lines, by which a runner tells a bridge or fallback line from the rest of a turn. */
export interface VoiceLineCatalog {
  bridge: ReadonlySet<string>;
  fallback: ReadonlySet<string>;
}

export const voiceLineCatalog = (settings: Pick<AgentVoiceSettings, "bridgeLines" | "fallbackLine">): VoiceLineCatalog => ({
  bridge: new Set(Object.values(settings.bridgeLines).flatMap((styles) => [...styles.acknowledge, ...styles.check]).map((line) => line.trim())),
  fallback: new Set(Object.values(settings.fallbackLine).map((line) => line.trim())),
});

const pieceKind = (text: string, lines: VoiceLineCatalog): VoicePieceKind => {
  const line = text.trim();
  if (lines.bridge.has(line)) return "bridge";
  return lines.fallback.has(line) ? "fallback" : "speech";
};

const knownOutcome = (outcome: string | null): VoiceTurnObservation["outcome"] =>
  VOICE_OUTCOME_KINDS.find((kind) => kind === outcome) ?? null;

const protocolOf = (recording: VoiceWireRecording, reading: VoiceStreamReading): VoiceTurnObservation["protocol"] => {
  const problem = recording.status !== 200
    ? `The response was HTTP ${recording.status}.`
    : reading.errorFrame
      ? "The stream carried an error frame."
      : !reading.done
        ? "The stream ended without [DONE]."
        : reading.unreadableFrames > 0
          ? `The stream carried ${reading.unreadableFrames} frame(s) that are not chat.completion.chunk JSON.`
          : recording.outcome === null
            ? "The stream named no outcome in its trailer."
            : knownOutcome(recording.outcome) === null
              ? `The stream named an unknown outcome "${recording.outcome}".`
              : null;
  return problem === null ? { ok: true } : { ok: false, problem };
};

/** The scored turn as the suite reads it: each piece heard, told apart by the agent's lines, and its times. */
export const observeVoiceTurn = (recording: VoiceWireRecording, lines: VoiceLineCatalog): VoiceTurnObservation => {
  const reading = readVoiceStream(recording.chunks);
  const pieces = reading.deltas.map((delta) => ({ kind: pieceKind(delta.text, lines), text: delta.text, atMs: delta.atMs }));
  return {
    protocol: protocolOf(recording, reading),
    outcome: knownOutcome(recording.outcome),
    pieces,
    timings: {
      firstByteMs: recording.chunks[0]?.atMs ?? null,
      bridgeMs: pieces.find((piece) => piece.kind === "bridge")?.atMs ?? null,
      firstSpeechMs: pieces.find((piece) => piece.kind !== "bridge")?.atMs ?? null,
      turnMs: recording.endedAtMs,
    },
  };
};

/** A teammate's Inbox actions on a call's conversation. */
interface VoiceCallTeammate {
  takeOver(conversationId: string): Promise<void>;
  reply(conversationId: string, text: string): Promise<void>;
  handBack(conversationId: string): Promise<void>;
}

/** The teammate as the Inbox's commands run for `actor`, each against the conversation's current version. */
export const ownershipTeammate = (
  ownership: Pick<ConversationOwnershipService, "load" | "takeOver" | "reply" | "handBack">,
  actor: OwnershipActor,
): VoiceCallTeammate => {
  const refused = (command: string, conversationId: string): Error =>
    new Error(`The teammate's ${command} on conversation ${conversationId} was refused.`);
  const versionOf = async (conversationId: string): Promise<number> => (await ownership.load(conversationId))?.version ?? 0;
  return {
    takeOver: async (conversationId) => {
      if (!(await ownership.takeOver(actor, { conversationId })).ok) throw refused("takeover", conversationId);
    },
    reply: async (conversationId, message) => {
      const expectedVersion = await versionOf(conversationId);
      if (!(await ownership.reply(actor, { conversationId, message, expectedVersion })).ok) throw refused("reply", conversationId);
    },
    handBack: async (conversationId) => {
      const expectedVersion = await versionOf(conversationId);
      if (!(await ownership.handBack(actor, { conversationId, expectedVersion })).ok) throw refused("hand-back", conversationId);
    },
  };
};

/** The voice turns' own records, for a runner that shares the process serving them. */
export interface VoiceTurnRecordReader {
  /**
   * The records of a session's first `count` turns, in the order their requests arrived, once that
   * many have finished. Turns that run at once (a reply and the utterance spoken over it) finish in
   * either order; the arrival order is what tells them apart.
   */
  recordsOf(sessionKey: string, count: number): Promise<ReadonlyArray<Readonly<VoiceTurnSummary>>>;
}

/**
 * The records a voice service in this process reports, by session: the observer to hand the
 * service, the reader the call driver waits on, and each session's binding as its turns report it.
 */
export const collectVoiceTurnRecords = (): VoiceTurnObserver & VoiceTurnRecordReader & VoiceCallConversations => {
  const sessions = new Map<string, Array<{ sequence: number; summary: Readonly<VoiceTurnSummary> }>>();
  const waiters: Array<() => void> = [];
  const inArrivalOrder = (sessionKey: string) => [...(sessions.get(sessionKey) ?? [])].sort((left, right) => left.sequence - right.sequence);
  return {
    turnFinished: (turn, summary) => {
      sessions.set(turn.sessionKey, [...(sessions.get(turn.sessionKey) ?? []), { sequence: turn.sequence, summary }]);
      waiters.splice(0).forEach((wake) => wake());
    },
    recordsOf: async (sessionKey, count) => {
      while ((sessions.get(sessionKey)?.length ?? 0) < count) await new Promise<void>((wake) => waiters.push(wake));
      return inArrivalOrder(sessionKey).slice(0, count).map((entry) => entry.summary);
    },
    conversationOf: async (sessionKey) =>
      inArrivalOrder(sessionKey).reverse().find((entry) => entry.summary.conversationId !== null)?.summary.conversationId ?? null,
  };
};

/** Where a call's session is bound: the conversation a session key's turns run in, once one has run. */
export interface VoiceCallConversations {
  conversationOf(sessionKey: string): Promise<string | null>;
}

export interface VoiceCallStack {
  door: VoiceRuntimeDoor;
  teammate: VoiceCallTeammate;
  /** Read when a teammate acts and no caller turn's response named the conversation. */
  conversations: VoiceCallConversations;
  lines: VoiceLineCatalog;
  clock?: () => number;
  /** Waits for one step of a call; the deterministic half moves its fake clock while it waits. */
  settle?: <T>(pending: Promise<T>) => Promise<T>;
  turnRecords?: VoiceTurnRecordReader;
}

const runTeammateStep = (
  teammate: VoiceCallTeammate,
  conversationId: string,
  step: Exclude<ConversationQualityVoiceCallStep, { kind: "caller" }>,
): Promise<void> => {
  switch (step.kind) {
    case "teammate_takes_over":
      return teammate.takeOver(conversationId);
    case "teammate_replies":
      return teammate.reply(conversationId, step.text);
    case "teammate_hands_back":
      return teammate.handBack(conversationId);
  }
};

const speechPieceCount = (chunks: readonly VoiceWireChunk[], lines: VoiceLineCatalog): number =>
  readVoiceStream(chunks).deltas.filter((delta) => pieceKind(delta.text, lines) === "speech").length;

/** A turn's recording, or the error that kept it from having one; never a rejected promise left unread. */
type PostedTurn = { recording: VoiceWireRecording } | { error: unknown };

const posted = (pending: Promise<VoiceWireRecording>): Promise<PostedTurn> =>
  pending.then((recording) => ({ recording }), (error: unknown) => ({ error }));

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "The request failed with a non-Error value.");

/**
 * Runs a voice case's call on a session of its own: the `before` steps in order, each caller turn
 * waited out, then the scored turn, observed. When the case has an `interruption`, the caller speaks
 * it over the scored turn once enough of the turn's speech has arrived, and the call waits that turn
 * out too. Where there are records, the scored turn's is the one its request's arrival names.
 */
const runVoiceCall = async (stack: VoiceCallStack, evalCase: ConversationQualityCase): Promise<VoiceTurnObservation> => {
  const call = evalCase.voice ?? {};
  const settle = stack.settle ?? (<T>(pending: Promise<T>) => pending);
  const sessionKey = `voice-eval-${randomUUID()}`;
  let requestsSent = 0;
  const post = (utterance: string, onChunk?: (chunks: readonly VoiceWireChunk[]) => void): Promise<VoiceWireRecording> => {
    requestsSent += 1;
    return postVoiceTurn(stack.door, { sessionKey, utterance, ...(call.locale ? { locale: call.locale } : {}) }, stack.clock, onChunk);
  };
  /** Waits for every request so far to finish its turn; the record of the `request`-th, from zero. */
  const recordOf = async (request: number): Promise<Readonly<VoiceTurnSummary> | undefined> =>
    stack.turnRecords ? (await settle(stack.turnRecords.recordsOf(sessionKey, requestsSent)))[request] : undefined;

  let conversationId: string | null = null;
  for (const [index, step] of (call.before ?? []).entries()) {
    if (step.kind === "caller") {
      const recording = await settle(post(step.utterance));
      await recordOf(requestsSent - 1);
      const earlier = observeVoiceTurn(recording, stack.lines);
      if (!earlier.protocol.ok) {
        throw new Error(`The call's step ${index + 1} failed: ${earlier.protocol.problem}`);
      }
      conversationId ??= recording.conversationId;
      continue;
    }
    // A turn's stream names its conversation only once the turn has one; a session's first turn can
    // open its stream with a bridge line before that, so the session's binding is the fallback.
    conversationId ??= await settle(stack.conversations.conversationOf(sessionKey));
    if (!conversationId) {
      throw new Error(`The call's step ${index + 1} is a teammate's, but the call has no conversation yet.`);
    }
    await settle(runTeammateStep(stack.teammate, conversationId, step));
  }

  const scoredRequest = requestsSent;
  const { interruption } = call;
  // Handled from the moment it is sent, so a failure waits here to be reported, never unhandled.
  let interrupting: Promise<PostedTurn> | undefined;
  const recording = await settle(post(evalCase.query ?? "", interruption
    ? (chunks) => {
      interrupting ??= speechPieceCount(chunks, stack.lines) >= interruption.afterSpeechPieces ? posted(post(interruption.utterance)) : undefined;
    }
    : undefined));
  if (interruption) {
    if (!interrupting) {
      throw new Error(`The scored turn ended before ${interruption.afterSpeechPieces} speech piece(s) reached the caller, so nobody spoke over it.`);
    }
    const newer = await settle(interrupting);
    if ("error" in newer) {
      throw new Error(`The utterance spoken over the scored turn failed: ${errorMessage(newer.error)}`);
    }
    const heard = observeVoiceTurn(newer.recording, stack.lines);
    if (!heard.protocol.ok) {
      throw new Error(`The utterance spoken over the scored turn failed: ${heard.protocol.problem}`);
    }
  }
  const turnRecord = await recordOf(scoredRequest);
  const scored = observeVoiceTurn(recording, stack.lines);
  return turnRecord ? { ...scored, turnRecord } : scored;
};

/** A runner port that drives voice cases only; a text case is an error for this case alone. */
export const createVoiceCallRunnerPort = (stack: VoiceCallStack): ConversationQualityRunnerPort => ({
  run: (evalCase) => Promise.reject(new Error(`Case "${evalCase.id}" is a text case; this runner drives voice cases only.`)),
  voice: async (evalCase) => {
    const voiceTurn = await runVoiceCall(stack, evalCase);
    return {
      retrievedChunks: [],
      answer: voiceTurn.pieces.filter((piece) => piece.kind !== "bridge").map((piece) => piece.text).join(""),
      voiceTurn,
    };
  },
});
