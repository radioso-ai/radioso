import { expect, test, type Page } from "@playwright/test";

import { installDashboardApiMocks, seedDashboardStorage, workspaceKey } from "./dashboard-fixtures";

/** The time zone endpoint over one stored zone, recording every save. */
const installTimeZoneSettings = async (page: Page, timeZone: string | null) => {
  const state = { timeZone, saves: [] as unknown[] };
  await page.route("**/backend/api/v1/settings/time-zone", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as { timeZone: string | null };
      state.saves.push(body);
      state.timeZone = body.timeZone;
    }
    await route.fulfill({ json: { timeZone: state.timeZone } });
  });
  return state;
};

const openTimeZone = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/settings?tab=workspace&anchor=time-zone`);
  await expect(page.getByRole("heading", { name: "Time zone" })).toBeVisible();
};

test("an operator sets the workspace time zone and then clears it back to UTC", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const timeZone = await installTimeZoneSettings(page, null);
  await openTimeZone(page);

  const select = page.getByLabel("Time zone", { exact: true });
  await expect(select).toHaveText("UTC (default)");
  await expect(page.getByRole("button", { name: "Save time zone" })).toBeDisabled();

  await select.click();
  await page.getByRole("option", { name: "America/Los_Angeles" }).click();
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByRole("button", { name: "Save time zone" })).toBeDisabled();
  await expect(select).toHaveText("America/Los_Angeles");

  await select.click();
  await page.getByRole("option", { name: "UTC (default)" }).click();
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByRole("button", { name: "Save time zone" })).toBeDisabled();

  expect(timeZone.saves).toEqual([{ timeZone: "America/Los_Angeles" }, { timeZone: null }]);
});

test("a stored zone the browser does not list still shows as the current choice", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installTimeZoneSettings(page, "Etc/GMT+8");
  await openTimeZone(page);

  await expect(page.getByLabel("Time zone", { exact: true })).toHaveText("Etc/GMT+8");
});
