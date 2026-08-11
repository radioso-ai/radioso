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
  status: RoutineFixture["status"],
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
  status,
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
      routineCalling("55555555-5555-4555-8555-000000000101", "55555555-5555-4555-7555-000000000101", "lookup_order", "published"),
      // Same procedure, mid-revision: one routine to an author, so it must not count twice.
      routineCalling("55555555-5555-4555-8555-000000000102", "55555555-5555-4555-7555-000000000101", "lookup_order", "draft"),
      // Retired, so it can never fire and must not be counted at all.
      routineCalling("55555555-5555-4555-8555-000000000103", "55555555-5555-4555-7555-000000000103", "unused_skill", "archived"),
    ],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await expect(page.getByText("@issue_refund", { exact: true })).toBeVisible();

  const rowFor = (name: string) => page.locator("#assistant-skills-list li").filter({ hasText: `@${name}` });

  await expect(rowFor("issue_refund")).toContainText("Used by 2 directives");
  await expect(rowFor("lookup_order")).toContainText("Used by 1 routine");
  await expect(rowFor("unused_skill")).toContainText("Not used by a directive or routine");
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
