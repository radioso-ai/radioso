import { describe, expect, it } from "vitest";

import {
  autoDispatchAuthority,
  autoSendAuthority,
  firstAttemptAuthority,
  operatorSendAuthority,
  repostAuthorized,
} from "../../../src/modules/emailChannel/outbound/sendAuthority.js";

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

describe("autoSendAuthority (FR-032, research B9: an automatic send as it is dispatched)", () => {
  const autoMailbox = { removedAt: null, enabled: true, engagementMode: "auto" as const, policyVersion: 4 };
  const facts = (overrides: Partial<Parameters<typeof autoSendAuthority>[0]> = {}): Parameters<typeof autoSendAuthority>[0] => ({
    mailbox: autoMailbox,
    domain: readyDomain,
    ownership: { state: "ai_owned", version: 2 },
    bound: { policyVersion: 4, ownershipVersion: 2 },
    ...overrides,
  });

  it("authorizes an enabled auto mailbox at the bound policy, an AI-owned conversation at the bound ownership, and a verified domain", () => {
    expect(autoSendAuthority(facts())).toEqual({ authorized: true });
  });

  it.each([
    ["the mailbox is gone", { mailbox: null }, "mailbox_removed"],
    ["the mailbox was removed", { mailbox: { ...autoMailbox, removedAt: REMOVED } }, "mailbox_removed"],
    ["the policy moved past the bound version", { mailbox: { ...autoMailbox, policyVersion: 5 } }, "policy_changed"],
    ["the send was bound to no policy", { bound: { policyVersion: null, ownershipVersion: 2 } }, "policy_changed"],
    ["the mailbox is disabled", { mailbox: { ...autoMailbox, enabled: false } }, "mailbox_disabled"],
    ["the mailbox drafts", { mailbox: { ...autoMailbox, engagementMode: "draft" as const } }, "mode_not_auto"],
    ["a person owns the conversation", { ownership: { state: "human_owned" as const, version: 3 } }, "human_owned"],
    ["the ownership moved past the bound version", { ownership: { state: "ai_owned" as const, version: 4 } }, "ownership_changed"],
    ["the domain was removed", { domain: { sendingStatus: "verified" as const, removedAt: REMOVED } }, "domain_removed"],
    ["the domain is not verified", { domain: { sendingStatus: "pending" as const, removedAt: null } }, "sending_not_verified"],
  ] as const)("refuses when %s", (_label, overrides, code) => {
    expect(autoSendAuthority(facts(overrides))).toEqual({ authorized: false, code });
  });
});

describe("repostAuthorized (research B6: after an unknown outcome, re-POST only while the trigger's authority holds)", () => {
  const autoFacts = {
    mailbox: { removedAt: null, enabled: true, engagementMode: "auto" as const, policyVersion: 4 },
    domain: readyDomain,
    ownership: { state: "ai_owned" as const, version: 2 },
  };

  it("holds an automatic send to the automatic authority it was bound to", () => {
    const authority = { policyVersion: 4, ownershipVersion: 2 };
    expect(repostAuthorized({ trigger: "auto_reply", authority }, autoFacts)).toBe(true);
    expect(repostAuthorized({ trigger: "auto_reply", authority }, { ...autoFacts, ownership: { state: "human_owned", version: 3 } })).toBe(false);
    expect(repostAuthorized({ trigger: "auto_reply", authority }, { ...autoFacts, mailbox: { ...autoFacts.mailbox, engagementMode: "draft", policyVersion: 5 } })).toBe(false);
  });

  it("holds an operator-authorized send only to the mailbox's ability to send, whatever the mode or the owner", () => {
    const authority = { policyVersion: 1, ownershipVersion: 0 };
    const operatorFacts = { ...autoFacts, mailbox: { ...autoFacts.mailbox, engagementMode: "draft" as const, policyVersion: 9 }, ownership: { state: "human_owned" as const, version: 7 } };
    expect(repostAuthorized({ trigger: "operator_reply", authority }, operatorFacts)).toBe(true);
    expect(repostAuthorized({ trigger: "held_release", authority }, { ...operatorFacts, domain: { sendingStatus: "pending", removedAt: null } })).toBe(false);
  });
});

