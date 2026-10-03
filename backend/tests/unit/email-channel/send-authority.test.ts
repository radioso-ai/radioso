import { describe, expect, it } from "vitest";

import { operatorSendAuthority } from "../../../src/modules/emailChannel/outbound/sendAuthority.js";

const REMOVED = new Date("2026-10-01T00:00:00.000Z");

const activeMailbox = { removedAt: null };
const readyDomain = { sendingStatus: "verified" as const, removedAt: null };

describe("operatorSendAuthority (research B6, first attempt of an operator-authorized send)", () => {
  it("allows the send when the mailbox is active and its domain is verified for sending", () => {
    expect(operatorSendAuthority({ mailbox: activeMailbox, domain: readyDomain })).toEqual({ verdict: "allow" });
  });

  it.each(["pending", "failed"] as const)("halts with sending_not_verified when the domain is %s", (sendingStatus) => {
    expect(operatorSendAuthority({ mailbox: activeMailbox, domain: { sendingStatus, removedAt: null } }))
      .toEqual({ verdict: "halt", haltReason: "sending_not_verified" });
  });

  it("halts with domain_removed when the domain was removed, even if it was verified", () => {
    expect(operatorSendAuthority({ mailbox: activeMailbox, domain: { sendingStatus: "verified", removedAt: REMOVED } }))
      .toEqual({ verdict: "halt", haltReason: "domain_removed" });
  });

  it("halts with domain_removed when the domain no longer exists", () => {
    expect(operatorSendAuthority({ mailbox: activeMailbox, domain: null }))
      .toEqual({ verdict: "halt", haltReason: "domain_removed" });
  });

  it.each([
    ["removed", { removedAt: REMOVED }],
    ["missing", null],
  ])("halts with mailbox_removed when the mailbox is %s", (_label, mailbox) => {
    expect(operatorSendAuthority({ mailbox, domain: readyDomain }))
      .toEqual({ verdict: "halt", haltReason: "mailbox_removed" });
  });

  it("names the removed domain first when both the domain and the mailbox are gone, since re-adding the domain is the fix", () => {
    expect(operatorSendAuthority({ mailbox: { removedAt: REMOVED }, domain: { sendingStatus: "verified", removedAt: REMOVED } }))
      .toEqual({ verdict: "halt", haltReason: "domain_removed" });
  });

  it("names the removed mailbox before an unverified domain, since verifying would not make it sendable", () => {
    expect(operatorSendAuthority({ mailbox: { removedAt: REMOVED }, domain: { sendingStatus: "pending", removedAt: null } }))
      .toEqual({ verdict: "halt", haltReason: "mailbox_removed" });
  });

  it("does not depend on the engagement mode or the enabled flag, which govern only automatic sends", () => {
    const disabledOperatorOnly = { removedAt: null, enabled: false, engagementMode: "operator_only" as const };

    expect(operatorSendAuthority({ mailbox: disabledOperatorOnly, domain: readyDomain })).toEqual({ verdict: "allow" });
  });
});
