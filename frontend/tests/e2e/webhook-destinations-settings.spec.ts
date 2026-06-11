import { expect, test } from "@playwright/test";

import {
  baseWebhookDestination,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("workspace operator manages webhook destinations and one-time secrets", async ({ page }) => {
  const webhookDestinationUpdates: Array<{ method: string; destinationId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    webhookDestinations: [baseWebhookDestination()],
    webhookDestinationUpdates,
  });

  await page.goto(`/w/${workspaceKey}/settings?tab=workspace&anchor=webhook-destinations`);

  await expect(page.getByRole("heading", { name: "Webhook destinations" })).toBeVisible();
  await expect(page.getByText("crm-leads")).toBeVisible();
  await expect(page.getByText("https://hooks.example.com/leads")).toBeVisible();

  await page.getByRole("button", { name: "New destination" }).click();
  await page.getByLabel("Destination name").fill("sales-intake");
  await page.getByLabel("Destination URL").fill("https://hooks.example.com/sales");
  await page.getByRole("button", { name: "Create destination" }).click();

  await expect(page.getByText("Signing secret", { exact: true })).toBeVisible();
  await expect(page.getByText("whsec_000002")).toBeVisible();
  expect(webhookDestinationUpdates.at(-1)).toMatchObject({
    method: "POST",
    body: {
      name: "sales-intake",
      url: "https://hooks.example.com/sales",
    },
  });

  const createdRow = page.locator("li", { hasText: "sales-intake" });
  await expect(createdRow).toBeVisible();
  await createdRow.getByRole("button", { name: "Edit sales-intake" }).click();
  await page.getByLabel("Destination URL").fill("https://hooks.example.com/sales-v2");
  await page.getByRole("button", { name: "Save destination" }).click();
  expect(webhookDestinationUpdates.at(-1)).toMatchObject({
    method: "PUT",
    body: {
      name: "sales-intake",
      url: "https://hooks.example.com/sales-v2",
    },
  });

  await createdRow.getByRole("button", { name: "Rotate secret for sales-intake" }).click();
  await expect(page.getByText("whsec_rotated_000002")).toBeVisible();
  expect(webhookDestinationUpdates.at(-1)).toMatchObject({
    method: "ROTATE_SECRET",
  });

  await createdRow.getByRole("button", { name: "Delete sales-intake" }).click();
  await expect(createdRow).toHaveCount(0);
  expect(webhookDestinationUpdates.at(-1)).toMatchObject({
    method: "DELETE",
  });
});

test("assistant skills expose and persist the webhook exports gate", async ({ page }) => {
  const agentUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await expect(page.getByRole("heading", { name: "Webhook exports" })).toBeVisible();
  await page.locator("#webhookExportsToggle").click();

  await expect.poll(() => agentUpdates.length).toBeGreaterThanOrEqual(1);
  expect(agentUpdates.at(-1)).toMatchObject({
    webhookExportsEnabled: true,
  });
});

test("routine editor configures completion export with destination dropdown and payload preview", async ({ page }) => {
  const routineUpdates: Array<{ method: string; routineId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    webhookDestinations: [baseWebhookDestination()],
    routineUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);

  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name").fill("Collect pricing intake");
  await page.getByLabel("Priority").fill("20");
  await page.getByLabel("Activation trigger").fill("Visitor asks about pricing or wants a quote.");

  await page.getByRole("button", { name: "Add slot" }).click();
  await page.getByLabel("Slot 1 key").fill("email");
  await page.getByLabel("Slot 1 type").click();
  await page.getByRole("option", { name: "email" }).click();
  await page.getByLabel("Slot 1 description").fill("Visitor email address");

  await page.getByRole("button", { name: "Enable completion export" }).click();
  await page.getByLabel("Webhook destination").click();
  await page.getByRole("option", { name: "crm-leads" }).click();

  await expect(page.getByText('"email": "<email>"')).toBeVisible();
  await expect(page.getByText('"destinationRef": "33333333-3333-4333-8333-333333333333"')).toBeVisible();

  await page.getByLabel("Step 1 id").fill("ask_email");
  await page.getByLabel("Step 1 instruction").fill("Ask for {{slot.email}} so the team can follow up.");
  await page.getByRole("button", { name: "Add transition" }).click();
  await page.getByLabel("Transition 1 target").click();
  await page.getByRole("option", { name: "complete" }).click();
  await page.getByLabel("Transition 1 guard").click();
  await page.getByRole("option", { name: "always" }).click();
  await page.getByLabel("Terminal 1 id").fill("complete");
  await page.getByLabel("Terminal 1 instruction").fill("Confirm the request was captured.");

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(() => routineUpdates.some((update) => update.method === "POST")).toBe(true);

  const createUpdate = routineUpdates.find((update) => update.method === "POST");
  expect(createUpdate).toMatchObject({
    body: {
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: "33333333-3333-4333-8333-333333333333",
      },
    },
  });
});
