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
  agent: {
    agentId: "77777777-7777-4777-8777-777777777777",
    name: "Support agent",
    deleted: false,
  },
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

  await page.route("**/backend/api/v1/evals/cases/run", async (route) => {
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

// A case can error during Run all before any run is recorded (broken snapshot),
// which never persists — so the post-run list refresh still reports it passing.
// The headline must keep the run's summary (1 error) and not flip back.
test("Run all keeps run errors in the headline after the list refresh", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);

  const latestRun = {
    id: "run-pass",
    status: "pass",
    mode: "full_assistant",
    startedAt: nowIso,
    completedAt: nowIso,
    modelId: "gpt-5-mini",
    outcomeReason: null,
  };

  await page.route("**/backend/api/v1/evals/cases/run", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          { caseId: passingCaseId, name: "Healthy case", status: "pass", run: null, error: null },
          { caseId: failingCaseId, name: "Broken snapshot", status: "error", run: null, error: "Snapshot not found" },
        ],
        // The run summary counts the pre-run failure as an error.
        summary: { total: 2, scored: 2, passing: 1, failing: 0, error: 1, pending: 0, unscored: 0 },
      }),
    });
  });

  // The persisted list NEVER reflects the broken case's error — both cases read
  // back as passing, since the error was never recorded as a run.
  await page.route("**/backend/api/v1/evals/cases", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cases: [
          { ...baseCase(passingCaseId, "Healthy case"), status: "passing", latestRun },
          { ...baseCase(failingCaseId, "Broken snapshot"), status: "passing", latestRun },
        ],
        summary: { total: 2, scored: 2, passing: 2, failing: 0, error: 0, pending: 0, unscored: 0 },
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/eval`);
  await expect(page.getByText("2 of 2 cases passing")).toBeVisible();

  await page.getByRole("button", { name: "Run all" }).click();

  // The headline reflects the run (1 error), not the persisted "all passing".
  await expect(page.getByText("1 of 2 cases passing")).toBeVisible();
  await expect(page.getByText("1 error")).toBeVisible();
  await expect(page.getByText("2 of 2 cases passing")).toHaveCount(0);
});

// Run selected — check one case and run only it (cost control). The request
// carries just that case id; the headline still reports the whole-suite rate.
test("Run selected runs only the checked case", async ({ page }) => {
  let ran = false;
  const runBodies: Array<{ caseIds?: string[] }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);

  await page.route("**/backend/api/v1/evals/cases/run", async (route) => {
    runBodies.push(route.request().postDataJSON());
    ran = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: [{ caseId: failingCaseId, name: "Refund policy fails", status: "pass", run: null, error: null }],
        summary: { total: 2, scored: 2, passing: 2, failing: 0, error: 0, pending: 0, unscored: 0 },
      }),
    });
  });

  await page.route("**/backend/api/v1/evals/cases", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const run = (status: string) => ({
      id: `run-${status}`,
      status,
      mode: "full_assistant",
      startedAt: nowIso,
      completedAt: nowIso,
      modelId: "gpt-5-mini",
      outcomeReason: null,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cases: [
          { ...baseCase(passingCaseId, "Refund policy passes"), status: "passing", latestRun: run("pass") },
          {
            ...baseCase(failingCaseId, "Refund policy fails"),
            status: ran ? "passing" : "failing",
            latestRun: run(ran ? "pass" : "fail"),
          },
        ],
        summary: ran
          ? { total: 2, scored: 2, passing: 2, failing: 0, error: 0, pending: 0, unscored: 0 }
          : { total: 2, scored: 2, passing: 1, failing: 1, error: 0, pending: 0, unscored: 0 },
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/eval`);
  await expect(page.getByText("1 of 2 cases passing")).toBeVisible();

  await page.getByLabel("Select eval case Refund policy fails").check();
  await page.getByRole("button", { name: "Run selected (1)" }).click();

  await expect(page.getByText("2 of 2 cases passing")).toBeVisible();
  expect(runBodies).toEqual([{ mode: "full_assistant", caseIds: [failingCaseId] }]);
});
