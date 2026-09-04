import { expect, test, type Page } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const exportedBundle = {
  bundleVersion: 1,
  portability: { agent: "portable", routines: "portable" },
  agent: {
    schemaVersion: 3,
    name: "Procurement Bot",
    internalName: "Procurement (EU)",
    customInstruction: "Answer with precise procurement guidance.",
    authoredDirectives: [
      { name: "procurement-tone", action: "Use the procurement team's tone." },
    ],
  },
  routines: [{ name: "book-a-demo", version: 2, definition: { name: "book-a-demo" } }],
  contextVariables: [{ variableName: "plan_tier", source: "pushed" }],
  agentSkills: [
    {
      name: "crm.create_lead",
      capability: "webhook_call",
      invocationMode: "routine_named",
      enabled: true,
      config: {},
      omittedConfigKeys: ["delivery.webhook.url"],
      target: { kind: "webhook_destination", id: { __ref: "agentSkillTarget" } },
    },
  ],
};

/**
 * The bundle routes are registered after the shared fixture so they win for these
 * two paths; everything else falls through to the fixture's catch-all.
 */
const installBundleRoutes = async (
  page: Page,
  captured: { imported: unknown[] },
) => {
  await page.route("**/backend/api/v1/agents/*/bundle", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(exportedBundle),
    });
  });

  await page.route("**/backend/api/v1/agents/bundle", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    captured.imported.push(JSON.parse(route.request().postData() ?? "null"));
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        agentId: "9a0d1f2e-3b4c-4d5e-8f60-112233445566",
        unresolved: [
          {
            kind: "skill_target_unbound",
            element: "skill:crm.create_lead",
            detail: 'Bind "crm.create_lead" to a webhook_destination in this workspace, then enable it.',
          },
          {
            kind: "skill_config_not_portable",
            element: "skill:crm.create_lead",
            detail: 'The source agent set delivery.webhook.url on "crm.create_lead". Those values stay in their own workspace — re-enter them here.',
          },
          {
            kind: "context_variable_missing",
            element: "contextVariable:plan_tier",
            detail: 'No context variable named "plan_tier" exists in this workspace. Create it, then enable it on the agent.',
          },
        ],
      }),
    });
  });
};

test("an operator exports an agent to a file", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await installBundleRoutes(page, { imported: [] });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);
  await expect(page.getByRole("heading", { name: "Move this agent" })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("agent-bundle-export-button").click(),
  ]);

  // The filename is what the operator finds on disk a month later.
  expect(download.suggestedFilename()).toMatch(/^[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page.getByTestId("agent-bundle-export-result")).toContainText(download.suggestedFilename());
});

test("an operator imports a bundle and is told what did not come across", async ({ page }) => {
  const captured: { imported: unknown[] } = { imported: [] };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await installBundleRoutes(page, captured);

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);
  await expect(page.getByRole("heading", { name: "Move this agent" })).toBeVisible();

  // The agent switcher's trigger is labelled with the agent, so read the name from
  // the same fixture the mocks serve rather than hard-coding it.
  await page.getByRole("button", { name: basePlatformSettings().assistant.assistantName }).first().click();
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByTestId("create-agent-import-option").click();

  await expect(page.getByRole("heading", { name: "Import an agent bundle" })).toBeVisible();

  await page.getByTestId("agent-bundle-file-input").setInputFiles({
    name: "procurement-bot-2026-09-04.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exportedBundle)),
  });

  // What the operator is about to create, before they create it.
  await expect(page.getByTestId("agent-bundle-summary-name")).toHaveText("Procurement Bot");

  await page.getByTestId("agent-bundle-import-button").click();

  await expect(page.getByRole("heading", { name: "Agent imported" })).toBeVisible();
  const unresolved = page.getByTestId("agent-bundle-unresolved-item");
  // Two elements, not three entries: the skill's two reasons group under the skill.
  await expect(unresolved).toHaveCount(2);
  await expect(unresolved.first()).toContainText("crm.create_lead");
  await expect(unresolved.first()).toContainText("Bind");
  await expect(unresolved.first()).toContainText("delivery.webhook.url");
  await expect(unresolved.nth(1)).toContainText("plan_tier");
  await expect(page.getByTestId("agent-bundle-open-agent")).toBeVisible();

  expect(captured.imported).toHaveLength(1);
});

test("a file that is not a bundle is refused before anything is created", async ({ page }) => {
  const captured: { imported: unknown[] } = { imported: [] };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() });
  await installBundleRoutes(page, captured);

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);
  // The agent switcher's trigger is labelled with the agent, so read the name from
  // the same fixture the mocks serve rather than hard-coding it.
  await page.getByRole("button", { name: basePlatformSettings().assistant.assistantName }).first().click();
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByTestId("create-agent-import-option").click();

  await page.getByTestId("agent-bundle-file-input").setInputFiles({
    name: "holiday-photos.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ hello: "world" })),
  });

  await expect(page.getByTestId("agent-bundle-file-error")).toHaveText("That file is not an agent bundle.");
  await expect(page.getByTestId("agent-bundle-import-button")).toBeDisabled();
  expect(captured.imported).toHaveLength(0);
});
