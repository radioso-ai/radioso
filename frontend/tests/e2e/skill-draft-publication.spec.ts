import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  defaultCandidateRevisionId,
  defaultPublishedRevisionId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
  type AgentSkillFixture,
} from "./dashboard-fixtures";

const lookupOrderId = "66666666-6666-4666-8666-000000000001";

const lookupOrder: AgentSkillFixture = {
  id: lookupOrderId,
  workspaceId: "11111111-1111-4111-8111-000000000001",
  agentId: defaultAgentId,
  name: "lookup_order",
  capability: "retrieve",
  storedKind: "retrieve",
  target: { kind: "source_scope", id: null },
  config: {},
  invocationMode: "agent_selectable",
  enabled: true,
  createdAt: nowIso,
  updatedAt: nowIso,
};

test("a skill switch is a draft change: Review & publish turns on and the review names the skill", async ({ page }) => {
  const agentSkillRequests: Array<{ method: string; path: string; body?: unknown }> = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentSkills: [lookupOrder], agentSkillRequests });

  // The backend reports a skills-only edit as a draft change; this mock flips once a skill is
  // written, and the page has to read the state again to see it.
  const skillWritten = () => agentSkillRequests.some((request) => request.method !== "GET");
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/revision-state`, async (route) => {
    if (!skillWritten()) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        agentId: defaultAgentId,
        status: "draft_dirty",
        draft: { generation: 2, basePublishedRevisionId: defaultPublishedRevisionId, updatedAt: nowIso },
        publishedRevision: { id: defaultPublishedRevisionId, label: "v1", kind: "published", versionNumber: 1, createdAt: "2026-04-26T12:00:00.000Z" },
        canPublish: true,
        proactiveGreetingEnabled: false,
      },
    });
  });
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/revisions/${defaultCandidateRevisionId}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { revision: { scopedChanges: Record<string, unknown> } };
    body.revision.scopedChanges.agentSkills = [{
      skillId: lookupOrderId,
      skillName: "lookup_order",
      change: "changed",
      before: { name: "lookup_order", kind: "retrieve", invocationMode: "agent_selectable", enabled: true },
      after: { name: "lookup_order", kind: "retrieve", invocationMode: "agent_selectable", enabled: false },
    }];
    await route.fulfill({ response, json: body });
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  await expect(page.getByText("@lookup_order", { exact: true })).toBeVisible();
  await expect(page.getByText("Skill changes are saved with the draft and go live on publish.", { exact: false })).toBeVisible();
  const reviewAndPublish = page.getByRole("button", { name: "Review & publish", exact: true });
  await expect(reviewAndPublish).toBeDisabled();

  await page.getByRole("switch", { name: "Enable lookup_order" }).click();

  await expect(reviewAndPublish).toBeEnabled();
  await reviewAndPublish.click();
  const review = page.getByRole("dialog", { name: "Review draft publication" });
  const skillsSection = review.locator("section").filter({ has: page.getByText("Skills", { exact: true }) });
  await expect(skillsSection).toContainText("@lookup_order");
  await expect(skillsSection).toContainText("(changed)");
  await expect(skillsSection).not.toContainText("Unchanged");
});
