import { expect, test, type Page, type Route } from "@playwright/test";

type StaffRole = "support_read" | "billing_write" | "owner";

const accountId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

test.skip(process.env.RADIOSO_EDITION !== "enterprise", "Operator console routes are generated only for enterprise frontend builds.");

type TierProfile = {
  key: string;
  displayName: string;
  monthlyAnswerLimit: number | null;
  storedDocumentLimit: number;
  storedIndexedByteLimit: number;
  monthlyIndexedByteLimit: number | null;
  monthlyConversationLimit: number | null;
  repliesPerConversation: number;
  createdAt: string;
  updatedAt: string;
};

type StaffFixture = {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  status: string;
  lastLoginAt: string | null;
};

const starterProfile: TierProfile = {
  key: "starter",
  displayName: "Starter",
  monthlyAnswerLimit: 10,
  storedDocumentLimit: 20,
  storedIndexedByteLimit: 1024 * 1024 * 1024,
  monthlyIndexedByteLimit: 2 * 1024 * 1024 * 1024,
  monthlyConversationLimit: null,
  repliesPerConversation: 10,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

/** A catalog plan: it bills conversations and leaves the answer cap dormant. */
const cometProfile: TierProfile = {
  key: "comet",
  displayName: "Comet",
  monthlyAnswerLimit: null,
  storedDocumentLimit: 2000,
  storedIndexedByteLimit: 10 * 1024 * 1024,
  monthlyIndexedByteLimit: 20 * 1024 * 1024,
  monthlyConversationLimit: 50,
  repliesPerConversation: 10,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

const planetProfile: TierProfile = {
  key: "planet",
  displayName: "Planet",
  monthlyAnswerLimit: null,
  storedDocumentLimit: 50000,
  storedIndexedByteLimit: 100 * 1024 * 1024,
  monthlyIndexedByteLimit: 200 * 1024 * 1024,
  monthlyConversationLimit: 5000,
  repliesPerConversation: 10,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

const growthProfile: TierProfile = {
  key: "growth",
  displayName: "Growth",
  monthlyAnswerLimit: 100,
  storedDocumentLimit: 200,
  storedIndexedByteLimit: 10 * 1024 * 1024 * 1024,
  monthlyIndexedByteLimit: null,
  monthlyConversationLimit: null,
  repliesPerConversation: 10,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

type ConversationSpendFixture = {
  periodStart: string;
  repliesPerConversation: number;
  meteredConversations: number;
  spendEur: number;
  averageEurPerConversation: number | null;
  flagAboveEurPerConversation: number;
  flag: "above" | "below" | "undetermined" | "none";
  unpricedCalls: number;
};

const conversationSpend = (overrides: Partial<ConversationSpendFixture> = {}): ConversationSpendFixture => ({
  periodStart: "2026-06-01",
  repliesPerConversation: 10,
  meteredConversations: 60,
  spendEur: 1.26,
  averageEurPerConversation: 0.021,
  flagAboveEurPerConversation: 0.04,
  flag: "below",
  unpricedCalls: 0,
  ...overrides,
});

/** An account whose conversations run long: about eight replies each. */
const longConversationSpend = conversationSpend({ spendEur: 3.09, averageEurPerConversation: 0.0515, flag: "above" });

/** An account whose priced calls average under the flag, with some calls on a model the catalog has no price for. */
const undeterminedConversationSpend = conversationSpend({ unpricedCalls: 14, flag: "undetermined" });

const usage = (profile: TierProfile = starterProfile) => ({
  accountId,
  organizationName: "Alpha Research",
  profile,
  monthlyAnswers: {
    periodStart: "2026-06-01",
    resetAt: "2026-07-01T00:00:00.000Z",
    used: 7,
    // A conversation-metered tier leaves this cap dormant, as the backend does.
    limit: profile.monthlyConversationLimit === null ? profile.monthlyAnswerLimit : null,
  },
  monthlyConversations: profile.monthlyConversationLimit === null
    ? null
    : {
      periodStart: "2026-06-01",
      resetAt: "2026-07-01T00:00:00.000Z",
      used: 62,
      limit: profile.monthlyConversationLimit,
      credits: 0,
      byKind: { conversation: 60, copilot: 2, test_run: 0, pulse_report: 0 },
    },
  storedDocuments: { used: 3, limit: profile.storedDocumentLimit },
  storedIndexedBytes: { used: 1024 * 1024, limit: profile.storedIndexedByteLimit },
  monthlyIndexedBytes: {
    periodStart: "2026-06-01",
    resetAt: "2026-07-01T00:00:00.000Z",
    used: 2 * 1024 * 1024,
    limit: profile.monthlyIndexedByteLimit,
  },
});

const lastMonthSpend = conversationSpend({
  periodStart: "2026-05-01",
  meteredConversations: 41,
  spendEur: 0.82,
  averageEurPerConversation: 0.02,
});

const json = async (route: Route, body: unknown, status = 200) => {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
};

const installOperatorConsoleMocks = async (
  page: Page,
  role: StaffRole = "owner",
  startingProfile: TierProfile = starterProfile,
  spend: ConversationSpendFixture = conversationSpend(),
) => {
  const requestLog: string[] = [];
  let currentUsage = usage(startingProfile);
  let tiers = [starterProfile, growthProfile, cometProfile, planetProfile];
  let staff: StaffFixture[] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.com",
      name: "Owner",
      role,
      status: "active",
      lastLoginAt: "2026-06-29T10:00:00.000Z",
    },
  ];

  await page.route("**/api/v1/ee/operator-console/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/v1\/ee\/operator-console/, "");
    requestLog.push(`${route.request().method()} ${path}`);

    if (path === "/auth/login" && route.request().method() === "POST") {
      await json(route, { staff: staff[0] });
      return;
    }
    if (path === "/auth/me" && route.request().method() === "GET") {
      await json(route, { staff: staff[0] });
      return;
    }
    if (path === "/auth/logout" && route.request().method() === "POST") {
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/organizations" && route.request().method() === "GET") {
      await json(route, {
        rows: [
          {
            accountId,
            name: "Alpha Research",
            ownerEmail: "owner@example.com",
            ownerCount: 2,
            profileKey: currentUsage.profile?.key ?? null,
            profileDisplayName: currentUsage.profile?.displayName ?? null,
            monthlyAnswers: {
              used: currentUsage.monthlyAnswers.used,
              limit: currentUsage.monthlyAnswers.limit,
            },
            monthlyConversations: currentUsage.monthlyConversations
              ? {
                used: currentUsage.monthlyConversations.used,
                limit: currentUsage.monthlyConversations.limit,
              }
              : null,
            conversationSpend: spend,
          },
        ],
        pageInfo: { limit: 25, offset: Number(url.searchParams.get("offset") ?? 0), nextOffset: null, hasMore: false, total: 1 },
      });
      return;
    }
    if (path === `/organizations/${accountId}/usage` && route.request().method() === "GET") {
      await json(route, { ...currentUsage, conversationSpend: { current: spend, previous: lastMonthSpend } });
      return;
    }
    if (path === `/organizations/${accountId}/tier` && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { profileKey: string | null };
      currentUsage = usage(tiers.find((tier) => tier.key === body.profileKey) ?? starterProfile);
      // The usage summary alone, as the backend answers a tier change: no spend.
      await json(route, currentUsage);
      return;
    }
    if (path === "/tiers" && route.request().method() === "GET") {
      await json(route, { tiers });
      return;
    }
    if (path.startsWith("/tiers/") && route.request().method() === "PUT") {
      const key = decodeURIComponent(path.replace("/tiers/", ""));
      const body = route.request().postDataJSON() as TierProfile;
      const profile = {
        ...starterProfile,
        key,
        displayName: body.displayName,
        monthlyAnswerLimit: body.monthlyAnswerLimit,
        storedDocumentLimit: body.storedDocumentLimit,
        storedIndexedByteLimit: body.storedIndexedByteLimit,
        monthlyIndexedByteLimit: body.monthlyIndexedByteLimit,
      };
      tiers = [...tiers.filter((tier) => tier.key !== key), profile];
      await json(route, { profile });
      return;
    }
    if (path === "/staff" && route.request().method() === "GET") {
      if (role !== "owner") {
        await json(route, { error: { code: "forbidden", message: "Forbidden" } }, 403);
        return;
      }
      await json(route, { staff });
      return;
    }
    if (path === "/staff" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { email: string; name: string; role: StaffRole };
      const created = {
        id: "22222222-2222-4222-8222-222222222222",
        email: body.email,
        name: body.name,
        role: body.role,
        status: "active",
        lastLoginAt: null,
      };
      staff = [...staff, created];
      await json(route, { staff: created }, 201);
      return;
    }
    await json(route, { error: { code: "not_found", message: "Not found" } }, 404);
  });

  return requestLog;
};

test("staff can sign in and review the organization directory and detail usage", async ({ page }) => {
  await installOperatorConsoleMocks(page, "billing_write");

  await page.goto("/operator/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/operator\/organizations/);
  await expect(page.getByText("Alpha Research")).toBeVisible();
  await expect(page.getByText("owner@example.com")).toBeVisible();
  await expect(page.getByText("Starter")).toBeVisible();
  await page.getByLabel("Open Alpha Research").click();

  await expect(page.getByText("Monthly answers")).toBeVisible();
  await expect(page.getByText("Stored indexed bytes")).toBeVisible();
  await expect(page.getByText("Current: Starter")).toBeVisible();
});

test("the directory reads the conversation meter for a catalog tier", async ({ page }) => {
  await installOperatorConsoleMocks(page, "billing_write", cometProfile);

  await page.goto("/operator/organizations");

  const row = page.getByRole("row").filter({ hasText: "Alpha Research" });
  await expect(row).toContainText("Comet");
  await expect(row).toContainText("62 / 50 conv");
});

test("the directory and detail page flag an account whose conversations cost more than the plan can carry", async ({ page }) => {
  await installOperatorConsoleMocks(page, "support_read", cometProfile, longConversationSpend);

  await page.goto("/operator/organizations");

  const row = page.getByRole("row").filter({ hasText: "Alpha Research" });
  await expect(row).toContainText("€0.052 / conv");
  await expect(row.getByRole("img", { name: "Above the €0.040 per conversation flag" })).toBeVisible();

  await page.getByLabel("Open Alpha Research").click();

  await expect(page.getByText("Model spend per conversation")).toBeVisible();
  await expect(page.getByText("Warn only: above the €0.040 per conversation flag.")).toBeVisible();
  await expect(page.getByText("41 metered conversations")).toBeVisible();
  await expect(page.getByText(/counted at the tier's current 10 replies per conversation, so changing it re-counts both/)).toBeVisible();
});

test("a figure missing calls on unpriced models reads as undetermined, not as a pass", async ({ page }) => {
  await installOperatorConsoleMocks(page, "support_read", cometProfile, undeterminedConversationSpend);

  await page.goto("/operator/organizations");

  const row = page.getByRole("row").filter({ hasText: "Alpha Research" });
  await expect(row).toContainText("≥ €0.021 / conv (undetermined)");
  await expect(row.getByRole("img", { name: /per conversation flag/ })).toHaveCount(0);

  await page.getByLabel("Open Alpha Research").click();

  await expect(page.getByText("Undetermined: 14 calls on models with no list price are left out, so this month may be above the €0.040 flag.")).toBeVisible();
});

test("the directory shows spend per conversation without a flag for a typical account", async ({ page }) => {
  await installOperatorConsoleMocks(page, "support_read", cometProfile);

  await page.goto("/operator/organizations");

  const row = page.getByRole("row").filter({ hasText: "Alpha Research" });
  await expect(row).toContainText("€0.021 / conv");
  await expect(row.getByRole("img", { name: /per conversation flag/ })).toHaveCount(0);
});

test("the tier preview warns when a catalog tier caps conversations below current usage", async ({ page }) => {
  await installOperatorConsoleMocks(page, "billing_write", planetProfile);

  await page.goto(`/operator/organizations/${accountId}`);
  await page.getByLabel("Target tier").selectOption("comet");

  await expect(page.getByText(/selected tier is below current usage for Monthly conversations/)).toBeVisible();
});

test("billing staff can change an organization's tier", async ({ page }) => {
  const requests = await installOperatorConsoleMocks(page, "billing_write");
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(`/operator/organizations/${accountId}`);
  await page.getByLabel("Target tier").selectOption("growth");
  await page.getByRole("button", { name: "Change tier" }).click();

  await expect(page.getByText("Current: Growth")).toBeVisible();
  // The tier change answers without spend; the card keeps the spend already read.
  await expect(page.getByText("Model spend per conversation")).toBeVisible();
  expect(requests).toContain(`PUT /organizations/${accountId}/tier`);
});

test("billing staff can create a tier with byte limits in human units", async ({ page }) => {
  await installOperatorConsoleMocks(page, "billing_write");

  await page.goto("/operator/tiers");
  await page.getByLabel("Key").fill("scale");
  await page.getByLabel("Display name").fill("Scale");
  await page.getByLabel("Monthly answer limit").fill("1000");
  await page.getByLabel("Stored document limit").fill("250");
  await page.getByLabel("Stored indexed byte limit").fill("1024 MB");
  await page.getByLabel("Monthly indexed byte limit").fill("2 GB");
  await page.getByRole("button", { name: "Save tier" }).click();

  const scaleRow = page.getByRole("row").filter({ hasText: "scale" });
  await expect(scaleRow).toContainText("Scale");
  await expect(scaleRow).toContainText("1 GB");
  await expect(scaleRow).toContainText("2 GB");
});

test("support_read staff sees read-only tier UI and no staff management", async ({ page }) => {
  await installOperatorConsoleMocks(page, "support_read");

  await page.goto("/operator/tiers");
  await expect(page.getByText("Read-only staff can view tier limits but cannot edit the catalog.")).toBeVisible();
  await expect(page.getByRole("button", { name: /edit starter/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Staff" })).toHaveCount(0);

  await page.goto(`/operator/organizations/${accountId}`);
  await expect(page.getByText("Read-only staff can view usage but cannot change tiers.")).toBeVisible();
});

test("owner can create staff users", async ({ page }) => {
  await installOperatorConsoleMocks(page, "owner");

  await page.goto("/operator/staff");
  await page.getByLabel("Email").fill("billing@example.com");
  await page.getByLabel("Name").fill("Billing");
  await page.getByLabel("Role").selectOption("billing_write");
  await page.getByLabel("Temporary password").fill("password-123");
  await page.getByRole("button", { name: "Create staff" }).click();

  const billingRow = page.getByRole("row").filter({ hasText: "billing@example.com" });
  await expect(billingRow).toContainText("Billing");
});
