import { describe, expect, it } from "vitest";

import { describeSkillTargetUses, skillTargetInUseError, type SkillTargetUse } from "../../src/shared/domain/skillTargetUses.js";

const use = (overrides: Partial<SkillTargetUse>): SkillTargetUse => ({
  agentId: "agent-support",
  agentName: "Support",
  skillName: "lookup_order",
  inDraft: true,
  inPublishedRelease: true,
  ...overrides,
});

describe("describeSkillTargetUses", () => {
  it("names a draft skill and says to delete or retarget it", () => {
    expect(describeSkillTargetUses([use({})])).toBe(
      'Used by skill "lookup_order" on agent "Support". Delete or retarget that skill first.',
    );
  });

  it("names a skill only the published version runs and says to publish first", () => {
    expect(describeSkillTargetUses([use({ inDraft: false })])).toBe(
      'The published version of agent "Support" still uses skill "lookup_order". Publish agent "Support" first.',
    );
  });

  it("names every skill, grouping what each agent's published version still uses", () => {
    const uses = [
      use({ skillName: "ticket_status" }),
      use({ agentId: "agent-sales", agentName: "Sales", skillName: "check_stock", inDraft: false }),
      use({ agentId: "agent-sales", agentName: "Sales", skillName: "reserve_item", inDraft: false }),
      use({ agentId: "agent-billing", agentName: "Billing", skillName: "refund", inDraft: true, inPublishedRelease: false }),
    ];

    expect(describeSkillTargetUses(uses)).toBe([
      'Used by skill "ticket_status" on agent "Support", skill "refund" on agent "Billing". Delete or retarget those skills first.',
      'The published version of agent "Sales" still uses skills "check_stock", "reserve_item". Publish agent "Sales" first.',
    ].join(" "));
  });

  it("says nothing when nothing uses the target", () => {
    expect(describeSkillTargetUses([])).toBe("");
  });
});

describe("skillTargetInUseError", () => {
  it("answers 409 with the kind's code, the reason in the message and the uses in the details", () => {
    const uses = [use({ inDraft: false })];

    const error = skillTargetInUseError({
      code: "api_connection_in_use",
      targetLabel: "API connection",
      uses,
      details: { connectionId: "connection-1" },
    });

    expect(error).toMatchObject({
      statusCode: 409,
      code: "api_connection_in_use",
      message: 'API connection is in use. The published version of agent "Support" still uses skill "lookup_order". Publish agent "Support" first.',
      details: { connectionId: "connection-1", skillUses: uses },
    });
  });

  it("puts what else uses the target before the skills", () => {
    const error = skillTargetInUseError({
      code: "webhook_destination_in_use",
      targetLabel: "Webhook destination",
      uses: [use({})],
      otherUses: 'Used by routine "lead intake".',
    });

    expect(error.message).toBe(
      'Webhook destination is in use. Used by routine "lead intake". Used by skill "lookup_order" on agent "Support". Delete or retarget that skill first.',
    );
  });
});
