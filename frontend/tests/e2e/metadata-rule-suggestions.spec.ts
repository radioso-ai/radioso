import { expect, test } from "@playwright/test";

import {
  baseRetrievalDefaults,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("the per-agent metadata rule editor suggests catalog fields with their declared value type", async ({ page }) => {
  const retrievalDefaults = baseRetrievalDefaults();
  // What the merged provider returns: catalog declarations plus keys observed on
  // document metadata, with the catalog's declared type winning `price`.
  retrievalDefaults.metadataFieldSuggestions = [
    { field: "category", inferredType: "string" },
    { field: "dateFrom", inferredType: "date" },
    { field: "language", inferredType: "string" },
    { field: "price", inferredType: "number" },
  ];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { retrievalDefaults });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);

  await page.getByRole("button", { name: "Add new skill" }).click();
  await page.getByRole("button", { name: /Knowledge Retrieval/i }).click();
  await expect(page.getByRole("dialog", { name: "Configure Knowledge Retrieval" })).toBeVisible();

  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("button", { name: "Add rule" }).click();

  // The datalist behind the field input is the merged suggestion list, not the
  // empty one the per-agent form used to hand the editor.
  const suggestions = page.locator("#metadata-field-suggestions option");
  await expect(suggestions).toHaveCount(4);
  await expect(suggestions.nth(0)).toHaveAttribute("value", "category");
  await expect(suggestions.nth(3)).toHaveAttribute("value", "price");

  // A new rule is seeded from the first suggestion, typed as the catalog declares it.
  await expect(page.getByText("Prefer match: category equals a value")).toBeVisible();

  // Choosing a declared date field retypes the condition, so the comparison
  // reads as a date comparison rather than a text one.
  const fieldInput = page.locator("input[list='metadata-field-suggestions']").first();
  await fieldInput.fill("dateFrom");
  await expect(page.getByText("Prefer match: dateFrom is on a value")).toBeVisible();
});
