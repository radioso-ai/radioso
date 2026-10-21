import { describe, expect, it } from "vitest";

import type { RetrievedCandidate } from "../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import {
  placeReservedPassages,
  reserveOutsideRangeCandidates,
} from "../../../src/modules/retrieval/services/temporal/dateRangePassageReservation.js";

const december = { dateFrom: "2026-12-01", dateTo: "2026-12-31" };

const candidate = (chunkId: string, metadata: Record<string, unknown> = {}): RetrievedCandidate => ({
  chunkId,
  documentId: `doc-${chunkId}`,
  title: chunkId,
  content: `${chunkId} content`,
  similarity: 0.5,
  retrievalSources: ["semantic_rewritten"],
  retrievalText: chunkId,
  semanticScore: 0.5,
  lexicalScore: 0,
  metadata,
});

const inDecember = (chunkId: string) => candidate(chunkId, { dateFrom: "2026-12-10", dateTo: "2026-12-10" });

describe("reserveOutsideRangeCandidates", () => {
  it("reserves the best-ranked candidates outside the range and fills the rest of the pool with the range", () => {
    const candidates = [
      inDecember("range-1"),
      inDecember("range-2"),
      inDecember("range-3"),
      candidate("policy"),
      candidate("january-course", { dateFrom: "2027-01-05", dateTo: "2027-01-05" }),
      candidate("faq"),
    ];

    const reservation = reserveOutsideRangeCandidates({
      candidates,
      rangeChunkIds: new Set(["range-1", "range-2", "range-3"]),
      range: december,
      reservedCount: 2,
    });

    expect([...reservation.reservedChunkIds]).toEqual(["policy", "january-course"]);
    expect(reservation.poolOf(4).map((entry) => entry.chunkId)).toEqual(["range-1", "range-2", "policy", "january-course"]);
    expect(reservation.poolOf(7).map((entry) => entry.chunkId)).toEqual(candidates.map((entry) => entry.chunkId));
  });

  it("counts a candidate dated in the range as part of it even when the lookup did not return it", () => {
    const reservation = reserveOutsideRangeCandidates({
      candidates: [inDecember("range-1"), inDecember("semantic-december"), candidate("policy")],
      rangeChunkIds: new Set(["range-1"]),
      range: december,
      reservedCount: 2,
    });

    expect([...reservation.reservedChunkIds]).toEqual(["policy"]);
  });

  it("gives the pool to the range when nothing outside it was found", () => {
    const reservation = reserveOutsideRangeCandidates({
      candidates: [inDecember("range-1"), inDecember("range-2")],
      rangeChunkIds: new Set(["range-1", "range-2"]),
      range: december,
      reservedCount: 2,
    });

    expect(reservation.reservedChunkIds.size).toBe(0);
    expect(reservation.poolOf(4).map((entry) => entry.chunkId)).toEqual(["range-1", "range-2"]);
  });
});

describe("placeReservedPassages", () => {
  it("places the reserved passages inside the answer's passage limit, after the range's leading passages", () => {
    const ordered = ["range-1", "range-2", "range-3", "range-4", "policy", "faq"].map((chunkId) => ({ chunkId }));

    const placed = placeReservedPassages({
      contexts: ordered,
      reservedChunkIds: new Set(["policy", "faq"]),
      contextTopK: 4,
    });

    expect(placed.map((entry) => entry.chunkId)).toEqual(["range-1", "range-2", "policy", "faq", "range-3", "range-4"]);
  });

  it("leaves the order alone with nothing reserved", () => {
    const ordered = [{ chunkId: "range-1" }, { chunkId: "range-2" }];

    expect(placeReservedPassages({ contexts: ordered, reservedChunkIds: new Set(), contextTopK: 4 })).toEqual(ordered);
  });
});
