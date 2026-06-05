import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("agent directives settings create, edit, warn, delete, and persist", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { directiveUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-directives`);

  await expect(page.getByRole("heading", { name: "Directives", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Built-in directives" })).toBeVisible();
  await expect(page.getByText("Read-only")).toHaveCount(3);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("handoff-tone");
  await page.getByLabel("Action").fill("When handing off to support, be calm and specific.");
  await page.getByLabel("Priority").fill("55");
  await page.getByLabel("Criticality").click();
  await page.getByRole("option", { name: "Medium" }).click();
  await page.getByRole("button", { name: "Save directive" }).click();

  await expect(page.getByText("handoff-tone")).toBeVisible();
  await expect(page.getByText("No directive conflicts were found.")).toBeVisible();
  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]).toMatchObject({
    method: "POST",
    body: {
      name: "handoff-tone",
      condition: { kind: "always" },
      action: "When handing off to support, be calm and specific.",
      priority: 55,
      criticality: "medium",
    },
  });

  await page.reload();
  await expect(page.getByText("handoff-tone")).toBeVisible();

  await page.getByRole("button", { name: "Edit handoff-tone" }).click();
  await page.getByLabel("Name").fill("conflict-tone");
  await page.getByLabel("Action").fill("Always be verbose, expansive, and include long explanations.");
  await page.getByRole("button", { name: "Save directive" }).click();

  await expect(page.getByText("conflict-tone")).toBeVisible();
  await expect(page.getByText("Potential directive conflicts")).toBeVisible();
  await expect(page.getByText("concise-readable-formatting:")).toBeVisible();
  await expect(page.getByText("The saved directive may conflict with a formatting rule.")).toBeVisible();
  await expect.poll(() => directiveUpdates.length).toBe(2);
  expect(directiveUpdates[1]).toMatchObject({
    method: "PATCH",
    body: {
      name: "conflict-tone",
      action: "Always be verbose, expansive, and include long explanations.",
      priority: 55,
      criticality: "medium",
    },
  });

  await page.reload();
  await expect(page.getByText("conflict-tone")).toBeVisible();

  await page.getByRole("button", { name: "Delete conflict-tone" }).click();
  await page.getByRole("button", { name: "Delete directive" }).click();

  await expect(page.getByText("conflict-tone")).toBeHidden();
  await expect.poll(() => directiveUpdates.length).toBe(3);
  expect(directiveUpdates[2]).toMatchObject({ method: "DELETE" });

  await page.reload();
  await expect(page.getByText("conflict-tone")).toBeHidden();
});
