import { describe, expect, it } from "vitest";

import {
  recipientEmailChangeMetadata,
  recipientEmailDeliveryDigest,
} from "../../src/shared/domain/recipientEmailAudit.js";

describe("recipientEmailChangeMetadata", () => {
  it("records stable counts and hashes without raw addresses", () => {
    const metadata = recipientEmailChangeMetadata(
      ["Before@Example.com"],
      ["after@example.com", "AFTER@example.com"],
    );

    expect(metadata).toEqual({
      previousRecipientCount: 1,
      recipientCount: 1,
      previousRecipientHashes: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
      recipientHashes: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
    });
    expect(JSON.stringify(metadata)).not.toContain("@");
  });

  it("returns null when normalized recipient sets did not change", () => {
    expect(recipientEmailChangeMetadata(
      [" one@example.com", "two@example.com"],
      ["TWO@example.com", "one@example.com"],
    )).toBeNull();
  });

  it("binds a delivery digest to the normalized set and recipient count", () => {
    expect(recipientEmailDeliveryDigest([" One@example.com", "two@example.com"], 2))
      .toBe(recipientEmailDeliveryDigest(["two@example.com", "one@example.com"], 2));
    expect(recipientEmailDeliveryDigest(["one@example.com", "two@example.com"], 2))
      .not.toBe(recipientEmailDeliveryDigest(["one@example.com", "two@example.com"], 3));
  });
});
