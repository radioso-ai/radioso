import { expect, test, type Page } from "@playwright/test";

import { installDashboardApiMocks, seedDashboardStorage, workspaceId, workspaceKey } from "./dashboard-fixtures";

/** The workspace-effective role the server resolves, account role and workspace grant together. */
const installEffectiveRole = async (page: Page, effectiveRole: "owner" | "admin" | "member") => {
  await page.route(`**/backend/api/v1/account/workspaces/${workspaceId}/api-access`, async (route) => {
    await route.fulfill({
      json: {
        effectiveRole,
        capabilities: { manageOwnPersonalTokens: true, auditWorkspacePersonalTokens: false, manageServiceAccounts: effectiveRole !== "member" },
        defaults: { personalTokenLifetimeDays: 90, serviceCredentialLifetimeDays: 365 },
        limits: { personalTokensPerUser: 10, serviceAccountsPerWorkspace: 50, credentialsPerServiceAccount: 5, maximumPageSize: 100 },
        legacyCredentialMigration: { active: false },
      },
    });
  });
};

/** The privacy settings endpoint over one stored window, recording every save. */
const installPrivacySettings = async (page: Page, conversationRetentionDays: number | null) => {
  const state = { conversationRetentionDays, saves: [] as unknown[] };
  await page.route("**/backend/api/v1/settings/privacy", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as { conversationRetentionDays: number | null };
      state.saves.push(body);
      state.conversationRetentionDays = body.conversationRetentionDays;
    }
    await route.fulfill({ json: { conversationRetentionDays: state.conversationRetentionDays } });
  });
  return state;
};

const openRetention = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/settings?tab=workspace&anchor=data-retention`);
  await expect(page.getByRole("heading", { name: "Conversation retention" })).toBeVisible();
};

test("an admin sets a retention window after confirming that older conversations are erased", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installEffectiveRole(page, "admin");
  const privacy = await installPrivacySettings(page, null);
  await openRetention(page);

  await expect(page.getByText("Conversations stay until someone deletes them.")).toBeVisible();
  await page.getByLabel("Keep conversations").click();
  await page.getByRole("option", { name: "1 year" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Erase conversations after 365 days?")).toBeVisible();
  await dialog.getByRole("button", { name: "Erase after 365 days" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("Conversations with no activity for 365 days are erased with everything derived from them.")).toBeVisible();
  expect(privacy.saves).toEqual([{ conversationRetentionDays: 365 }]);
});

test("lengthening the window saves without asking, and a custom window outside the range cannot be saved", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installEffectiveRole(page, "owner");
  const privacy = await installPrivacySettings(page, 90);
  await openRetention(page);

  await page.getByLabel("Keep conversations").click();
  await page.getByRole("option", { name: "Custom" }).click();
  await page.getByLabel("Days", { exact: true }).fill("5");
  await expect(page.getByText("Enter whole days from 7 to 3650.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await page.getByLabel("Days", { exact: true }).fill("400");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByText("Conversations with no activity for 400 days are erased with everything derived from them.")).toBeVisible();
  expect(privacy.saves).toEqual([{ conversationRetentionDays: 400 }]);
});

test("a member sees the window without a way to change it", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installEffectiveRole(page, "member");
  await installPrivacySettings(page, 180);
  await openRetention(page);

  await expect(page.getByText("Only owners and admins can change this.")).toBeVisible();
  await expect(page.getByLabel("Keep conversations")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
});
