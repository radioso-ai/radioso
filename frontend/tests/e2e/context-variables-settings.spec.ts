import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  type ContextVariableRequestFixture,
  workspaceKey,
} from "./dashboard-fixtures";

test.setTimeout(90000);

test("agent attribute settings create, enable, and update surfacing", async ({ page }) => {
  const contextVariableRequests: ContextVariableRequestFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { contextVariableRequests });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-context-variables`);

  await expect(page.getByRole("heading", { name: "Attributes", level: 1 })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("No attributes yet.")).toBeVisible();
  await expect(page.getByText("Compiling")).toHaveCount(0, { timeout: 15000 });

  await page.getByRole("button", { name: "Add attribute" }).click();
  await page.getByLabel("Name", { exact: true }).fill("cart");
  await page.getByLabel("Description", { exact: true }).fill("Current visitor cart from the host backend.");
  await page.getByRole("dialog", { name: "Add attribute" }).getByRole("button", { name: "Add attribute" }).click();

  await expect(page.getByText("@cart", { exact: true })).toBeVisible();
  await page.getByLabel("Enable cart").click();
  await expect(page.getByLabel("Disable cart")).toBeVisible();
  await page.getByLabel("Surfacing", { exact: true }).click();
  await page.getByRole("option", { name: "Always" }).click();

  await expect.poll(() =>
    contextVariableRequests.some((request) =>
      request.method === "POST" &&
      request.path === "/context-variables" &&
      JSON.stringify(request.body).includes('"name":"cart"')
    )
  ).toBe(true);

  await expect.poll(() =>
    contextVariableRequests.some((request) =>
      request.method === "PUT" &&
      request.path.startsWith(`/agents/${defaultAgentId}/context-variables/`) &&
      JSON.stringify(request.body).includes('"surfacing":"always"')
    )
  ).toBe(true);
});

test("an operator creates a choice attribute with described options, then archives one", async ({ page }) => {
  const contextVariableRequests: ContextVariableRequestFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { contextVariableRequests });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-context-variables`);
  await expect(page.getByRole("heading", { name: "Attributes", level: 1 })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Compiling")).toHaveCount(0, { timeout: 15000 });

  await page.getByRole("button", { name: "Add attribute" }).click();
  const dialog = page.getByRole("dialog", { name: "Add attribute" });
  await dialog.getByLabel("Name", { exact: true }).fill("topic");
  await dialog.getByLabel("Value type", { exact: true }).click();
  await page.getByRole("option", { name: "Choice" }).click();

  await dialog.getByRole("button", { name: "Add option" }).click();
  await dialog.getByLabel("Option 1 label").fill("Billing");
  await dialog.getByLabel("Option 1 key").fill("billing");
  await dialog.getByLabel("Option 1 description").fill("Invoices, refunds and payment methods.");
  await dialog.getByRole("button", { name: "Add option" }).click();
  await dialog.getByLabel("Option 2 label").fill("Shipping");
  await dialog.getByLabel("Option 2 key").fill("shipping");
  await dialog.getByRole("button", { name: "Add attribute" }).click();

  await expect(page.getByText("@topic", { exact: true })).toBeVisible();
  await expect(page.getByText("Choice · 2 options")).toBeVisible();
  await expect.poll(() => contextVariableRequests.find((request) => request.method === "POST")?.body).toMatchObject({
    name: "topic",
    valueType: "enum",
    options: [
      { key: "billing", label: "Billing", description: "Invoices, refunds and payment methods.", archived: false },
      { key: "shipping", label: "Shipping", description: null, archived: false },
    ],
  });

  await page.getByRole("button", { name: "Edit topic" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit attribute" });
  // A saved option keeps its key and is archived, not removed.
  await expect(editDialog.getByLabel("Option 2 key")).toBeDisabled();
  await expect(editDialog.getByRole("button", { name: "Remove Shipping" })).toHaveCount(0);
  await editDialog.getByRole("button", { name: "Archive Shipping" }).click();

  // A new option stays new while its key passes through a saved one on the way to its own.
  await editDialog.getByRole("button", { name: "Add option" }).click();
  await editDialog.getByLabel("Option 3 label").fill("Billing disputes");
  await editDialog.getByLabel("Option 3 key").pressSequentially("billing_disputes");
  await expect(editDialog.getByLabel("Option 3 key")).toHaveValue("billing_disputes");
  await expect(editDialog.getByLabel("Option 3 key")).toBeEnabled();
  await expect(editDialog.getByRole("button", { name: "Remove Billing disputes" })).toBeVisible();
  await editDialog.getByRole("button", { name: "Save attribute" }).click();

  await expect(page.getByText("Choice · 2 options")).toBeVisible();
  await expect.poll(() => contextVariableRequests.find((request) => request.method === "PATCH")?.body).toMatchObject({
    options: [
      { key: "billing", archived: false },
      { key: "shipping", archived: true },
      { key: "billing_disputes", label: "Billing disputes", archived: false },
    ],
  });
});
