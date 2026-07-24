import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  baseSkillCapabilities,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("agent settings saves behavior and channel sections without retrieval drift", async ({ page }) => {
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior`);

  await expect(page.getByRole("heading", { name: "Identity & appearance", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}\\?tab=behavior$`));
  await page.getByLabel("Assistant name").fill("Marta Knowledge Desk");

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    name: "Marta Knowledge Desk",
  });
  expect(agentUpdates.at(-1)).not.toHaveProperty("retrieval");

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels`);
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}\\?tab=channels$`));
  await expect(page.getByRole("heading", { name: "Public chat link", level: 1 })).toBeVisible();
  await page.locator("#anonChatToggle").click();

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(2);
  expect(agentUpdates.at(-1)).toMatchObject({
    surfaceSettings: {
      anonymousChat: {
        enabled: true,
      },
    },
  });
  expect(agentUpdates.at(-1)).not.toHaveProperty("retrieval");
});

test("agent channels menu exposes the WhatsApp connector", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
  });

  await page.route("**/backend/api/v1/connectors/whatsapp", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "whatsapp",
        name: "WhatsApp",
        description: "Route WhatsApp Business messages into Radioso assistant replies.",
        enabled: false,
        errorStatus: null,
        supportsManualSync: false,
        schema: [
          {
            key: "phone_number_id",
            label: "Phone number ID",
            type: "text",
            required: true,
          },
          {
            key: "access_token",
            label: "Access Token",
            type: "secret",
            required: true,
          },
          {
            key: "app_secret",
            label: "App Secret",
            type: "secret",
            required: true,
          },
          {
            key: "webhook_verify_token",
            label: "Webhook Verify Token",
            type: "generated_secret",
            required: true,
          },
        ],
        config: {
          access_token: "****oken",
          app_secret: "****cret",
          webhook_verify_token: "verify-token-1234",
        },
        webhookUrl: "https://radioso.test/api/connectors/whatsapp/workspace-1/webhook",
        syncState: {
          backfillCompletedAt: null,
          syncRequestedAt: null,
          syncStartedAt: null,
          lastRunAt: null,
          lastModifiedAt: null,
          lastIngestedCount: null,
        },
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=whatsapp-channel`);

  await expect(page.getByRole("link", { name: "WhatsApp" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "WhatsApp", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Configure WhatsApp" }).click();
  const dialog = page.getByRole("dialog", { name: /WhatsApp/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Copy webhook URL")).toBeVisible();
  await expect(dialog.getByLabel("Copy webhook verify token")).toBeVisible();
  await expect(dialog.getByText("verify-token-1234")).toBeVisible();
  await expect(dialog.getByText("Phone number ID")).toBeVisible();
});

test("retrieval skill settings expose individual temporal event toggles", async ({ page }) => {
  const agentSkillRequests: Array<{ method: string; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    agentSkillRequests,
    skillCapabilities: baseSkillCapabilities(),
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Add new skill" }).click();
  await page.getByRole("button", { name: /Knowledge Retrieval/i }).click();
  await expect(page.getByRole("dialog", { name: "Configure Knowledge Retrieval" })).toBeVisible();
  await page.getByLabel("Skill name").fill("retrieve_events");
  await page.getByRole("button", { name: "Advanced" }).click();

  // Unset fields inherit the system default (ON for the temporal behaviors),
  // and the switches render that effective state; toggling stores an explicit
  // per-agent value.
  await expect(page.getByRole("switch", { name: "Temporal structured lookup" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Upcoming event boost" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Deterministic temporal sort" })).toBeChecked();

  await page.getByRole("switch", { name: "Temporal structured lookup" }).click();
  await page.getByRole("switch", { name: "Upcoming event boost" }).click();
  await page.getByRole("switch", { name: "Deterministic temporal sort" }).click();
  await expect(page.getByRole("switch", { name: "Temporal structured lookup" })).not.toBeChecked();
  await page.getByRole("button", { name: "Create skill" }).click();

  await expect(page.getByText("@retrieve_events", { exact: true })).toBeVisible();
  await expect.poll(() => agentSkillRequests.length).toBeGreaterThanOrEqual(1);
  expect(agentSkillRequests.at(-1)).toMatchObject({
    method: "POST",
    path: `/agents/${defaultAgentId}/skills`,
    body: {
      capability: "retrieve",
      config: {
        temporalStructuredLookupEnabled: false,
        temporalBoostUpcomingEnabled: false,
        temporalDeterministicSortEnabled: false,
      },
    },
  });
});
