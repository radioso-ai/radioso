import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const snapshotId = "44444444-4444-4444-8444-444444444444";
const passingCaseId = "55555555-5555-4555-8555-555555555555";
const failingCaseId = "66666666-6666-4666-8666-666666666666";

const baseCase = (id: string, name: string) => ({
  id,
  workspaceId,
  snapshotId,
  name,
  assertions: [{ type: "answer_contains", pattern: "refund", matchMode: "substring" }],
  status: "pending" as const,
  lastRunId: null,
  createdAt: nowIso,
  updatedAt: nowIso,
});

// Suite-level Run all + headline pass rate (issue #793, item 1). The list is
// served stateful: the second GET (after Run all) reflects the run outcomes.
test("Run all reports a suite pass rate and refreshes the list", async ({ page }) => {
  let ranAll = false;
  const runAllBodies: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);

  await page.route("**/backend/api/v1/evals/cases/run-all", async (route) => {
    runAllBodies.push(route.request().postDataJSON());
    ranAll = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          { caseId: passingCaseId, name: "Refund policy passes", status: "pass", run: null, error: null },
          { caseId: failingCaseId, name: "Refund policy fails", status: "pass", run: null, error: null },
        ],
        summary: { total: 2, scored: 2, passing: 2, failing: 0, error: 0, pending: 0, unscored: 0 },
      }),
    });
  });

  await page.route("**/backend/api/v1/evals/cases", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const passingRun = (status: string) => ({
      id: `run-${status}`,
      status,
      mode: "full_assistant",
      startedAt: nowIso,
      completedAt: nowIso,
      modelId: "gpt-5-mini",
      outcomeReason: null,
    });
    const body = ranAll
      ? {
          cases: [
            { ...baseCase(passingCaseId, "Refund policy passes"), status: "passing", latestRun: passingRun("pass") },
            { ...baseCase(failingCaseId, "Refund policy fails"), status: "passing", latestRun: passingRun("pass") },
          ],
          summary: { total: 2, scored: 2, passing: 2, failing: 0, error: 0, pending: 0, unscored: 0 },
        }
      : {
          cases: [
            { ...baseCase(passingCaseId, "Refund policy passes"), status: "passing", latestRun: passingRun("pass") },
            { ...baseCase(failingCaseId, "Refund policy fails"), status: "failing", latestRun: passingRun("fail") },
          ],
          summary: { total: 2, scored: 2, passing: 1, failing: 1, error: 0, pending: 0, unscored: 0 },
        };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(`/w/${workspaceKey}/eval`);

  await expect(page.getByText("1 of 2 cases passing")).toBeVisible();
  await expect(page.getByText("1 failing")).toBeVisible();

  await page.getByRole("button", { name: "Run all" }).click();

  await expect(page.getByText("2 of 2 cases passing")).toBeVisible();
  expect(runAllBodies).toContainEqual({ mode: "full_assistant" });
});
