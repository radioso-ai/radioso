import { describe, expect, it } from "vitest";

import { validateAgentInput } from "../../../src/modules/agents/domain.js";
import {
  PUBLIC_ID_FORMAT,
  ensurePublicIdMintedForInput,
  mintPublicId,
  rotatedPublicIdInput,
} from "../../../src/modules/agents/services/agentPublicIdentity.js";

const unpublished = {
  publicId: null,
  agentCardEnabled: false,
  publicAgentAccessEnabled: false,
};

describe("mintPublicId", () => {
  it("produces an ag_-prefixed base64url id carrying at least 128 bits", () => {
    const id = mintPublicId();

    expect(id).toMatch(/^ag_[A-Za-z0-9_-]{22}$/);
    expect(PUBLIC_ID_FORMAT.test(id)).toBe(true);
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 500 }, () => mintPublicId()));

    expect(ids.size).toBe(500);
  });
});

describe("ensurePublicIdMintedForInput", () => {
  it("mints nothing while the agent stays private", () => {
    const input = ensurePublicIdMintedForInput(unpublished, { name: "Support" });

    expect(input.publicId).toBeUndefined();
  });

  it("mints on the write that publishes the card", () => {
    const input = ensurePublicIdMintedForInput(unpublished, { agentCardEnabled: true });

    expect(input.agentCardEnabled).toBe(true);
    expect(input.publicId).toMatch(PUBLIC_ID_FORMAT);
  });

  it("mints on the write that opens walk-in access", () => {
    const input = ensurePublicIdMintedForInput(unpublished, {
      agentCardEnabled: true,
      publicAgentAccessEnabled: true,
    });

    expect(input.publicId).toMatch(PUBLIC_ID_FORMAT);
  });

  it("leaves an already minted id alone however often it runs", () => {
    const current = { ...unpublished, publicId: "ag_AAAAAAAAAAAAAAAAAAAAAA", agentCardEnabled: true };

    const once = ensurePublicIdMintedForInput(current, { publicDescription: "Returns and refunds" });
    const twice = ensurePublicIdMintedForInput(current, once);

    expect(once.publicId).toBeUndefined();
    expect(twice.publicId).toBeUndefined();
  });

  it("mints once for an agent whose card is already on and whose id never was", () => {
    const current = { ...unpublished, agentCardEnabled: true };

    const input = ensurePublicIdMintedForInput(current, { publicDescription: "Returns and refunds" });

    expect(input.publicId).toMatch(PUBLIC_ID_FORMAT);
  });
});

describe("rotatedPublicIdInput", () => {
  it("yields an id different from the one it replaces", () => {
    const before = mintPublicId();

    const rotated = rotatedPublicIdInput();

    expect(rotated.publicId).toMatch(PUBLIC_ID_FORMAT);
    expect(rotated.publicId).not.toBe(before);
  });
});

describe("agent public identity invariants", () => {
  it("refuses walk-in access without the card that describes it", () => {
    expect(() => validateAgentInput({ publicAgentAccessEnabled: true, agentCardEnabled: false }))
      .toThrowError(/card/i);
  });

  it("accepts a card without walk-in access", () => {
    const normalized = validateAgentInput({ agentCardEnabled: true });

    expect(normalized.agentCardEnabled).toBe(true);
    expect(normalized.publicAgentAccessEnabled).toBe(false);
  });

  it("defaults an unpublished agent to no identity at all", () => {
    const normalized = validateAgentInput({ name: "Support" });

    expect(normalized.publicId).toBeNull();
    expect(normalized.publicDescription).toBe("");
    expect(normalized.agentCardEnabled).toBe(false);
    expect(normalized.publicAgentAccessEnabled).toBe(false);
    expect(normalized.walkInConversationsPerHour).toBeNull();
  });

  it("normalizes the operator description the way every other public text field is normalized", () => {
    const normalized = validateAgentInput({ publicDescription: "  Answers   returns questions  " });

    expect(normalized.publicDescription).toBe("Answers returns questions");
  });

  it("refuses a walk-in budget that is not a positive whole number of conversations", () => {
    expect(() => validateAgentInput({ walkInConversationsPerHour: 0 })).toThrowError();
    expect(() => validateAgentInput({ walkInConversationsPerHour: 2.5 })).toThrowError();
    expect(validateAgentInput({ walkInConversationsPerHour: 25 }).walkInConversationsPerHour).toBe(25);
  });
});
