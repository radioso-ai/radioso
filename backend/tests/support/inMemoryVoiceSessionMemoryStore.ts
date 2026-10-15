import { randomUUID } from "node:crypto";

import {
  VoiceSessionMemory,
  type RememberedVoiceExchange,
  type VoiceInterruptionNoteState,
  type VoiceSessionArrival,
  type VoiceSessionMemoryStore,
  type VoiceSessionNoticeSource,
  type VoiceSessionRetention,
} from "../../src/modules/voiceChannel/services/voiceSessionMemory.js";
import { VOICE_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";

type NoticeHandlers = Parameters<VoiceSessionNoticeSource["subscribe"]>[0];

interface MemoryRow {
  id: string;
  key: string;
  newestSequence: string;
  previousSequence: string | null;
  touchedAt: number;
  lastBridge: { sequence: string; at: number; cutOff: boolean | null } | null;
  lastExchange: { sequence: string; exchange: RememberedVoiceExchange; note: VoiceInterruptionNoteState } | null;
}

interface RequestRow {
  sequence: string;
  memoryId: string;
  arrivedAt: number;
  settledAt: number | null;
}

/** One instance's notice connection: it hears every announcement while connected. */
export class InMemoryVoiceSessionNotices implements VoiceSessionNoticeSource {
  private readonly handlers = new Set<NoticeHandlers>();
  private connected = true;

  subscribe(handlers: NoticeHandlers): () => void {
    this.handlers.add(handlers);
    if (this.connected) {
      queueMicrotask(() => {
        if (this.handlers.has(handlers) && this.connected) {
          handlers.listening();
        }
      });
    }
    return () => {
      this.handlers.delete(handlers);
    };
  }

  deliver(notice: { sequence: string; at: number }): void {
    if (!this.connected) {
      return;
    }
    queueMicrotask(() => {
      for (const handlers of this.handlers) {
        handlers.superseded(notice);
      }
    });
  }

  /** The connection dropped: what is announced until `resume` is lost. */
  interrupt(): void {
    this.connected = false;
    for (const handlers of this.handlers) {
      handlers.interrupted();
    }
  }

  resume(): void {
    this.connected = true;
    for (const handlers of this.handlers) {
      handlers.listening();
    }
  }
}

const isNewer = (left: string, right: string): boolean => BigInt(left) > BigInt(right);

/**
 * The Postgres store's rules over process memory, for tests: one instance of it stands for the
 * database every backend instance shares, and `notices()` gives each instance its connection.
 */
export class InMemoryVoiceSessionMemoryStore implements VoiceSessionMemoryStore {
  private arrivals = 0;
  private readonly memories = new Map<string, MemoryRow>();
  private readonly requests = new Map<string, RequestRow>();
  private readonly connections = new Set<InMemoryVoiceSessionNotices>();

  notices(): InMemoryVoiceSessionNotices {
    const connection = new InMemoryVoiceSessionNotices();
    this.connections.add(connection);
    return connection;
  }

  async arrive(input: Parameters<VoiceSessionMemoryStore["arrive"]>[0]): Promise<VoiceSessionArrival> {
    const { session, now, retention } = input;
    const key = JSON.stringify([session.agentId, session.vendor, session.sessionKey]);
    this.arrivals += 1;
    const sequence = String(this.arrivals);
    let row = this.memories.get(key);
    if (row) {
      const forgotten = row.touchedAt < now - retention.forgetAfterMs && this.inFlight(row.id, now, retention).length === 0;
      row.previousSequence = row.newestSequence;
      row.newestSequence = sequence;
      row.touchedAt = now;
      if (forgotten) {
        row.lastExchange = null;
      }
    } else {
      row = { id: randomUUID(), key, newestSequence: sequence, previousSequence: null, touchedAt: now, lastBridge: null, lastExchange: null };
      this.memories.set(key, row);
    }
    const inFlightSequences = this.inFlight(row.id, now, retention);
    this.requests.set(sequence, { sequence, memoryId: row.id, arrivedAt: now, settledAt: null });
    const previous = row.previousSequence;
    const supersededSequence = previous !== null && this.requests.get(previous)?.settledAt == null ? previous : null;
    if (supersededSequence) {
      for (const connection of this.connections) {
        connection.deliver({ sequence: supersededSequence, at: now });
      }
    }
    return structuredClone({
      sessionId: row.id,
      sequence,
      supersededSequence,
      inFlightSequences,
      lastBridge: row.lastBridge,
      lastExchange: row.lastExchange,
    });
  }

  async settle(input: Parameters<VoiceSessionMemoryStore["settle"]>[0]): Promise<void> {
    const { sessionId, sequence, now, cutOff, exchange, retention } = input;
    const request = this.requests.get(sequence);
    if (request) {
      request.settledAt = now;
    }
    const row = this.rowById(sessionId);
    if (row) {
      row.touchedAt = Math.max(row.touchedAt, now);
      if (row.lastBridge?.sequence === sequence) {
        row.lastBridge.cutOff = cutOff;
      }
      if (exchange && (!row.lastExchange || isNewer(sequence, row.lastExchange.sequence))) {
        row.lastExchange = { sequence, exchange: structuredClone(exchange), note: "none" };
      }
    }
    for (const [key, other] of this.memories) {
      if (other.id !== sessionId && other.touchedAt < now - retention.forgetAfterMs && this.inFlight(other.id, now, retention).length === 0) {
        this.memories.delete(key);
        for (const [requestSequence, otherRequest] of this.requests) {
          if (otherRequest.memoryId === other.id) {
            this.requests.delete(requestSequence);
          }
        }
      }
    }
    for (const [requestSequence, old] of this.requests) {
      if (requestSequence !== sequence && old.arrivedAt <= now - retention.requestLifetimeMs) {
        this.requests.delete(requestSequence);
      }
    }
  }

  async bridgeSpoken(input: Parameters<VoiceSessionMemoryStore["bridgeSpoken"]>[0]): Promise<void> {
    const row = this.rowById(input.sessionId);
    if (row && (!row.lastBridge || !isNewer(row.lastBridge.sequence, input.sequence))) {
      row.lastBridge = { sequence: input.sequence, at: input.at, cutOff: null };
      row.touchedAt = Math.max(row.touchedAt, input.at);
    }
  }

  async claimInterruptionNote(input: Parameters<VoiceSessionMemoryStore["claimInterruptionNote"]>[0]): Promise<boolean> {
    const last = this.rowById(input.sessionId)?.lastExchange;
    if (last?.sequence !== input.exchangeSequence || last.note !== "none") {
      return false;
    }
    last.note = "pending";
    return true;
  }

  async releaseInterruptionNote(input: Parameters<VoiceSessionMemoryStore["releaseInterruptionNote"]>[0]): Promise<void> {
    const last = this.rowById(input.sessionId)?.lastExchange;
    if (last?.sequence === input.exchangeSequence && last.note === "pending") {
      last.note = input.recorded ? "recorded" : "none";
    }
  }

  async supersededAt(sequences: string[]): Promise<Map<string, number>> {
    const superseded = new Map<string, number>();
    for (const sequence of sequences) {
      const request = this.requests.get(sequence);
      const next = [...this.requests.values()]
        .filter((other) => request && other.memoryId === request.memoryId && isNewer(other.sequence, sequence))
        .sort((left, right) => (isNewer(left.sequence, right.sequence) ? 1 : -1))[0];
      if (next) {
        superseded.set(sequence, next.arrivedAt);
      }
    }
    return superseded;
  }

  private inFlight(memoryId: string, now: number, retention: VoiceSessionRetention): string[] {
    return [...this.requests.values()]
      .filter((request) => request.memoryId === memoryId && request.settledAt === null && request.arrivedAt > now - retention.requestLifetimeMs)
      .map((request) => request.sequence);
  }

  private rowById(sessionId: string): MemoryRow | undefined {
    return [...this.memories.values()].find((row) => row.id === sessionId);
  }
}

/** A session memory as a single instance holds it, over a store of its own, with the production windows. */
export const inMemoryVoiceSessionMemory = (): VoiceSessionMemory => {
  const store = new InMemoryVoiceSessionMemoryStore();
  return new VoiceSessionMemory({
    store,
    notices: store.notices(),
    windows: { replayWindowMs: VOICE_BEHAVIOR.replayWindowMs, bridgeAfterMs: VOICE_BEHAVIOR.bridgeAfterMs },
  });
};
