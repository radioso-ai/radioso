import { describe, expect, it } from "vitest";

import {
  deriveMessageSourceFromRole,
  mapMessageRow,
  type MessageRow,
} from "../../src/db/repositories/messageRepository.js";

const row = (overrides: Partial<MessageRow> = {}): MessageRow => ({
  id: "message-1",
  conversation_id: "conversation-1",
  workspace_id: "workspace-1",
  role: "user",
  content: "Hello",
  source: null,
  metadata_json: {},
  skill_name: null,
  skill_outcome: null,
  skill_status: null,
  total_latency_ms: null,
  grounding_verdict: null,
  grounding_claim_count: null,
  grounding_sourced_claim_count: null,
  grounding_unsourced_claim_count: null,
  grounding_invalid_source_count: null,
  created_at: new Date("2026-06-17T10:00:00.000Z"),
  ...overrides,
});

describe("message source discriminator", () => {
  it("returns the stored source when present", () => {
    expect(mapMessageRow(row({ role: "assistant", source: "human_agent" })).source).toBe("human_agent");
  });

  it("derives source from role for legacy rows without a stored source", () => {
    expect(mapMessageRow(row({ role: "user", source: null })).source).toBe("customer");
    expect(mapMessageRow(row({ role: "assistant", source: null })).source).toBe("ai_agent");
    expect(mapMessageRow(row({ role: "system", source: null })).source).toBe("system");
  });

  it("derives write source from the persisted role", () => {
    expect(deriveMessageSourceFromRole("user")).toBe("customer");
    expect(deriveMessageSourceFromRole("assistant")).toBe("ai_agent");
    expect(deriveMessageSourceFromRole("system")).toBe("system");
  });
});
