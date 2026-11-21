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
  await page.getByLabel("Used by", { exact: true }).click();
  await page.getByRole("option", { name: "The agent, in every reply" }).click();

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
  await dialog.getByLabel("Type", { exact: true }).click();
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

test("a refused save and an unusable option list explain themselves inside the edit dialog", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    contextVariables: [
      {
        id: "88888888-8888-4888-8888-000000000001",
        name: "topic",
        description: null,
        valueType: "enum",
        options: [
          { key: "billing", label: "Billing", description: null, archived: false },
          { key: "shipping", label: "Shipping", description: null, archived: false },
        ],
        trustTier: "unverified",
        sensitivity: "normal",
        defaultSurfacing: "on_reference",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as never,
    ],
  });
  const refusal = "This attribute has values, so its type can’t change.";
  await page.route("**/backend/api/v1/context-variables/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    return route.fulfill({
      status: 409,
      json: { error: { code: "context_variable_has_values", message: "The value type of a context variable that has values cannot change" } },
    });
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-context-variables`);
  await expect(page.getByRole("heading", { name: "Attributes", level: 1 })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Compiling")).toHaveCount(0, { timeout: 15000 });

  await page.getByRole("button", { name: "Edit topic" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit attribute" });

  // Archiving every option says why Save is off, without touching Name first.
  await dialog.getByRole("button", { name: "Archive Billing" }).click();
  await expect(dialog.getByText("Keep at least one option active.")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Archive Shipping" }).click();
  await expect(dialog.getByText("Keep at least one option active.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save attribute" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Restore Shipping" }).click();
  await expect(dialog.getByText("Keep at least one option active.")).toHaveCount(0);

  // A refused save shows in the dialog and is gone once the dialog is cancelled.
  await dialog.getByRole("button", { name: "Save attribute" }).click();
  await expect(dialog.getByText(refusal)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(refusal)).toHaveCount(0);
  await page.getByRole("button", { name: "Edit topic" }).click();
  await expect(page.getByRole("dialog", { name: "Edit attribute" }).getByText(refusal)).toHaveCount(0);
});

test("advanced attribute settings stay closed by default and open when one is set", async ({ page }) => {
  const contextVariableRequests: ContextVariableRequestFixture[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    contextVariableRequests,
    contextVariables: [
      {
        id: "88888888-8888-4888-8888-0000000000a2",
        name: "plan",
        description: null,
        valueType: "string",
        options: null,
        trustTier: "signed",
        sensitivity: "normal",
        defaultSurfacing: "on_reference",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as never,
    ],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-context-variables`);
  await expect(page.getByRole("heading", { name: "Attributes", level: 1 })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Compiling")).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByText("Signed", { exact: true })).toBeVisible();

  // A default attribute keeps Advanced closed.
  await page.getByRole("button", { name: "Add attribute" }).click();
  const createDialog = page.getByRole("dialog", { name: "Add attribute" });
  await expect(createDialog.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "false");
  await expect(createDialog.getByLabel("Signed by your server")).toBeHidden();

  // Checking both boxes is sent as trustTier and sensitivity.
  await createDialog.getByLabel("Name", { exact: true }).fill("account_tier");
  await createDialog.getByRole("button", { name: "Advanced" }).click();
  await createDialog.getByLabel("Signed by your server").check();
  await createDialog.getByLabel("Private data").check();
  await createDialog.getByRole("button", { name: "Add attribute" }).click();
  await expect.poll(() => contextVariableRequests.find((request) => request.method === "POST")?.body).toMatchObject({
    name: "account_tier",
    trustTier: "signed",
    sensitivity: "sensitive",
  });

  // An attribute with a non-default setting opens Advanced by itself.
  await page.getByRole("button", { name: "Edit plan" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit attribute" });
  await expect(editDialog.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
  await expect(editDialog.getByLabel("Signed by your server")).toBeChecked();
  await expect(editDialog.getByLabel("Private data")).not.toBeChecked();
});
