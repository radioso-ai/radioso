import { expect, test } from "@playwright/test";

import { seedDashboardStorage, workspaceId } from "./dashboard-fixtures";

/**
 * The dashboard approval page for a signed-in-tier reviewed operator MCP operation
 * (`/oauth/operator-mcp/proposal/[proposalId]`). Design §7/§16 Q4: approving records consent
 * against the exact review digest; it never applies the change itself, so this journey only
 * proves the page's own two outcomes - Approve and Decline - not execution.
 */

const reviewedOperationDetail = (overrides: Record<string, unknown> = {}) => ({
  id: "proposal-approval-1",
  targetType: "document_operation",
  targetLabel: "3 documents",
  summary: "Import 3 documents.",
  status: "pending",
  targetRef: { sourceId: null },
  preview: { current: null, proposed: null },
  currentVersionMatches: true,
  evidenceCases: null,
  workspaceId,
  reviewedOperation: {
    requirement: "signed_in_approval",
    effect: { exposure: "live", reversibility: "irreversible", metered: true },
    reviewDigest: "d".repeat(43),
    reviewCode: "AB12CD34",
    expiresAt: "2026-09-27T00:15:00.000Z",
    approvedAt: null,
    review: { counts: { create: 3, replace: 0, unchanged: 0 } },
  },
  ...overrides,
});

const availabilityResponse = { available: true, reason: "ok", canManage: true };

test("approves a signed-in-tier reviewed operation and shows the return-to-client state", async ({ page }) => {
  const proposalId = "proposal-approval-1";
  let approveCalls = 0;
  await seedDashboardStorage(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") return route.fulfill({ json: availabilityResponse });
    if (path === `/copilot/proposals/${proposalId}` && request.method() === "GET") return route.fulfill({ json: reviewedOperationDetail() });
    if (path === `/copilot/proposals/${proposalId}/approve` && request.method() === "POST") {
      approveCalls += 1;
      const body = JSON.parse(request.postData() ?? "{}") as { reviewDigest: string };
      expect(body.reviewDigest).toBe("d".repeat(43));
      return route.fulfill({ json: { status: "approved" } });
    }
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled Copilot request: ${path}` } } });
  });

  await page.goto(`/oauth/operator-mcp/proposal/${proposalId}`);

  await expect(page.getByText("Review proposal from Radioso MCP")).toBeVisible();
  // The effect line comes straight from the owner-declared facts, not a copilot-side guess.
  await expect(page.getByText("Goes live when applied", { exact: false })).toBeVisible();
  await expect(page.getByText("Can't be undone", { exact: false })).toBeVisible();
  await expect(page.getByText("Review code: AB12CD34")).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByText("Approved. Return to your MCP client to finish.")).toBeVisible();
  // Approval records consent; it never applies the change itself, so there is no apply call here.
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Decline" })).toHaveCount(0);
  expect(approveCalls).toBe(1);
});

test("declines a signed-in-tier reviewed operation", async ({ page }) => {
  const proposalId = "proposal-approval-2";
  let dismissCalls = 0;
  await seedDashboardStorage(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") return route.fulfill({ json: availabilityResponse });
    if (path === `/copilot/proposals/${proposalId}` && request.method() === "GET") return route.fulfill({ json: reviewedOperationDetail({ id: proposalId }) });
    if (path === `/copilot/proposals/${proposalId}/dismiss` && request.method() === "POST") {
      dismissCalls += 1;
      return route.fulfill({ json: { status: "dismissed" } });
    }
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled Copilot request: ${path}` } } });
  });

  await page.goto(`/oauth/operator-mcp/proposal/${proposalId}`);

  await expect(page.getByText("Review code: AB12CD34")).toBeVisible();
  await page.getByRole("button", { name: "Decline" }).click();

  await expect(page.getByText("Declined.")).toBeVisible();
  expect(dismissCalls).toBe(1);
});

test("shows a conversation-tier operation as already confirmed, with no approval controls", async ({ page }) => {
  const proposalId = "proposal-approval-3";
  await seedDashboardStorage(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") return route.fulfill({ json: availabilityResponse });
    if (path === `/copilot/proposals/${proposalId}` && request.method() === "GET") {
      return route.fulfill({ json: reviewedOperationDetail({
        id: proposalId,
        reviewedOperation: { requirement: "conversation", effect: { exposure: "draft", reversibility: "reversible", metered: false }, reviewDigest: "e".repeat(43), reviewCode: "EF56GH78", expiresAt: "2026-09-27T00:15:00.000Z", approvedAt: null, review: {} },
      }) });
    }
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled Copilot request: ${path}` } } });
  });

  await page.goto(`/oauth/operator-mcp/proposal/${proposalId}`);

  await expect(page.getByText("Confirmed in your MCP conversation.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Decline" })).toHaveCount(0);
});
