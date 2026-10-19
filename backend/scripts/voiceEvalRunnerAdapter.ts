import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";

import type { AgentVoiceSettings } from "../src/modules/agents/public.js";
import type {
  ConversationQualityCase,
  ConversationQualityRunnerPort,
  ConversationQualityVoiceCallStep,
  VoicePieceKind,
  VoiceTurnObservation,
} from "../src/modules/eval/suite/index.js";
import type { ConversationOwnershipService, OwnershipActor } from "../src/modules/handoff/public.js";

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
 * deterministic half passes its fake clock, so the times are the policy's own.
 */
export const postVoiceTurn = (
  door: VoiceRuntimeDoor,
  turn: { sessionKey: string; utterance: string; locale?: string },
  clock: () => number = Date.now,
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
    client.on("error", reject);
    client.on("response", (response) => {
      const chunks: VoiceWireChunk[] = [];
      response.setEncoding("utf8");
      response.on("data", (text: string) => chunks.push({ atMs: clock() - startedAt, text }));
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        chunks,
        outcome: headerValue(response.trailers[OUTCOME_FIELD]) ?? headerValue(response.headers[OUTCOME_FIELD]),
        conversationId: headerValue(response.headers[CONVERSATION_HEADER]),
        endedAtMs: clock() - startedAt,
      }));
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

/** Splits a stream into its SSE frames, however the socket cut it; a frame is stamped with the chunk that completed it. */
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
          } else if (typeof content === "string" && content.length > 0) {
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

const OUTCOME_KINDS: ReadonlyArray<NonNullable<VoiceTurnObservation["outcome"]>> = ["continue", "callback_requested"];

const knownOutcome = (outcome: string | null): VoiceTurnObservation["outcome"] =>
  OUTCOME_KINDS.find((kind) => kind === outcome) ?? null;

const protocolOf = (recording: VoiceWireRecording, reading: VoiceStreamReading): VoiceTurnObservation["protocol"] => {
  const problem = recording.status !== 200
    ? `The response was HTTP ${recording.status}.`
    : reading.errorFrame
      ? "The stream carried an error frame."
      : reading.unreadableFrames > 0
        ? `The stream carried ${reading.unreadableFrames} frame(s) that are not chat.completion.chunk JSON.`
        : !reading.done
          ? "The stream ended without [DONE]."
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

/** The voice turns' own log records, for a runner that shares the process serving them. */
export interface VoiceTurnLogReader {
  /** How many turn records the process has logged so far. */
  count(): number;
  /** The first record logged after the first `after`, once it is logged. */
  next(after: number): Promise<Readonly<Record<string, unknown>> | undefined>;
}

export interface VoiceCallStack {
  door: VoiceRuntimeDoor;
  teammate: VoiceCallTeammate;
  lines: VoiceLineCatalog;
  clock?: () => number;
  /** Waits for one step of a call; the deterministic half moves its fake clock while it waits. */
  settle?: <T>(pending: Promise<T>) => Promise<T>;
  turnLogs?: VoiceTurnLogReader;
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

/**
 * Runs a voice case's call on a session of its own: the `before` steps in order, each caller
 * turn waited out (and its log record, where there is one, so the scored turn's record is its
 * own), then the scored turn, observed.
 */
const runVoiceCall = async (stack: VoiceCallStack, evalCase: ConversationQualityCase): Promise<VoiceTurnObservation> => {
  const call = evalCase.voice ?? {};
  const settle = stack.settle ?? (<T>(pending: Promise<T>) => pending);
  const sessionKey = `voice-eval-${randomUUID()}`;
  const callerTurn = async (utterance: string): Promise<VoiceTurnObservation & { conversationId: string | null }> => {
    const logsBefore = stack.turnLogs?.count() ?? 0;
    const recording = await settle(postVoiceTurn(stack.door, { sessionKey, utterance, ...(call.locale ? { locale: call.locale } : {}) }, stack.clock));
    const observation = observeVoiceTurn(recording, stack.lines);
    const turnLog = stack.turnLogs ? await settle(stack.turnLogs.next(logsBefore)) : undefined;
    return { ...observation, ...(turnLog ? { turnLog } : {}), conversationId: recording.conversationId };
  };

  let conversationId: string | null = null;
  for (const [index, step] of (call.before ?? []).entries()) {
    if (step.kind === "caller") {
      const earlier = await callerTurn(step.utterance);
      if (!earlier.protocol.ok) {
        throw new Error(`The call's step ${index + 1} failed: ${earlier.protocol.problem}`);
      }
      conversationId ??= earlier.conversationId;
      continue;
    }
    if (!conversationId) {
      throw new Error(`The call's step ${index + 1} is a teammate's, but the call has no conversation yet.`);
    }
    await settle(runTeammateStep(stack.teammate, conversationId, step));
  }
  const { conversationId: _scoredConversation, ...scored } = await callerTurn(evalCase.query ?? "");
  return scored;
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
