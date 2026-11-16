import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
  type AgentSkillFixture,
  type RoutineFixture,
} from "./dashboard-fixtures";

const skill = (id: string, name: string): AgentSkillFixture => ({
  id,
  workspaceId: "11111111-1111-4111-8111-000000000001",
  agentId: defaultAgentId,
  name,
  capability: "retrieve",
  storedKind: "retrieve",
  target: { kind: "source_scope", id: null },
  config: {},
  invocationMode: "agent_selectable",
  enabled: true,
  createdAt: nowIso,
  updatedAt: nowIso,
});

const routineCalling = (
  id: string,
  lineageId: string,
  toolRef: string,
  enabled: boolean,
): RoutineFixture => ({
  id,
  lineageId,
  agentId: defaultAgentId,
  name: `Routine ${id}`,
  activation: { triggerDescription: "Visitor asks about an order.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [],
  steps: [{
    stableStepId: "call_skill",
    kind: "tool",
    instruction: "Call the skill.",
    toolRef,
    actionType: null,
    ordinal: 0,
    metadata: { inputBindings: {}, outputAssignments: {}, mode: "typed" },
  }],
  transitions: [{
    fromStep: "call_skill",
    toRef: "done",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: null, ordinal: 0 }],
  enabled,
  version: 1,
  createdAt: nowIso,
  updatedAt: nowIso,
});

test("the skills registry reports which directives and routines use each skill", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentSkills: [
      skill("66666666-6666-4666-8666-000000000001", "issue_refund"),
      skill("66666666-6666-4666-8666-000000000002", "lookup_order"),
      skill("66666666-6666-4666-8666-000000000003", "unused_skill"),
    ],
    directives: [
      {
        id: "44444444-4444-4444-8444-000000000101",
        name: "refund-handoff",
        action: "Refund the order using #issue_refund",
        binding: { kind: "skill", skillName: "issue_refund" },
      },
      {
        id: "44444444-4444-4444-8444-000000000102",
        name: "refund-escalation",
        action: "Escalate stalled refunds using #issue_refund",
        binding: { kind: "skill", skillName: "issue_refund" },
      },
    ],
    routines: [
      routineCalling("55555555-5555-4555-8555-000000000101", "55555555-5555-4555-7555-000000000101", "lookup_order", true),
      // Disabled, so it can never fire and must not be counted at all.
      routineCalling("55555555-5555-4555-8555-000000000103", "55555555-5555-4555-7555-000000000103", "unused_skill", false),
    ],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await expect(page.getByText("@issue_refund", { exact: true })).toBeVisible();

  const rowFor = (name: string) => page.locator("#assistant-skills-list li").filter({ hasText: `@${name}` });

  await expect(rowFor("issue_refund")).toContainText("Used by 2 directives");
  await expect(rowFor("lookup_order")).toContainText("Used by 1 routine");
  await expect(rowFor("unused_skill")).toContainText("Not used by a directive or routine");

  // The confirmation to delete a skill says who still uses it, and says nothing for one nothing uses.
  await page.getByRole("button", { name: "@issue_refund" }).click();
  await page.getByRole("dialog", { name: "@issue_refund" }).getByRole("button", { name: "Delete issue_refund" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Delete skill?" });
  await expect(confirmation).toContainText("Deletes @issue_refund from this agent. Used by 2 directives.");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "@issue_refund" })).toHaveCount(0);
  await page.getByRole("button", { name: "@unused_skill" }).click();
  await page.getByRole("dialog", { name: "@unused_skill" }).getByRole("button", { name: "Delete unused_skill" }).click();
  await expect(confirmation).toContainText("Deletes @unused_skill from this agent.");
  await expect(confirmation).not.toContainText("Used by");
});

test("the skills registry still lists skills when the referencing surfaces cannot be read", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentSkills: [skill("66666666-6666-4666-8666-000000000001", "issue_refund")],
  });
  await page.route(`**/agents/${defaultAgentId}/routines`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "server_error", message: "boom" } }) }));

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await expect(page.getByText("@issue_refund", { exact: true })).toBeVisible();
  await expect(page.locator("#assistant-skills-list")).not.toContainText("Not used by a directive or routine");
  await expect(page.locator("#assistant-skills-list").getByRole("alert")).toHaveCount(0);
});

test("a skill row opens its details, where the skill is edited or deleted", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentSkills: [
      skill("66666666-6666-4666-8666-000000000001", "issue_refund"),
      skill("66666666-6666-4666-8666-000000000002", "lookup_order"),
    ],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await page.getByRole("button", { name: "@issue_refund" }).click();
  const sheet = page.getByRole("dialog", { name: "@issue_refund" });
  await expect(sheet).toContainText("Agent decides when to use it");
  await expect(sheet).toContainText("Not used by a directive or routine");

  await sheet.getByRole("button", { name: "Edit issue_refund" }).click();
  await expect(page.getByRole("dialog", { name: "Edit skill" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Edit skill" })).toHaveCount(0);

  await page.getByRole("button", { name: "@issue_refund" }).click();
  await page.getByRole("dialog", { name: "@issue_refund" }).getByRole("button", { name: "Delete issue_refund" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Delete skill?" });
  await expect(confirmation).toContainText("Deletes @issue_refund from this agent.");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "@issue_refund" })).toBeVisible();

  await page.getByRole("dialog", { name: "@issue_refund" }).getByRole("button", { name: "Delete issue_refund" }).click();
  await confirmation.getByRole("button", { name: "Delete skill" }).click();
  await expect(page.getByRole("dialog", { name: "@issue_refund" })).toHaveCount(0);
  await expect(page.getByText("@issue_refund", { exact: true })).toHaveCount(0);
  await expect(page.getByText("@lookup_order", { exact: true })).toBeVisible();
});