describe("autoDispatchAuthority (FR-022, FR-032: an automatic send as it is dispatched, against the thread's budget)", () => {
  const autoMailbox = { removedAt: null, enabled: true, engagementMode: "auto" as const, policyVersion: 4, threadSendBudget: 3 };
  const facts = (overrides: Partial<Parameters<typeof autoDispatchAuthority>[0]> = {}): Parameters<typeof autoDispatchAuthority>[0] => ({
    mailbox: autoMailbox,
    domain: readyDomain,
    ownership: { state: "ai_owned", version: 2 },
    bound: { policyVersion: 4, ownershipVersion: 2 },
    // The thread's automatic sends since its last renewal, this one's reservation among them.
    reservedAutoSends: 3,
    ...overrides,
  });

  it("authorizes a send whose reservation, counted with the thread's others, still fits the mailbox's budget", () => {
    expect(autoDispatchAuthority(facts())).toEqual({ authorized: true });
  });

  it("refuses with send_budget once the budget was lowered below the thread's reserved sends", () => {
    expect(autoDispatchAuthority(facts({ mailbox: { ...autoMailbox, threadSendBudget: 2 } }))).toEqual({ authorized: false, code: "send_budget" });
  });

  it("refuses with send_budget when the thread has no budget to count against", () => {
    expect(autoDispatchAuthority(facts({ reservedAutoSends: null }))).toEqual({ authorized: false, code: "send_budget" });
  });

  it("names a revoked authority before the budget", () => {
    expect(autoDispatchAuthority(facts({ ownership: { state: "human_owned", version: 3 }, reservedAutoSends: 9 })))
      .toEqual({ authorized: false, code: "human_owned" });
  });
});

describe("firstAttemptAuthority (research B6, B9: what a send is checked against before its request freezes)", () => {
  const autoMailbox = { removedAt: null, enabled: true, engagementMode: "auto" as const, policyVersion: 4, threadSendBudget: 3 };
  const facts = (overrides: Partial<Parameters<typeof firstAttemptAuthority>[1]> = {}): Parameters<typeof firstAttemptAuthority>[1] => ({
    mailbox: autoMailbox,
    domain: readyDomain,
    ownership: { state: "ai_owned", version: 2 },
    reservedAutoSends: 1,
    ...overrides,
  });
  const auto = { trigger: "auto_reply", authority: { policyVersion: 4, ownershipVersion: 2 } };

  it("checks an operator-authorized send only against the mailbox's ability to send", () => {
    const operator = { trigger: "held_release", authority: { policyVersion: 1, ownershipVersion: 0 } };
    expect(firstAttemptAuthority(operator, facts({ ownership: { state: "human_owned", version: 9 }, reservedAutoSends: null }))).toEqual({ verdict: "allow" });
    expect(firstAttemptAuthority(operator, facts({ domain: { sendingStatus: "pending", removedAt: null } })))
      .toEqual({ verdict: "halt", haltReason: "sending_not_verified" });
  });

  it("allows an automatic send whose automatic authority and budget still hold", () => {
    expect(firstAttemptAuthority(auto, facts())).toEqual({ verdict: "allow" });
  });

  it("halts an automatic send whose mailbox can no longer send as its address, as any send", () => {
    expect(firstAttemptAuthority(auto, facts({ mailbox: { ...autoMailbox, removedAt: REMOVED } })))
      .toEqual({ verdict: "halt", haltReason: "mailbox_removed" });
  });

  it.each([
    ["a person took the conversation", { ownership: { state: "human_owned" as const, version: 3 } }, "human_owned"],
    ["the policy changed", { mailbox: { ...autoMailbox, engagementMode: "draft" as const, policyVersion: 5 } }, "policy_changed"],
    ["the budget was lowered below the reservation", { mailbox: { ...autoMailbox, threadSendBudget: 1 }, reservedAutoSends: 2 }, "send_budget"],
  ] as const)("revokes an automatic send when %s", (_label, overrides, code) => {
    expect(firstAttemptAuthority(auto, facts(overrides))).toEqual({ verdict: "revoked", code });
  });
});
