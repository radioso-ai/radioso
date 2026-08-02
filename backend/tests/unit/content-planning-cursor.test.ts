import { describe, expect, it } from "vitest";

import {
  ContentPlanCursorCodec,
  type ContentPlanCursorPayload,
} from "../../src/modules/contentPlanning/services/contentPlanCursor.js";

const payload: ContentPlanCursorPayload = {
  version: 1,
  workspaceId: "11111111-1111-4111-8111-111111111111",
  projectionGenerationId: "22222222-2222-4222-8222-222222222222",
  asOf: "2026-08-02T12:00:00.000Z",
  view: "opportunities",
  rankingVersion: 1,
  snapshotFingerprint: "a".repeat(64),
  order: {
    activeNoSupportConversationCount: 4,
    activeDegradedConversationCount: 3,
    currentConversationCount: 12,
    trendRank: 1,
    topicId: "33333333-3333-4333-8333-333333333333",
  },
};

describe("ContentPlanCursorCodec", () => {
  it("round-trips a frozen, signed ordering boundary", () => {
    const codec = new ContentPlanCursorCodec("cursor-secret");
    const encoded = codec.encode(payload);

    expect(codec.decode(encoded, {
      workspaceId: payload.workspaceId,
      view: payload.view,
      projectionGenerationId: payload.projectionGenerationId,
    })).toEqual(payload);
    expect(encoded.length).toBeLessThan(2_048);
  });

  it.each([
    ["foreign workspace", { workspaceId: "44444444-4444-4444-8444-444444444444" }],
    ["wrong view", { view: "all_interests" as const }],
    ["expired generation", { projectionGenerationId: "55555555-5555-4555-8555-555555555555" }],
  ])("rejects a %s cursor", (_label, override) => {
    const codec = new ContentPlanCursorCodec("cursor-secret");
    const encoded = codec.encode(payload);

    expect(() => codec.decode(encoded, {
      workspaceId: payload.workspaceId,
      view: payload.view,
      projectionGenerationId: payload.projectionGenerationId,
      ...override,
    })).toThrowError(/content plan cursor/i);
  });

  it("rejects tampering, a different signing key, and malformed ordering values", () => {
    const codec = new ContentPlanCursorCodec("cursor-secret");
    const encoded = codec.encode(payload);
    const separator = encoded.indexOf(".");
    const tampered = `${encoded.slice(0, separator + 1)}x${encoded.slice(separator + 2)}`;

    expect(() => codec.decode(tampered, {
      workspaceId: payload.workspaceId,
      view: payload.view,
      projectionGenerationId: payload.projectionGenerationId,
    })).toThrowError(/content plan cursor/i);
    expect(() => new ContentPlanCursorCodec("other-secret").decode(encoded, {
      workspaceId: payload.workspaceId,
      view: payload.view,
      projectionGenerationId: payload.projectionGenerationId,
    })).toThrowError(/content plan cursor/i);
    expect(() => codec.encode({
      ...payload,
      order: { ...payload.order, currentConversationCount: -1 },
    })).toThrowError(/content plan cursor/i);
  });
});
