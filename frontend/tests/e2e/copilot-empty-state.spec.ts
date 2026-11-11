import { expect, test, type Page } from "@playwright/test";

import {
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const availableLlm = { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive", "routine", "website_crawl"] };

/**
 * Opens Ray in a workspace with no Ray conversations, answering the empty-state request with
 * `emptyState`. Returns the empty-state requests the page made, so a test can say what was asked.
 */
const openRayWith = async (
  page: Page,
  options: { availability?: unknown; emptyState?: { status: number; body?: unknown }; startAt?: string },
) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const emptyStateRequests: string[] = [];

  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability") {
      await route.fulfill({ json: options.availability ?? availableLlm });
      return;
    }
    if (path === "/copilot/conversations") {
      await route.fulfill({ json: { conversations: [] } });
      return;
    }
    if (path === "/copilot/empty-state") {
      emptyStateRequests.push(request.url());
      await route.fulfill({ status: options.emptyState?.status ?? 200, json: options.emptyState?.body ?? {} });
      return;
    }
    await route.continue();
  });

  await page.goto(options.startAt ?? `/w/${workspaceKey}/copilot`);
  return emptyStateRequests;
};

/** What a workspace nobody has talked to must never read: the fixed "what happened" line and the screen's retrospective chips. */
const expectNothingRetrospective = async (page: Page) => {
  await expect(page.getByText(/shed some light on what happened/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Explain what happened|What should I investigate next|Why did this agent behave/ })).toHaveCount(0);
};

test("on a fresh workspace Ray picks up setup and links each next step to where it is completed", async ({ page }) => {
  const requests = await openRayWith(page, {
    emptyState: {
      status: 200,
      body: {
        phase: "setup",
        firstConversationHappened: false,
        greeting: "Pongamos en marcha tu espacio: aún quedan unos pasos.",
        suggestions: [
          { kind: "setup_step", step: "documents", text: "Añade tus documentos", href: `/w/${workspaceKey}/knowledge` },
          { kind: "setup_step", step: "conversation", text: "Haz una primera pregunta", href: `/w/${workspaceKey}/agents` },
          { kind: "setup_step", step: "directives_or_routines", text: "Dale una regla al agente", href: `/w/${workspaceKey}/agents?tab=behavior&anchor=assistant-directives` },
        ],
      },
    },
  });

  // Ray's own words, in the language the server wrote them, replace the fixed retrospective line.
  await expect(page.getByText("Pongamos en marcha tu espacio: aún quedan unos pasos.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hi, I'm Ray ☀️" })).toHaveCount(0);
  await expect(page.getByText(/shed some light on what happened/)).toHaveCount(0);
  await expect(page.getByTestId("copilot-empty-chip")).toHaveText(["Añade tus documentos", "Haz una primera pregunta", "Dale una regla al agente"]);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]).searchParams.get("locale")).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/);

  await page.getByRole("button", { name: "Añade tus documentos" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/knowledge`));
});

test("shows no claim about what happened when setup is open and the greeting could not be written", async ({ page }) => {
  await openRayWith(page, { emptyState: { status: 200, body: { phase: "setup", firstConversationHappened: false, greeting: null, suggestions: [] } } });

  await expect(page.getByRole("heading", { name: "Hi, I'm Ray ☀️" })).toBeVisible();
  await expectNothingRetrospective(page);
});

test("once setup is over Ray offers open-ended requests that fill the composer", async ({ page }) => {
  // The first-run takeover closes setup on Open chat or Skip, so a workspace can be here with no
  // conversation yet. Nothing retrospective may show, and the requests still work.
  await openRayWith(page, {
    emptyState: {
      status: 200,
      body: {
        phase: "open",
        firstConversationHappened: false,
        greeting: "What would you like to work on?",
        suggestions: [
          { kind: "prompt", intent: "crawl_more", text: "Crawl more of my website" },
          { kind: "prompt", intent: "tighten_tone", text: "Tighten how the agent sounds" },
          { kind: "prompt", intent: "draft_routine", text: "Draft a routine for refunds" },
        ],
      },
    },
  });

  await expect(page.getByText("What would you like to work on?")).toBeVisible();
  await expectNothingRetrospective(page);
  await page.getByRole("button", { name: "Draft a routine for refunds" }).click();
  await expect(page.getByRole("textbox", { name: "Ask Ray" })).toHaveValue("Draft a routine for refunds");
});

test("shows only the neutral header when the empty state cannot be read", async ({ page }) => {
  await openRayWith(page, { emptyState: { status: 500, body: { error: { code: "internal_error" } } } });

  await expect(page.getByRole("heading", { name: "Hi, I'm Ray ☀️" })).toBeVisible();
  await expectNothingRetrospective(page);
});

test("shows only the neutral header to an operator who cannot read the workspace summary", async ({ page }) => {
  await openRayWith(page, { emptyState: { status: 200, body: { phase: "open", firstConversationHappened: null, greeting: null, suggestions: [] } } });

  await expect(page.getByRole("heading", { name: "Hi, I'm Ray ☀️" })).toBeVisible();
  await expectNothingRetrospective(page);
});

test("keeps the retrospective line and the screen's own suggestions once conversations exist", async ({ page }) => {
  await openRayWith(page, { emptyState: { status: 200, body: { phase: "open", firstConversationHappened: true, greeting: null, suggestions: [] } } });

  await expect(page.getByText(/shed some light on what happened/)).toBeVisible();
  await expect(page.getByTestId("copilot-empty-chip").first()).toBeVisible();
});

test("closes the Ray panel when a setup step opens its screen, so the panel does not keep suggesting it", async ({ page }) => {
  await openRayWith(page, {
    startAt: `/w/${workspaceKey}/activity?tab=all`,
    emptyState: {
      status: 200,
      body: {
        phase: "setup",
        firstConversationHappened: false,
        greeting: "Let's pick up your setup.",
        suggestions: [{ kind: "setup_step", step: "documents", text: "Add your documents", href: `/w/${workspaceKey}/knowledge` }],
      },
    },
  });

  await page.getByTestId("ask-ray-tag").click();
  const rayPanel = page.getByRole("complementary", { name: "Ray" });
  await expect(rayPanel.getByText("Let's pick up your setup.")).toBeVisible();

  await rayPanel.getByRole("button", { name: "Add your documents" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/knowledge`));
  await expect(rayPanel).toBeHidden();
});

test("keeps asking the operator to connect an LLM, without asking for an empty state", async ({ page }) => {
  const requests = await openRayWith(page, {
    availability: { available: false, reason: "no_llm_capability", canManage: true, applyableProposalTargets: [] },
  });

  await expect(page.getByRole("heading", { name: "Connect an LLM to use Ray" })).toBeVisible();
  await expect(page.getByTestId("copilot-empty-state")).toHaveCount(0);
  expect(requests).toHaveLength(0);
});
