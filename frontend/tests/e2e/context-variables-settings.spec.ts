import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  type ContextVariableRequestFixture,
  workspaceKey,
} from "./dashboard-fixtures";

test.setTimeout(90000);

test("agent context settings create, enable, and update surfacing", async ({ page }) => {
  const contextVariableRequests: ContextVariableRequestFixture[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { contextVariableRequests });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-context-variables`);

  await expect(page.getByRole("heading", { name: "Context", level: 1 })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("No host-defined context variables yet.")).toBeVisible();
  await expect(page.getByText("Compiling")).toHaveCount(0, { timeout: 15000 });

  await page.getByRole("button", { name: "Add variable" }).click();
  await page.getByLabel("Name", { exact: true }).fill("cart");
  await page.getByLabel("Description", { exact: true }).fill("Current visitor cart from the host backend.");
  await page.getByRole("dialog", { name: "Add context variable" }).getByRole("button", { name: "Add variable" }).click();

  await expect(page.getByText("@cart")).toBeVisible();
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
