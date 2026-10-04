import { describe, expect, it } from "vitest";

import {
  canResume,
  isHumanOwned,
  ownerLabel,
  presentOwnership,
  type ConversationOwnershipRecord,
} from "../../../src/modules/handoff/public.js";

const humanOwnedRecord = (
  overrides: Partial<ConversationOwnershipRecord> = {},
): ConversationOwnershipRecord => ({
  conversationId: "conversation_1",
  workspaceId: "workspace_1",
  state: "human_owned",
  ownerAccountId: "operator_1",
  ownerUserId: "user_1",
  ownerProfile: { displayName: "Ada Operator", email: "ada@example.com" },
  ownerStoredLabel: "ada@example.com",
  reason: "operator_takeover",
  version: 3,
  takenOverAt: new Date("2026-06-17T12:00:00.000Z"),
  createdAt: new Date("2026-06-17T11:59:00.000Z"),
  updatedAt: new Date("2026-06-17T12:00:00.000Z"),
  ...overrides,
});

describe("ownership state helpers", () => {
  it("detects human-owned conversations", () => {
    expect(isHumanOwned(humanOwnedRecord())).toBe(true);
    expect(isHumanOwned(humanOwnedRecord({ state: "ai_owned", ownerAccountId: null, ownerUserId: null, ownerProfile: null, ownerStoredLabel: null }))).toBe(false);
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
    expect(canResume(humanOwnedRecord({ state: "ai_owned", ownerAccountId: null, ownerUserId: null, ownerProfile: null, ownerStoredLabel: null }))).toEqual({ ok: true });
  });
});

describe("owner label", () => {
  it("names the owner from their current profile, so a rename shows at once", () => {
    expect(ownerLabel(humanOwnedRecord())).toBe("Ada Operator");
    expect(ownerLabel(humanOwnedRecord({ ownerProfile: { displayName: null, email: "ada@example.com" } }))).toBe("ada@example.com");
  });

  it("falls back to the label stored at claim while the row still names its user", () => {
    expect(ownerLabel(humanOwnedRecord({ ownerProfile: null, ownerStoredLabel: "Ada Operator" }))).toBe("Ada Operator");
  });

  it("names nobody once the row names no user, whatever label it kept", () => {
    // The owner's user was deleted: the foreign key nulled owner_user_id and left the rest.
    expect(ownerLabel(humanOwnedRecord({ ownerUserId: null, ownerProfile: null, ownerStoredLabel: "ada@example.com" }))).toBeNull();
    expect(ownerLabel(humanOwnedRecord({ ownerUserId: null, ownerProfile: null, ownerStoredLabel: null }))).toBeNull();
  });

  it("presents a conversation whose owner is gone as waiting for a teammate: no label, no taken-over time", () => {
    const orphaned = humanOwnedRecord({ ownerUserId: null, ownerProfile: null, ownerStoredLabel: "ada@example.com" });

    expect(presentOwnership(orphaned)).toMatchObject({
      state: "human_owned",
      ownerUserId: null,
      ownerDisplayName: null,
      takenOverAt: null,
    });
    expect(JSON.stringify(presentOwnership(orphaned))).not.toContain("ada@example.com");
  });

  it("presents the record with the label as ownerDisplayName and none of the raw owner fields", () => {
    const record = humanOwnedRecord();

    expect(presentOwnership(record)).toEqual({
      conversationId: record.conversationId,
      workspaceId: record.workspaceId,
      state: "human_owned",
      ownerAccountId: record.ownerAccountId,
      ownerUserId: record.ownerUserId,
      ownerDisplayName: "Ada Operator",
      reason: record.reason,
      version: record.version,
      takenOverAt: record.takenOverAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  });
});
