import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("configures Exact words with two languages and three chips, saves with the page's Save draft, and reads the draft back after a reload", async ({ page }) => {
  await seedDashboardStorage(page);

  const greetingDraftRequests: Array<{ exactWordsEnabled: boolean; exactContent: unknown }> = [];
  let draftSaved = false;

  await installDashboardApiMocks(page);

  // The shared mock keeps the saved greeting and hands it back on the draft read; this route only
  // records what the page sent.
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/greeting/draft`, async (route) => {
    if (route.request().method() === "PUT") {
      greetingDraftRequests.push(route.request().postDataJSON() as { exactWordsEnabled: boolean; exactContent: unknown });
      draftSaved = true;
    }
    await route.fallback();
  });

  // Registered after installDashboardApiMocks, so it wins for revision-state and can hand
  // back to the shared mock's steady state until the draft save flips it dirty — the same
  // override pattern agent-cockpit.spec.ts uses for revision-state.
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/revision-state`, async (route) => {
    if (draftSaved) {
      await route.fulfill({
        json: {
          agentId: defaultAgentId,
          status: "draft_dirty",
          draft: { generation: 2, basePublishedRevisionId: "22222222-2222-4222-8222-222222222222", updatedAt: new Date().toISOString() },
          publishedRevision: { id: "22222222-2222-4222-8222-222222222222", label: "Published", kind: "published", versionNumber: 1, createdAt: "2026-04-26T12:00:00.000Z" },
          canPublish: true,
          proactiveGreetingEnabled: true,
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);
  await expect(page.getByRole("heading", { name: "Profile", level: 3 })).toBeVisible();

  await page.getByRole("group", { name: "Greeting wording" }).getByText("Exact words").click();

  await page.getByLabel("Greeting text (en-US)").fill("Welcome to Acme! How can we help today?");

  // Second language variant.
  await page.getByPlaceholder("Add a language variant").fill("French");
  await page.getByRole("option", { name: "French" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Greeting text (French)").fill("Bienvenue chez Acme ! Comment pouvons-nous vous aider ?");

  // Three chips, added on the default-locale variant, labeled on both variants.
  const englishVariant = page.getByRole("group", { name: "Greeting variant: en-US" });
  await englishVariant.getByRole("button", { name: "Add chip" }).click();
  await englishVariant.getByRole("button", { name: "Add chip" }).click();
  await englishVariant.getByRole("button", { name: "Add chip" }).click();
  const englishChipInputs = englishVariant.getByLabel(/Chip \d+ label/);
  await expect(englishChipInputs).toHaveCount(3);
  await englishChipInputs.nth(0).fill("Compare plans");
  await englishChipInputs.nth(1).fill("Talk to sales");
  await englishChipInputs.nth(2).fill("Read the docs");

  const frenchVariant = page.getByRole("group", { name: "Greeting variant: French" });
  const frenchChipInputs = frenchVariant.getByLabel(/Chip \d+ label/);
  await expect(frenchChipInputs).toHaveCount(3);
  await frenchChipInputs.nth(0).fill("Comparer les offres");
  await frenchChipInputs.nth(1).fill("Parler aux ventes");
  await frenchChipInputs.nth(2).fill("Lire la documentation");

  // The wording is part of the page draft: the header offers the same Save draft as for the
  // instructions, and nothing is written until it is pressed.
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  expect(greetingDraftRequests).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Save greeting" })).toHaveCount(0);

  await page.getByRole("button", { name: "Save draft" }).click();

  await expect.poll(() => greetingDraftRequests.length).toBe(1);
  expect(greetingDraftRequests[0]).toMatchObject({
    exactWordsEnabled: true,
    exactContent: {
      chips: expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String)]),
      variants: expect.arrayContaining([
        expect.objectContaining({ locale: "en-US", body: "Welcome to Acme! How can we help today?" }),
        expect.objectContaining({ locale: "fr", body: "Bienvenue chez Acme ! Comment pouvons-nous vous aider ?" }),
      ]),
    },
  });

  // A greeting-only draft is publishable. This spec's revision-state is a mock, so whether the
  // real backend reports such a draft as changed is covered by the backend revision-status tests.
  await expect(page.getByRole("button", { name: "Review & publish", exact: true })).toBeEnabled();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);

  // The review lists the wording that will go live, not just "Unchanged".
  await page.getByRole("button", { name: "Review & publish", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review draft publication" });
  await expect(review.getByText("Only saved draft instructions, greeting wording, directives, routines, and context enablements are included.")).toBeVisible();
  const greetingSection = review.locator("section").filter({ has: page.getByText("Greeting", { exact: true }) });
  await expect(greetingSection).toContainText("Exact words");
  await expect(greetingSection).toContainText("en-US: Welcome to Acme! How can we help today?");
  await expect(greetingSection).toContainText("fr: Bienvenue chez Acme ! Comment pouvons-nous vous aider ?");
  await expect(greetingSection).not.toContainText("Unchanged");
  await review.getByRole("button", { name: "Cancel" }).click();

  // After a reload the editor starts from the saved draft, not from the published revision,
  // and a page that changed nothing writes nothing.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Profile", level: 3 })).toBeVisible();
  await expect(page.getByLabel("Greeting text (en-US)")).toHaveValue("Welcome to Acme! How can we help today?");
  await expect(page.getByLabel("Greeting text (French)")).toHaveValue("Bienvenue chez Acme ! Comment pouvons-nous vous aider ?");
  await expect(page.getByLabel(/Chip \d+ label/).first()).toHaveValue("Compare plans");
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  expect(greetingDraftRequests).toHaveLength(1);
});

test("saves an edited instruction without rewriting a greeting that did not change", async ({ page }) => {
  await seedDashboardStorage(page);
  const greetingWrites: string[] = [];
  const agentWrites: unknown[] = [];
  await installDashboardApiMocks(page, { agentUpdates: agentWrites });
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/greeting/draft`, async (route) => {
    if (route.request().method() === "PUT") greetingWrites.push(route.request().method());
    await route.fallback();
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);
  await expect(page.getByRole("group", { name: "Greeting wording" })).toBeVisible();
  await page.locator("#assistantAnswerInstruction").fill("Use the saved draft instruction.");
  await page.getByRole("button", { name: "Save draft" }).click();

  await expect.poll(() => agentWrites).toEqual(expect.arrayContaining([expect.objectContaining({ customInstruction: "Use the saved draft instruction." })]));
  await expect(page.getByRole("button", { name: "Save draft" })).toBeHidden();
  expect(greetingWrites).toHaveLength(0);
});

test("shows the greeting issues the draft refused and marks the page draft save as needing attention", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/greeting/draft`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 400,
      json: {
        error: {
          code: "bad_request",
          message: "Exact greeting content is invalid",
          details: { issues: [{ path: "variants[0].body", code: "blank_body", message: "Greeting text must not be blank" }] },
        },
      },
    });
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);
  await page.getByRole("group", { name: "Greeting wording" }).getByText("Exact words").click();
  await page.getByRole("button", { name: "Save draft" }).click();

  await expect(page.getByText("Draft save needs attention")).toBeVisible();
  await expect(page.getByText("Greeting text must not be blank")).toBeVisible();
  // The edit is kept, so the operator can fix the wording and save again.
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
});

test("keeps unsaved wording on screen when the proactive greeting is switched off, so a refused save shows its issues", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/greeting/draft`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 400,
      json: {
        error: {
          code: "bad_request",
          message: "Exact greeting content is invalid",
          details: { issues: [{ path: "variants[0].body", code: "blank_body", message: "Greeting text must not be blank" }] },
        },
      },
    });
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);
  await page.getByRole("group", { name: "Greeting wording" }).getByText("Exact words").click();
  await page.getByLabel("Proactive first greeting").click();
  await expect(page.getByLabel("Proactive first greeting")).not.toBeChecked();

  await expect(page.getByRole("group", { name: "Greeting wording" })).toBeVisible();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Greeting text must not be blank")).toBeVisible();
});

test("refreshes the draft status once the instructions are saved even though the greeting was refused, and drops the failure when the refused edit is undone", async ({ page }) => {
  await seedDashboardStorage(page);
  let draftGeneration = 1;
  let stateReads = 0;
  const candidateRequests: Array<{ expectedDraftGeneration: number }> = [];
  await installDashboardApiMocks(page);
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}`, async (route) => {
    if (route.request().method() === "PUT") draftGeneration += 1;
    await route.fallback();
  });
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/revision-state`, async (route) => {
    stateReads += 1;
    await route.fulfill({
      json: {
        agentId: defaultAgentId,
        status: draftGeneration > 1 ? "draft_dirty" : "draft_clean",
        draft: { generation: draftGeneration, basePublishedRevisionId: "22222222-2222-4222-8222-222222222222", updatedAt: new Date().toISOString() },
        publishedRevision: { id: "22222222-2222-4222-8222-222222222222", label: "Published", kind: "published", versionNumber: 1, createdAt: "2026-04-26T12:00:00.000Z" },
        canPublish: true,
        proactiveGreetingEnabled: true,
      },
    });
  });
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/revisions/candidates`, async (route) => {
    candidateRequests.push(route.request().postDataJSON() as { expectedDraftGeneration: number });
    await route.fallback();
  });
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/greeting/draft`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 400,
      json: {
        error: {
          code: "bad_request",
          message: "Exact greeting content is invalid",
          details: { issues: [{ path: "variants[0].body", code: "blank_body", message: "Greeting text must not be blank" }] },
        },
      },
    });
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);
  await expect(page.getByRole("group", { name: "Greeting wording" })).toBeVisible();
  await expect.poll(() => stateReads).toBeGreaterThan(0);
  await page.locator("#assistantAnswerInstruction").fill("Use the saved draft instruction.");
  await page.getByRole("group", { name: "Greeting wording" }).getByText("Exact words").click();
  const readsBeforeSave = stateReads;
  await page.getByRole("button", { name: "Save draft" }).click();

  await expect(page.getByText("Draft save needs attention")).toBeVisible();
  await expect(page.getByText("Greeting text must not be blank")).toBeVisible();
  // The instructions were written, so the header reads the draft again instead of keeping the
  // generation from before the write.
  await expect.poll(() => stateReads).toBeGreaterThan(readsBeforeSave);

  // Undoing the refused edit leaves nothing to save: the failure goes, and a review is made
  // against the generation the instructions write produced.
  await page.getByRole("group", { name: "Greeting wording" }).getByText("Automatic").click();
  await expect(page.getByText("Draft save needs attention")).toHaveCount(0);
  await expect(page.getByText("Exact greeting content is invalid")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review & publish", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Review & publish", exact: true }).click();
  await expect.poll(() => candidateRequests.length).toBe(1);
  expect(candidateRequests[0].expectedDraftGeneration).toBe(2);
});

// No pre-existing Playwright spec exercises the public bootstrap-greeting page at all (it is
// not under dashboard-fixtures.ts's dashboard-only mocking, and no `/chat/[token]` spec existed
// before this feature) — this is a new spec, not an extension of one, contrary to the
// assumption that prompted it. It mocks `/backend/api/v1/public/chat/:token` (the conversation
// list + bootstrap endpoints) and the Next.js streaming proxy route directly.
test("renders three authored greeting chips at bootstrap and sends the clicked chip's text as a user turn", async ({ page }) => {
  const publicToken = "public-token";
  const sendRequests: Array<{ message: string }> = [];

  await page.route(`**/backend/api/v1/public/chat/${publicToken}**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    // The standalone `/chat/[token]` page uses `sessionChannel: 'anonymous_link'`
    // (public-chat-shell.tsx), so the very first request is a session exchange —
    // before the conversation list and the bootstrap greeting.
    if (pathname.endsWith("/sessions") && request.method() === "POST") {
      await route.fulfill({
        json: {
          agentId: "67acb0c8-caad-4a1b-9fef-70cbca3f7d12",
          agentName: "Marta",
          assistantLinkUtmEnabled: true,
          workspaceName: "Acme",
          publicChatToken: publicToken,
          publicSessionId: "11111111-1111-4111-8111-111111111111",
          publicSessionToken: "public-session-token",
          resumeToken: "resume-token",
          assistantBootstrapActive: true,
          assistantAvatarUrl: null,
          theme: { brand: "#0f172a", brandText: "#f8fafc", surface: "#ffffff", text: "#0f172a" },
          branding: { hidePoweredBy: false, privacyPolicyUrl: null },
          intakeActions: [],
        },
      });
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({
        json: {
          workspaceName: "Acme",
          assistantAvatarUrl: null,
          assistantLinkUtmEnabled: true,
          citationDisplayEnabled: true,
          theme: { brand: "#0f172a", brandText: "#f8fafc", surface: "#ffffff", text: "#0f172a" },
          branding: { hidePoweredBy: false, privacyPolicyUrl: null },
          intakeActions: [],
          assistantBootstrapActive: true,
          conversations: [],
          total: 0,
          nextCursor: null,
          hasMore: false,
        },
      });
      return;
    }
    if (request.method() === "POST") {
      await route.fulfill({
        json: {
          conversationId: "conversation-greeting-1",
          assistantMessageId: "assistant-message-1",
          answer: "Welcome to Acme! How can we help today?",
          citations: [],
          answerSegments: [],
          suggestions: [
            { id: "chip-1", text: "Compare plans", kind: "authored", action: { kind: "ask_followup" } },
            { id: "chip-2", text: "Talk to sales", kind: "authored", action: { kind: "ask_followup" } },
            { id: "chip-3", text: "Read the docs", kind: "authored", action: { kind: "ask_followup" } },
          ],
        },
      });
      return;
    }
    await route.continue();
  });

  await page.route(`**/api/public/chat/${publicToken}`, async (route) => {
    const body = route.request().postDataJSON() as { message: string };
    sendRequests.push({ message: body.message });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        conversationId: "conversation-greeting-1",
        assistantMessageId: "assistant-message-2",
        answer: "Here is a plan comparison.",
        citations: [],
        answerSegments: [],
        suggestions: [],
      }),
    });
  });

  await page.goto(`/chat/${publicToken}`);

  await expect(page.getByText("Welcome to Acme! How can we help today?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Compare plans" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Talk to sales" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Read the docs" })).toBeVisible();

  await page.getByRole("button", { name: "Compare plans" }).click();

  await expect.poll(() => sendRequests.length).toBe(1);
  expect(sendRequests[0].message).toBe("Compare plans");
  await expect(page.getByText("Here is a plan comparison.")).toBeVisible();
});
