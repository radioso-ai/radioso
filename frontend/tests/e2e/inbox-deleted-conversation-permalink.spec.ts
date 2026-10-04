import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

// Issue #1225: the operator escalation email links straight into the
// Inbox's All-lens reading pane via `conversationPermalink`
// (backend/src/shared/domain/dashboardLinks.ts) — exactly the kind of link
// that goes stale between send and click, because the conversation it points
// at can be deleted or age out of retention first. `GET
// /api/v1/history/chat/{conversationId}` then 404s, and the reading pane
// must clear the dead id out of the URL (via replace, so Back doesn't land
// the operator right back on it) and say why the pane went blank, instead of
// leaving a broken link live for a refresh or a re-share to walk back into.
test("a permalink to a deleted conversation clears the dead id from the URL and shows a not-found notice", async ({ page }) => {
  const deletedConversationId = "11111111-1111-4111-8111-111111111111";

  await seedDashboardStorage(page);
  // No `conversationDetail`/`conversationDetails` entry for this id — the
  // mock's unmatched-route fallback answers with a `{ error: { code:
  // "not_found" } }` 404, the same shape the real history endpoint returns
  // for a deleted conversation.
  await installDashboardApiMocks(page, {});
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }),
    });
  });

  await page.goto(
    `/w/${workspaceKey}/activity?tab=all&filter=chat&itemKind=chat&itemId=${deletedConversationId}`,
  );

  const response = page.getByLabel("Response", { exact: true });
  await expect(response.getByText("This conversation is no longer available.")).toBeVisible();
  await expect(page).not.toHaveURL(/itemId=/);
  await expect(page).not.toHaveURL(/itemKind=/);

  // The clearing navigation must replace the dead-id history entry, not add
  // a new one on top of it — otherwise Back re-enters the same broken link.
  await page.goBack();
  expect(page.url()).not.toContain("itemId=");
});
