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

describe("message interruption marker", () => {
  const assistantRow = (interruption: unknown) => row({ role: "assistant", metadata_json: { interruption } });

  it("reads the counts of a well-formed marker on an assistant reply, without its recorded time", () => {
    expect(mapMessageRow(assistantRow({ heardCharacterCount: 7, spokenCharacterCount: 16, recordedAt: "2026-10-15T10:00:00.000Z" })).interruption)
      .toEqual({ heardCharacterCount: 7, spokenCharacterCount: 16 });
  });

  it.each([
    ["an array", []],
    ["a null", null],
    ["a negative count", { heardCharacterCount: -1, spokenCharacterCount: 16 }],
    ["a string count", { heardCharacterCount: "7", spokenCharacterCount: 16 }],
    ["a fractional count", { heardCharacterCount: 7.5, spokenCharacterCount: 16 }],
    ["a missing count", { heardCharacterCount: 7 }],
  ])("reads %s as no marker", (_label, interruption) => {
    expect(mapMessageRow(assistantRow(interruption)).interruption).toBeUndefined();
  });

  it("reads no marker from a message without one, or from a message that is not an assistant reply", () => {
    expect(mapMessageRow(row({ role: "assistant" })).interruption).toBeUndefined();
    expect(mapMessageRow(row({ role: "user", metadata_json: { interruption: { heardCharacterCount: 7, spokenCharacterCount: 16 } } })).interruption)
      .toBeUndefined();
  });
});

describe("teammate reply speech marker", () => {
  const teammateRow = (speech: unknown, source: MessageRow["source"] = "human_agent") => row({ role: "assistant", source, metadata_json: { speech } });

  it("reads a pending reply, and a spoken one with the time the caller heard it", () => {
    expect(mapMessageRow(teammateRow({ state: "pending" })).speech).toEqual({ state: "pending" });
    expect(mapMessageRow(teammateRow({ state: "spoken", spokenAt: "2026-10-17T10:00:00.000Z" })).speech)
      .toEqual({ state: "spoken", spokenAt: "2026-10-17T10:00:00.000Z" });
  });

  it.each([
    ["a spoken reply with no time", { state: "spoken" }],
    ["an unknown state", { state: "heard" }],
    ["a string", "pending"],
    ["a null", null],
  ])("reads %s as no state", (_label, speech) => {
    expect(mapMessageRow(teammateRow(speech)).speech).toBeUndefined();
  });

  it("reads no state from the agent's own reply or from a caller's message", () => {
    expect(mapMessageRow(teammateRow({ state: "pending" }, "ai_agent")).speech).toBeUndefined();
    expect(mapMessageRow(row({ role: "user", metadata_json: { speech: { state: "pending" } } })).speech).toBeUndefined();
  });
});
