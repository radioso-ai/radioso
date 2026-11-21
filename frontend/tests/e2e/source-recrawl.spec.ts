import { expect, test, type Page } from "@playwright/test";

import { installDashboardApiMocks, nowIso, seedDashboardStorage, workspaceKey } from "./dashboard-fixtures";

// Scheduled recrawl: an operator on a plan that recrawls weekly at most sets a website source to
// keep itself up to date, then decides on the pages scheduled checks held because too many went
// missing at once: removes them on one source, keeps them on another.

const docsSourceId = "51515151-5151-4515-8515-515151515151";
const helpSourceId = "52525252-5252-4525-8525-525252525252";

type SourceState = {
  id: string;
  name: string;
  recrawlCadence: "off" | "daily" | "weekly";
  nextRecrawlAt: string | null;
  heldPageCount: number;
};

const presentSource = (source: SourceState) => ({
  id: source.id,
  kind: "website",
  name: source.name,
  externalId: `https://${source.name}`,
  lastSyncStatus: "success",
  lastSyncedAt: nowIso,
  documentCount: 40,
  documentEnrichmentOverride: "inherit",
  documentMetadata: {},
  crawlSettings: { url: `https://${source.name}`, limit: 1000, includeUrlPatterns: [], excludeUrlPatterns: [], preserveContentLinks: true },
  recrawlCadence: source.recrawlCadence,
  nextRecrawlAt: source.nextRecrawlAt,
  heldPageCount: source.heldPageCount,
  fastestRecrawlCadence: "weekly",
  createdAt: nowIso,
  updatedAt: nowIso,
});

const installRecrawlMocks = async (page: Page) => {
  const sources = new Map<string, SourceState>([
    [docsSourceId, { id: docsSourceId, name: "docs.example", recrawlCadence: "off", nextRecrawlAt: null, heldPageCount: 12 }],
    [helpSourceId, { id: helpSourceId, name: "help.example", recrawlCadence: "weekly", nextRecrawlAt: "2026-04-30T09:15:00.000Z", heldPageCount: 1 }],
  ]);
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  await page.route("**/backend/api/v1/document/sources", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sources: [...sources.values()].map(presentSource) }) });
  });
  await page.route("**/backend/api/v1/document/crawl/jobs**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [] }) });
  });
  await page.route("**/backend/api/v1/document/sources/*/recrawl-cadence", async (route) => {
    const sourceId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    const body = route.request().postDataJSON() as { recrawlCadence: SourceState["recrawlCadence"] };
    requests.push({ method: route.request().method(), path: `${sourceId}/recrawl-cadence`, body });
    const source = sources.get(sourceId)!;
    const updated = { ...source, recrawlCadence: body.recrawlCadence, nextRecrawlAt: body.recrawlCadence === "off" ? null : "2026-05-03T12:40:00.000Z" };
    sources.set(sourceId, updated);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(presentSource(updated)) });
  });
  await page.route("**/backend/api/v1/document/sources/*/held-pages/*", async (route) => {
    const [, sourceId, , decision] = new URL(route.request().url()).pathname.split("/").slice(-4);
    requests.push({ method: route.request().method(), path: `${sourceId}/held-pages/${decision}`, body: null });
    const source = sources.get(sourceId)!;
    sources.set(sourceId, { ...source, heldPageCount: 0 });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(decision === "remove"
        ? { sourceId, removedPageCount: source.heldPageCount }
        : { sourceId, keptPageCount: source.heldPageCount }),
    });
  });
  return requests;
};

test("an operator keeps a website source up to date and decides on the pages a scheduled check held", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const requests = await installRecrawlMocks(page);

  await page.goto(`/w/${workspaceKey}/knowledge?tab=sources`);
  await page.getByRole("button", { name: /docs\.example/ }).first().click();

  // The plan recrawls weekly at most, so Daily is offered but not selectable.
  await page.getByLabel("Keep up to date").click();
  await expect(page.getByRole("option", { name: "Daily" })).toBeDisabled();
  await page.getByRole("option", { name: "Weekly" }).click();
  await expect(page.getByText(/^Next check /)).toBeVisible();
  expect(requests).toContainEqual({ method: "PUT", path: `${docsSourceId}/recrawl-cadence`, body: { recrawlCadence: "weekly" } });

  // Twelve pages went missing at once; the operator removes them.
  await expect(page.getByText("12 pages are no longer on the site")).toBeVisible();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Remove 12 pages?");
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("12 pages are no longer on the site")).toBeHidden();
  expect(requests).toContainEqual({ method: "POST", path: `${docsSourceId}/held-pages/remove`, body: null });

  // On the other source, the operator keeps the one page a check held.
  await page.getByRole("button", { name: /help\.example/ }).first().click();
  await expect(page.getByText("1 page is no longer on the site")).toBeVisible();
  await page.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.getByText("1 page is no longer on the site")).toBeHidden();
  expect(requests).toContainEqual({ method: "POST", path: `${helpSourceId}/held-pages/keep`, body: null });
});
