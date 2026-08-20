import { expect, test } from "@playwright/test";

import {
  baseWebhookDestination,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  type RoutineMutationFixture,
  type WebhookDestinationMutationFixture,
  workspaceKey,
} from "./dashboard-fixtures";

test("workspace operator manages webhook destinations and one-time secrets", async ({ page }) => {
  const webhookDestinationUpdates: WebhookDestinationMutationFixture[] = [];

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

test("routine editor configures completion export with destination dropdown and payload preview", async ({ page }) => {
  const routineUpdates: RoutineMutationFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    webhookDestinations: [baseWebhookDestination()],
    routineUpdates,
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);

  await page.getByRole("button", { name: "New routine" }).click();

  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await expect(documentEditor).toBeVisible();
  // This page also has a destination called Name, so target the routine's own field.
  await page.locator("#routineName").fill("Collect pricing intake");
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("Visitor asks about pricing or wants a quote.");
  await documentEditor.getByLabel("Priority", { exact: true }).fill("20");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  const exportInstruction = documentEditor.getByLabel("Step 1 instruction");
  await exportInstruction.click();
  await exportInstruction.pressSequentially("Ask for @email");
  await page.getByRole("option", { name: /Create variable “email”/ }).click();
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "email", exact: true }).click();
  await documentEditor.getByLabel("Slot email type").selectOption("email");
  await documentEditor.getByLabel("Slot email description").fill("Visitor email address");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await page.getByLabel("Webhook destination").click();
  await page.getByRole("option", { name: "crm-leads" }).click();
  // An export with no terminal to fire on is incomplete, so pick the one this routine reaches.
  await page.locator("#document-completion-export-exportTrigger-complete").click();

  await expect(page.getByText('"email": "<email>"')).toBeVisible();
  await expect(page.getByText('"destinationRef": "33333333-3333-4333-8333-333333333333"')).toBeVisible();

  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  await documentEditor.getByRole("button", { name: "Condition", exact: true }).click();
  await documentEditor.getByLabel("Rule kind").selectOption("default");
  await documentEditor.getByLabel("Branch target").selectOption("ending:complete");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Chat", exact: true }).click();
  await documentEditor.getByLabel("Step 1 id").fill("ask_email");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await documentEditor.getByRole("button", { name: "Finish ending", exact: true }).click();
  await documentEditor.getByLabel("complete message").fill("Confirm the request was captured.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();

  await expect(page.getByRole("status", { name: "Routine valid" })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => routineUpdates.some((update) => update.method === "POST"), { timeout: 15_000 }).toBe(true);

  const createUpdate = routineUpdates.filter((update) => update.body).at(-1);
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
