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

interface RequestEntry {
  arrivedAt: number;
  instance: string;
  supersededAt?: number;
}

interface MemoryRow {
  id: string;
  newestSequence: string;
  previousSequence: string | null;
  touchedAt: number;
  requests: Map<string, RequestEntry>;
  lastBridge: { sequence: string; at: number; cutOff: boolean | null } | null;
  lastExchange: {
    sequence: string;
    exchange: RememberedVoiceExchange;
    note: VoiceInterruptionNoteState;
    owner: string | null;
    claimedAt: number | null;
  } | null;
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
 * database every backend instance shares, `clock` for the database's clock, and `notices()` gives
 * each instance its connection.
 */
export class InMemoryVoiceSessionMemoryStore implements VoiceSessionMemoryStore {
  private arrivals = 0;
  private readonly memories = new Map<string, MemoryRow>();
  private readonly connections = new Set<InMemoryVoiceSessionNotices>();

  constructor(private readonly clock: () => number = Date.now) {}

  notices(): InMemoryVoiceSessionNotices {
    const connection = new InMemoryVoiceSessionNotices();
    this.connections.add(connection);
    return connection;
  }

  async arrive(input: Parameters<VoiceSessionMemoryStore["arrive"]>[0]): Promise<VoiceSessionArrival> {
    const { session, instanceId, retention } = input;
    const at = this.clock();
    const key = JSON.stringify([session.agentId, session.vendor, session.sessionKey]);
    this.arrivals += 1;
    const sequence = String(this.arrivals);
    let row = this.memories.get(key);
    let superseded: string | null = null;
    if (row) {
      this.dropExpired(row, at, retention);
      if (row.touchedAt < at - retention.forgetAfterMs && row.requests.size === 0) {
        row.lastExchange = null;
      }
      const previous = row.requests.get(row.newestSequence);
      if (previous) {
        previous.supersededAt = at;
        superseded = row.newestSequence;
      }
      row.previousSequence = row.newestSequence;
      row.newestSequence = sequence;
      row.touchedAt = Math.max(row.touchedAt, at);
    } else {
      row = {
        id: randomUUID(),
        newestSequence: sequence,
        previousSequence: null,
        touchedAt: at,
        requests: new Map(),
        lastBridge: null,
        lastExchange: null,
      };
      this.memories.set(key, row);
    }
    const inFlightSequences = [...row.requests.keys()];
    row.requests.set(sequence, { arrivedAt: at, instance: instanceId });
    if (superseded) {
      for (const connection of this.connections) {
        connection.deliver({ sequence: superseded, at });
      }
    }
    const last = row.lastExchange;
    const noteLapsed = last?.note === "pending" && last.claimedAt !== null && last.claimedAt < at - retention.noteClaimLifetimeMs;
    return structuredClone({
      sessionId: row.id,
      sequence,
      inFlightSequences,
      lastBridge: row.lastBridge,
      lastExchange: last ? { sequence: last.sequence, exchange: last.exchange, note: noteLapsed ? "none" : last.note } : null,
    });
  }

  async settle(input: Parameters<VoiceSessionMemoryStore["settle"]>[0]): Promise<void> {
    const { sessionId, sequence, cutOff, exchange, retention } = input;
    const at = this.clock();
    const row = this.rowById(sessionId);
    if (row) {
      row.requests.delete(sequence);
      row.touchedAt = Math.max(row.touchedAt, at);
      if (row.lastBridge?.sequence === sequence) {
        row.lastBridge.cutOff = cutOff;
      }
      if (exchange && (!row.lastExchange || isNewer(sequence, row.lastExchange.sequence))) {
        row.lastExchange = { sequence, exchange: structuredClone(exchange), note: "none", owner: null, claimedAt: null };
      }
    }
    for (const [key, other] of this.memories) {
      this.dropExpired(other, at, retention);
      if (other.id !== sessionId && other.touchedAt < at - retention.forgetAfterMs && other.requests.size === 0) {
        this.memories.delete(key);
      }
    }
  }

  async claimBridge(input: Parameters<VoiceSessionMemoryStore["claimBridge"]>[0]): Promise<boolean> {
    const row = this.rowById(input.sessionId);
    if (row?.newestSequence !== input.sequence) {
      return false;
    }
    const at = this.clock();
    row.lastBridge = { sequence: input.sequence, at, cutOff: null };
    row.touchedAt = Math.max(row.touchedAt, at);
    return true;
  }

  async claimInterruptionNote(input: Parameters<VoiceSessionMemoryStore["claimInterruptionNote"]>[0]): Promise<boolean> {
    const last = this.rowById(input.sessionId)?.lastExchange;
    const at = this.clock();
    if (last?.sequence !== input.exchangeSequence) {
      return false;
    }
    const lapsed = last.note === "pending" && last.claimedAt !== null && last.claimedAt < at - input.retention.noteClaimLifetimeMs;
    if (last.note !== "none" && !lapsed) {
      return false;
    }
    last.note = "pending";
    last.owner = input.owner;
    last.claimedAt = at;
    return true;
  }

  async releaseInterruptionNote(input: Parameters<VoiceSessionMemoryStore["releaseInterruptionNote"]>[0]): Promise<void> {
    const last = this.rowById(input.sessionId)?.lastExchange;
    if (last?.sequence === input.exchangeSequence && last.note === "pending" && last.owner === input.owner) {
      last.note = input.recorded ? "recorded" : "none";
      last.owner = null;
      last.claimedAt = null;
    }
  }

  async supersededAt(requests: Array<{ sessionId: string; sequence: string }>): Promise<Map<string, number>> {
    const superseded = new Map<string, number>();
    for (const { sessionId, sequence } of requests) {
      const at = this.rowById(sessionId)?.requests.get(sequence)?.supersededAt;
      if (at !== undefined) {
        superseded.set(sequence, at);
      }
    }
    return superseded;
  }

  /** Every time this store holds for the agent's sessions moves `ms` into the past. */
  age(ms: number): void {
    for (const row of this.memories.values()) {
      row.touchedAt -= ms;
      if (row.lastBridge) {
        row.lastBridge.at -= ms;
      }
      if (row.lastExchange?.claimedAt != null) {
        row.lastExchange.claimedAt -= ms;
      }
      for (const request of row.requests.values()) {
        request.arrivedAt -= ms;
      }
    }
  }

  private dropExpired(row: MemoryRow, at: number, retention: VoiceSessionRetention): void {
    for (const [sequence, request] of row.requests) {
      if (request.arrivedAt <= at - retention.requestLifetimeMs) {
        row.requests.delete(sequence);
      }
    }
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
