import { expect, test, type Page, type Route } from "@playwright/test";

import {
  accountId,
  currentUserId,
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const handoffOwnership = (conversationId: string, owner: { userId: string; label: string } | null) => ({
  conversationId,
  workspaceId,
  state: "human_owned" as const,
  ownerAccountId: owner ? accountId : null,
  ownerUserId: owner?.userId ?? null,
  ownerDisplayName: owner?.label ?? null,
  reason: "visitor asked for a person",
  version: 1,
  takenOverAt: owner ? nowIso : null,
  createdAt: nowIso,
  updatedAt: nowIso,
});

const handoffSummary = (id: string, preview: string, owner: { userId: string; label: string } | null, sourceChannel = "authenticated_chat") => ({
  id,
  agentId: defaultAgentId,
  agentName: "Sola",
  sourceChannel,
  sourceOrigin: null,
  anonymousSessionId: null,
  createdAt: nowIso,
  updatedAt: nowIso,
  messageCount: 1,
  userMessageCount: 1,
  assistantMessageCount: 0,
  preview,
  ownership: handoffOwnership(id, owner),
});

const handoffList = (conversations: unknown[]) => ({
  historyList: { conversations, total: conversations.length, nextCursor: null, hasMore: false },
});

interface TurnTriage {
  state: string;
  version: number;
  resolution: { reason: string; note: string | null } | null;
  legacyReason: string | null;
  closedAt: string | null;
  updatedAt: string | null;
}

const feedbackTurn = (id: string, question: string, overrides: { channel?: string; version?: number; state?: string } = {}) => ({
  assistantMessageId: id,
  conversationId: `conversation-${id}`,
  agentId: defaultAgentId,
  agentName: "Sola",
  agentInternalName: null,
  channel: overrides.channel ?? "web",
  question,
  answerPreview: "Answer preview",
  skillName: null,
  skillOutcome: null,
  skillStatus: null,
  totalLatencyMs: null,
  grounding: null,
  createdAt: nowIso,
  feedback: {
    upCount: 0,
    downCount: 1,
    latestDownUpdatedAt: nowIso,
    comments: [{ value: "down", comment: "Not what I asked", createdAt: nowIso, updatedAt: nowIso }],
  },
  triage: {
    state: overrides.state ?? "open",
    version: overrides.version ?? 0,
    resolution: null,
    legacyReason: null,
    closedAt: null,
    updatedAt: null,
  } as TurnTriage,
  verification: null,
});

interface TriageRequest {
  assistantMessageId: string;
  state: string;
  expectedVersion: number;
  resolution?: { reason: string; note: string | null };
}

/** The reads of written feedback a test watched: how many arrived, and how many were answered. */
interface ListReads {
  requested: number;
  served: number;
}

/**
 * The quality backend: written feedback is listed while it is open or acknowledged, and a triage
 * write answers from `respond` (a status and body) or, by default, accepts the transition. A
 * closed turn leaves the list, as it does on the real one, and a conflict naming a state that is
 * still open updates the turn's version, as the real list would show it.
 *
 * `holdTriage` and `holdList` park a write or a read until the promise they return settles. A read
 * takes its rows when it arrives, so a parked read is one that began before later writes landed.
 */
const stubQuality = async (
  page: Page,
  turns: ReturnType<typeof feedbackTurn>[],
  options: {
    requests?: TriageRequest[];
    reads?: ListReads;
    respond?: (request: TriageRequest, attempt: number) => { status: number; body: unknown } | null;
    holdTriage?: (request: TriageRequest) => Promise<void> | undefined;
    holdList?: () => Promise<void> | undefined;
  } = {},
) => {
  const open = new Map(turns.map((turn) => [turn.assistantMessageId, turn]));
  const attempts = new Map<string, number>();
  const isClosed = (state: string) => state === "resolved" || state === "dismissed";

  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    const url = new URL(route.request().url());
    const writtenFeedback = url.searchParams.get("feedback") === "down" && url.searchParams.get("hasComment") === "true";
    const items = writtenFeedback ? [...open.values()] : [];
    if (writtenFeedback && options.reads) options.reads.requested += 1;
    if (writtenFeedback) await options.holdList?.();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: writtenFeedback ? 25 : 1, totalPages: 1 }),
    });
    if (writtenFeedback && options.reads) options.reads.served += 1;
  });

  await page.route("**/backend/api/v1/quality/turns/*/triage**", async (route: Route) => {
    const assistantMessageId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    const body = route.request().postDataJSON() as Omit<TriageRequest, "assistantMessageId">;
    const request = { assistantMessageId, ...body };
    options.requests?.push(request);
    const attempt = (attempts.get(assistantMessageId) ?? 0) + 1;
    attempts.set(assistantMessageId, attempt);

    await options.holdTriage?.(request);

    const custom = options.respond?.(request, attempt) ?? null;
    if (custom) {
      const current = (custom.body as { error?: { details?: { current?: TurnTriage } } }).error?.details?.current;
      const turn = open.get(assistantMessageId);
      if (current && isClosed(current.state)) open.delete(assistantMessageId);
      else if (current && turn) open.set(assistantMessageId, { ...turn, triage: current });
      await route.fulfill({ status: custom.status, contentType: "application/json", body: JSON.stringify(custom.body) });
      return;
    }
    if (isClosed(body.state)) open.delete(assistantMessageId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: body.state,
        version: body.expectedVersion + 1,
        resolution: body.resolution ?? null,
        legacyReason: null,
        closedAt: nowIso,
        updatedAt: nowIso,
      }),
    });
  });
};

