import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import {
  ClarificationStateRepository,
} from "../../src/db/repositories/clarificationStateRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of ClarificationStateRepository. The risky behaviour is
// the `save` upsert on session_id (one row per session), the candidates jsonb round-trip
// (filtered through isCandidate on read), the TTL expiry side effect in loadPending, and
// the status partitioning between loadPending and loadRecent. This is the spec the Kysely
// migration must preserve.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("ClarificationStateRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new ClarificationStateRepository(database.kysely);

  const sessionId = randomUUID();
  const expiredSessionId = randomUUID();
  const recentSessionId = randomUUID();
  const truncatedSessionId = randomUUID();

  const candidate = {
    id: "cand-1",
    label: "Option one",
    confidence: 0.9,
    payload: { kind: "doc", ref: "abc" },
  };

  beforeAll(async () => {
    // no FK on clarification_states.session_id; nothing to seed.
  });

  afterAll(async () => {
    await database
      .query(`DELETE FROM clarification_states WHERE session_id = ANY($1::uuid[])`, [
        [sessionId, expiredSessionId, recentSessionId, truncatedSessionId],
      ])
      .catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("save inserts a pending clarification with candidates round-tripped", async () => {
    await repository.save({
      sessionId,
      source: "retrieval",
      originalQuery: "what is the refund policy?",
      mode: "ask",
      candidates: [candidate],
      askedEventId: "evt-1",
      status: "pending",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const loaded = await repository.loadPending({ sessionId });
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe(sessionId);
    expect(loaded?.source).toBe("retrieval");
    expect(loaded?.originalQuery).toBe("what is the refund policy?");
    expect(loaded?.mode).toBe("ask");
    expect(loaded?.askedEventId).toBe("evt-1");
    expect(loaded?.status).toBe("pending");
    expect(loaded?.candidates).toEqual([candidate]);
    expect(loaded?.expiresAt).toBeInstanceOf(Date);
  });

  it("save upserts on session_id (one row per session)", async () => {
    await repository.save({
      sessionId,
      source: "routine",
      mode: "offer",
      candidates: [],
      status: "pending",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const loaded = await repository.loadPending({ sessionId });
    expect(loaded?.source).toBe("routine");
    expect(loaded?.mode).toBe("offer");
    expect(loaded?.candidates).toEqual([]);
    // originalQuery was omitted on the second save -> nulled
    expect(loaded?.originalQuery).toBeUndefined();

    const count = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM clarification_states WHERE session_id = $1`,
      [sessionId],
    );
    expect(count[0]?.count).toBe("1");
  });

  it("loadPending expires the row when past expiry, preserving the original query for debugging", async () => {
    await repository.save({
      sessionId: expiredSessionId,
      source: "retrieval",
      originalQuery: "why did this go stale?",
      candidates: [candidate],
      status: "pending",
      expiresAt: new Date(Date.now() - 1000),
    });

    const loaded = await repository.loadPending({ sessionId: expiredSessionId });
    expect(loaded).toBeNull();

    const rows = await database.query<{ status: string; original_query: string | null }>(
      `SELECT status, original_query FROM clarification_states WHERE session_id = $1`,
      [expiredSessionId],
    );
    expect(rows[0]?.status).toBe("expired");
    // Retained (not nulled) so an expired clarification stays debuggable; a
    // future turn could recover it via loadRecent within the TTL window.
    expect(rows[0]?.original_query).toBe("why did this go stale?");
  });

  it("loadPending fails closed when a stored candidate is malformed, rather than matching against a shifted position", async () => {
    // Simulate corruption `save()` itself would never produce: a candidate
    // missing a required field sits between two well-formed ones. Written via
    // raw SQL because the typed `save()` API cannot express a malformed entry.
    await database.query(
      `INSERT INTO clarification_states (session_id, source, mode, candidates, status, expires_at)
       VALUES ($1, 'retrieval', 'ask', $2::jsonb, 'pending', $3)`,
      [
        truncatedSessionId,
        JSON.stringify([
          { id: "doc-a", label: "Doc A", confidence: 0.8, payload: {} },
          { id: "doc-b", label: "Doc B" }, // missing confidence/payload -> not a candidate
          { id: "doc-c", label: "Doc C", confidence: 0.7, payload: {} },
        ]),
        new Date(Date.now() + 60 * 60 * 1000),
      ],
    );

    expect(await repository.loadPending({ sessionId: truncatedSessionId })).toBeNull();
  });

  it("loadRecent returns terminal-status rows within TTL and ignores pending", async () => {
    // pending row -> loadRecent ignores it
    expect(await repository.loadRecent({ sessionId })).toBeNull();

    await repository.save({
      sessionId: recentSessionId,
      source: "retrieval",
      candidates: [candidate],
      status: "resolved",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const recent = await repository.loadRecent({ sessionId: recentSessionId });
    expect(recent?.status).toBe("resolved");
    expect(recent?.candidates).toEqual([candidate]);
  });

  it("loadRecent returns null when the terminal row is past expiry", async () => {
    await repository.save({
      sessionId: recentSessionId,
      source: "retrieval",
      candidates: [candidate],
      status: "declined",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await repository.loadRecent({ sessionId: recentSessionId })).toBeNull();
  });

  it("clear sets the outcome status and preserves the original query for a declined outcome", async () => {
    await repository.save({
      sessionId,
      source: "retrieval",
      originalQuery: "again?",
      candidates: [candidate],
      status: "pending",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await repository.clear({ sessionId, outcome: "declined" });

    const rows = await database.query<{ status: string; original_query: string | null }>(
      `SELECT status, original_query FROM clarification_states WHERE session_id = $1`,
      [sessionId],
    );
    expect(rows[0]?.status).toBe("declined");
    // Retained so a failed mapping stays debuggable and a later turn could
    // recover the question; loadPending correctly still reports no pending
    // row (status is no longer "pending"), so this does not change routing.
    expect(rows[0]?.original_query).toBe("again?");
    expect(await repository.loadPending({ sessionId })).toBeNull();
  });

  it("clear defaults the outcome to resolved and nulls the original query", async () => {
    await repository.save({
      sessionId,
      source: "retrieval",
      originalQuery: "one more time?",
      candidates: [candidate],
      status: "pending",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await repository.clear({ sessionId });
    const rows = await database.query<{ status: string; original_query: string | null }>(
      `SELECT status, original_query FROM clarification_states WHERE session_id = $1`,
      [sessionId],
    );
    expect(rows[0]?.status).toBe("resolved");
    // A resolved clarification already surfaced its original query to the
    // caller before clearing (resolvePendingClarification reads
    // pending.originalQuery first), so there is nothing left to retain.
    expect(rows[0]?.original_query).toBeNull();
  });
});
