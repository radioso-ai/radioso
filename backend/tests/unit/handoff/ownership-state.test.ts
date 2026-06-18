import { describe, expect, it } from "vitest";

import {
  canResume,
  isHumanOwned,
  resolveOwnership,
  type ConversationOwnershipRecord,
} from "../../../src/modules/handoff/public.js";

const humanOwnedRecord = (
  overrides: Partial<ConversationOwnershipRecord> = {},
): ConversationOwnershipRecord => ({
  conversationId: "conversation_1",
  workspaceId: "workspace_1",
  state: "human_owned",
  ownerAccountId: "operator_1",
  ownerDisplayName: "Ada Operator",
  reason: "operator_takeover",
  version: 3,
  takenOverAt: new Date("2026-06-17T12:00:00.000Z"),
  createdAt: new Date("2026-06-17T11:59:00.000Z"),
  updatedAt: new Date("2026-06-17T12:00:00.000Z"),
  ...overrides,
});

describe("ownership state helpers", () => {
  it("resolves a missing ownership row as ai_owned", () => {
    expect(resolveOwnership(null)).toEqual({
      state: "ai_owned",
      ownerAccountId: null,
      ownerDisplayName: null,
      reason: null,
      version: null,
      takenOverAt: null,
    });
  });

  it("resolves an existing row without changing its ownership fields", () => {
    const record = humanOwnedRecord();

    expect(resolveOwnership(record)).toEqual({
      state: "human_owned",
      ownerAccountId: record.ownerAccountId,
      ownerDisplayName: record.ownerDisplayName,
      reason: record.reason,
      version: record.version,
      takenOverAt: record.takenOverAt,
    });
  });

  it("detects human-owned conversations", () => {
    expect(isHumanOwned(humanOwnedRecord())).toBe(true);
    expect(isHumanOwned(humanOwnedRecord({ state: "ai_owned", ownerAccountId: null }))).toBe(false);
    expect(isHumanOwned(null)).toBe(false);
  });

  it("defers message-emitting resumes while a human owns the conversation", () => {
    expect(canResume(humanOwnedRecord())).toEqual({
      ok: false,
      reason: "human_owned_message_emitting_resume_deferred",
    });
  });

  it("allows explicit side-effect-only resumes under human ownership", () => {
    expect(canResume(humanOwnedRecord(), { classification: "side_effect_only" })).toEqual({
      ok: true,
    });
  });

  it("allows default message-emitting resumes when the AI owns the conversation", () => {
    expect(canResume(null)).toEqual({ ok: true });
    expect(canResume(humanOwnedRecord({ state: "ai_owned", ownerAccountId: null }))).toEqual({ ok: true });
  });
});