const queueOf = (page: Page) => page.getByLabel("Inbox queue");

test("Needs-you filters by type, combined with channel, and the choice survives a reload", async ({ page }) => {
  const email = handoffSummary("conversation-email-handoff", "Email handoff", null, "email");
  const web = handoffSummary("conversation-web-handoff", "Web handoff", null, "web");

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, handoffList([email, web]));
  await stubQuality(page, [feedbackTurn("assistant-returns", "Can I return it?", { channel: "web" })]);

  await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);
  const queue = queueOf(page);
  await expect(queue.getByRole("button", { name: /Email handoff/ })).toBeVisible();
  await expect(queue.getByRole("button", { name: /Web handoff/ })).toBeVisible();
  await expect(queue.getByRole("button", { name: /Can I return it\?/ })).toBeVisible();

  await queue.getByLabel("Filter by type").click();
  await page.getByRole("option", { name: /^Feedback/ }).click();

  await expect(page).toHaveURL(/inboxType=negative_feedback/);
  await expect(queue.getByRole("button", { name: /Can I return it\?/ })).toBeVisible();
  await expect(queue.getByRole("button", { name: /Email handoff/ })).toHaveCount(0);
  await expect(queue.getByRole("button", { name: /Web handoff/ })).toHaveCount(0);

  await queue.getByLabel("Filter by type").click();
  await page.getByRole("option", { name: /^Handoffs/ }).click();
  await queue.getByLabel("Filter by channel").click();
  await page.getByRole("option", { name: "email", exact: true }).click();

  await expect(page).toHaveURL(/inboxType=handoff/);
  await expect(page).toHaveURL(/inboxChannel=email/);
  await expect(queue.getByRole("button", { name: /Email handoff/ })).toBeVisible();
  await expect(queue.getByRole("button", { name: /Web handoff/ })).toHaveCount(0);
  await expect(queue.getByRole("button", { name: /Can I return it\?/ })).toHaveCount(0);

  await page.reload();
  await expect(queue.getByLabel("Filter by type")).toContainText("Handoffs");
  await expect(queue.getByLabel("Filter by channel")).toContainText("email");
  await expect(queue.getByRole("button", { name: /Email handoff/ })).toBeVisible();
  await expect(queue.getByRole("button", { name: /Web handoff/ })).toHaveCount(0);
});

test("a row a teammate holds reads differently from one I hold, and an unclaimed one names no owner", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, handoffList([
    handoffSummary("conversation-mine", "Mine to answer", { userId: currentUserId, label: "Test Operator" }),
    handoffSummary("conversation-danas", "Dana is on it", { userId: "user-dana", label: "Dana Scully" }),
    handoffSummary("conversation-nobodys", "Nobody has this", null),
  ]));
  await stubQuality(page, []);

  await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);
  const queue = queueOf(page);

  await expect(queue.getByRole("button", { name: /Mine to answer/ })).toContainText("You are handling this");
  await expect(queue.getByRole("button", { name: /Dana is on it/ })).toContainText("Dana Scully is handling this");
  await expect(queue.getByRole("button", { name: /Dana is on it/ })).not.toContainText("You are handling this");
  await expect(queue.getByRole("button", { name: /Nobody has this/ })).not.toContainText("is handling this");
});

test.describe("bulk dismiss", () => {
  const turns = () => [
    feedbackTurn("assistant-a", "First complaint"),
    feedbackTurn("assistant-b", "Second complaint"),
    feedbackTurn("assistant-c", "Third complaint", { version: 2, state: "acknowledged" }),
  ];

  test("several feedback rows are dismissed in one action, each as a single dismissal with the chosen reason", async ({ page }) => {
    const triageRequests: TriageRequest[] = [];
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page, handoffList([handoffSummary("conversation-handoff", "A waiting handoff", null)]));
    await stubQuality(page, turns(), { requests: triageRequests });

    await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);
    const queue = queueOf(page);
    await expect(queue.getByRole("button", { name: /First complaint/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Needs you · 4$/ })).toBeVisible();

    // Only feedback can be selected: a handoff is not triage.
    await expect(queue.getByRole("checkbox")).toHaveCount(3);
    await expect(queue.getByRole("checkbox", { name: /A waiting handoff/ })).toHaveCount(0);

    await queue.getByRole("checkbox", { name: "Select First complaint" }).check();
    await queue.getByRole("checkbox", { name: "Select Third complaint" }).check();
    const bar = queue.getByRole("region", { name: "Bulk dismiss" });
    await expect(bar).toContainText("2 selected");

    await bar.getByRole("button", { name: "Dismiss" }).click();
    await page.getByRole("button", { name: "Outside the agent’s scope" }).click();

    await expect(queue.getByRole("button", { name: /First complaint/ })).toHaveCount(0);
    await expect(queue.getByRole("button", { name: /Third complaint/ })).toHaveCount(0);
    await expect(queue.getByRole("button", { name: /Second complaint/ })).toBeVisible();
    await expect(queue.getByRole("button", { name: /A waiting handoff/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Needs you · 2$/ })).toBeVisible();
    await expect(bar).toHaveCount(0);

    const resolution = { reason: "out_of_scope", note: null };
    await expect.poll(() => [...triageRequests].sort((left, right) => left.assistantMessageId.localeCompare(right.assistantMessageId)))
      .toEqual([
        { assistantMessageId: "assistant-a", state: "dismissed", expectedVersion: 0, resolution },
        { assistantMessageId: "assistant-c", state: "dismissed", expectedVersion: 2, resolution },
      ]);
  });

  test("a row that fails is reported on its own and stays selected while the rest are dismissed", async ({ page }) => {
    const triageRequests: TriageRequest[] = [];
    const conflict = (current: TurnTriage) => ({
      status: 409,
      body: { error: { code: "QUALITY_TRIAGE_CONFLICT", message: "Quality triage changed", details: { current } } },
    });
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page, handoffList([]));
    await stubQuality(page, [...turns(), feedbackTurn("assistant-d", "Fourth complaint")], {
      requests: triageRequests,
      respond: ({ assistantMessageId }, attempt) => {
        // A request that fails.
        if (assistantMessageId === "assistant-b" && attempt === 1) {
          return { status: 500, body: { error: { code: "internal_error", message: "boom" } } };
        }
        // A teammate closed it first.
        if (assistantMessageId === "assistant-c") {
          return conflict({ state: "resolved", version: 4, resolution: null, legacyReason: null, closedAt: nowIso, updatedAt: nowIso });
        }
        // A teammate acknowledged it since the queue loaded.
        if (assistantMessageId === "assistant-d" && attempt === 1) {
          return conflict({ state: "acknowledged", version: 1, resolution: null, legacyReason: null, closedAt: null, updatedAt: nowIso });
        }
        return null;
      },
    });

    await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);
    const queue = queueOf(page);
    await expect(queue.getByRole("button", { name: /First complaint/ })).toBeVisible();

    await queue.getByRole("checkbox", { name: "Select First complaint" }).check();
    const bar = queue.getByRole("region", { name: "Bulk dismiss" });
    await bar.getByRole("button", { name: "Select all 4" }).click();
    await expect(bar).toContainText("4 selected");
    await bar.getByRole("button", { name: "Dismiss" }).click();
    await page.getByRole("button", { name: "Close without reason" }).click();

    // The first dismissed and the third was already closed by someone else: both left the queue.
    await expect(queue.getByRole("button", { name: /First complaint/ })).toHaveCount(0);
    await expect(queue.getByRole("button", { name: /Third complaint/ })).toHaveCount(0);
    // The second failed and the fourth was changed: both stay, still selected, each with its own reason.
    await expect(queue.getByRole("button", { name: /Second complaint/ })).toBeVisible();
    await expect(queue.getByRole("button", { name: /Fourth complaint/ })).toBeVisible();
    await expect(queue.getByRole("checkbox", { name: "Select Second complaint" })).toBeChecked();
    await expect(queue.getByRole("checkbox", { name: "Select Fourth complaint" })).toBeChecked();
    await expect(bar).toContainText("2 selected");
    const report = bar.getByRole("status");
    await expect(report.getByRole("listitem").filter({ hasText: "Second complaint" })).toContainText("Could not dismiss. Try again.");
    await expect(report.getByRole("listitem").filter({ hasText: "Third complaint" })).toContainText("Another operator already closed it.");
    await expect(report.getByRole("listitem").filter({ hasText: "Fourth complaint" })).toContainText("Another operator changed it. Try again.");
    await expect(report).not.toContainText("First complaint");

    // The same action retries what stayed; the changed row goes at the version the teammate left it.
    await bar.getByRole("button", { name: "Dismiss" }).click();
    await page.getByRole("button", { name: "Close without reason" }).click();
    await expect(queue.getByRole("button", { name: /Second complaint/ })).toHaveCount(0);
    await expect(queue.getByRole("button", { name: /Fourth complaint/ })).toHaveCount(0);
    await expect(bar).toHaveCount(0);
    expect(triageRequests.filter((request) => request.assistantMessageId === "assistant-b")).toHaveLength(2);
    expect(triageRequests.filter((request) => request.assistantMessageId === "assistant-d").map((request) => request.expectedVersion))
      .toEqual([0, 1]);
  });

  test("a list read that began before a dismissal landed does not bring the row back", async ({ page }) => {
    const triageRequests: TriageRequest[] = [];
    const reads: ListReads = { requested: 0, served: 0 };
    const gate = () => {
      let open: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => { open = resolve; });
      return { closed, open };
    };
    const secondDismissal = gate();
    const staleRead = gate();
    const laterRead = gate();
    let readGate = staleRead;
    const dismissalOfFirstSent = () => triageRequests.some((request) => request.assistantMessageId === "assistant-a");

    await seedDashboardStorage(page);
    await installDashboardApiMocks(page, handoffList([]));
    await stubQuality(page, turns(), {
      requests: triageRequests,
      reads,
      // The second row's dismissal is slow; every read that begins meanwhile still lists it.
      holdTriage: ({ assistantMessageId }) => assistantMessageId === "assistant-b" ? secondDismissal.closed : undefined,
      holdList: () => dismissalOfFirstSent() ? readGate.closed : undefined,
    });

    await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);
    const queue = queueOf(page);
    await expect(page.getByRole("button", { name: /^Needs you · 3$/ })).toBeVisible();

    await queue.getByRole("checkbox", { name: "Select First complaint" }).check();
    await queue.getByRole("checkbox", { name: "Select Second complaint" }).check();
    await queue.getByRole("region", { name: "Bulk dismiss" }).getByRole("button", { name: "Dismiss" }).click();
    await page.getByRole("button", { name: "Close without reason" }).click();

    // The first is gone, and a read began after it that still lists the second.
    await expect(queue.getByRole("button", { name: /First complaint/ })).toHaveCount(0);
    await expect.poll(() => reads.requested).toBeGreaterThan(1);

    // The second's dismissal lands: it leaves the queue while that read is still on its way.
    readGate = laterRead;
    secondDismissal.open();
    await expect(queue.getByRole("button", { name: /Second complaint/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Needs you · 1$/ })).toBeVisible();

    // The older read lands. It must not bring the second row back, nor its count.
    const servedBefore = reads.served;
    staleRead.open();
    await expect.poll(() => reads.served).toBeGreaterThan(servedBefore);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(queue.getByRole("button", { name: /Second complaint/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Needs you · 1$/ })).toBeVisible();
    await expect(queue.getByRole("button", { name: /Third complaint/ })).toBeVisible();

    laterRead.open();
  });

  test("a row hidden by a filter is not dismissed with the selection", async ({ page }) => {
    const triageRequests: TriageRequest[] = [];
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page, handoffList([]));
    await stubQuality(page, [
      feedbackTurn("assistant-web", "Web complaint", { channel: "web" }),
      feedbackTurn("assistant-email", "Email complaint", { channel: "email" }),
    ], { requests: triageRequests });

    await page.goto(`/w/${workspaceKey}/activity?tab=needs-attention`);
    const queue = queueOf(page);
    await queue.getByRole("checkbox", { name: "Select Web complaint" }).check();
    await queue.getByLabel("Filter by channel").click();
    await page.getByRole("option", { name: "email", exact: true }).click();
    await expect(queue.getByRole("button", { name: /Web complaint/ })).toHaveCount(0);
    await expect(queue.getByRole("region", { name: "Bulk dismiss" })).toHaveCount(0);

    // Clearing the filter shows the web row again, unticked.
    await queue.getByLabel("Filter by channel").click();
    await page.getByRole("option", { name: "Channel: all" }).click();
    await expect(queue.getByRole("checkbox", { name: "Select Web complaint" })).not.toBeChecked();
    await expect(queue.getByRole("region", { name: "Bulk dismiss" })).toHaveCount(0);
    await queue.getByLabel("Filter by channel").click();
    await page.getByRole("option", { name: "email", exact: true }).click();

    await queue.getByRole("checkbox", { name: "Select Email complaint" }).check();
    const bar = queue.getByRole("region", { name: "Bulk dismiss" });
    await expect(bar).toContainText("1 selected");
    await bar.getByRole("button", { name: "Dismiss" }).click();
    await page.getByRole("button", { name: "Close without reason" }).click();

    await expect(queue.getByRole("button", { name: /Email complaint/ })).toHaveCount(0);
    expect(triageRequests.map((request) => request.assistantMessageId)).toEqual(["assistant-email"]);
  });
});
