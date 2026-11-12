import { expect, test, type Page } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  testExecutionFixtureId,
  workspaceKey,
} from "./dashboard-fixtures";

// Test Chat's photo journey: an operator attaches a photo to a test message exactly as a visitor
// would, the draft answers from the agent's reading of it, and the transcript shows the photo with
// what the agent read under it. The backend is mocked at its edges: the upload, the test's message
// stream, the test as stored, and the photo read back from the test. The photo is a real JPEG the
// page makes, so the browser's own shrinking runs.

const testChatUrl = `/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`;
const imageId = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";
const typedText = "Something like this, near the coast";
const reading = "A two-storey stone farmhouse with a terracotta roof and green shutters.";
const executionId = testExecutionFixtureId(1);

/** A real JPEG made by the page's own canvas. */
const makePhoto = async (page: Page): Promise<Buffer> => {
  const base64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(1200, 900);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#7aa0c4";
    context.fillRect(0, 0, 1200, 900);
    context.fillStyle = "#c4a07a";
    context.fillRect(200, 300, 800, 400);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  });
  return Buffer.from(base64, "base64");
};

/**
 * Test Chat's backend for photos over the dashboard mocks: the upload answers with the photo's id,
 * a message with photos answers on the test's stream, the test as stored carries the photo with the
 * agent's reading, and the photo reads back from the test.
 */
const mockPhotoBackend = async (
  page: Page,
  agent: { visitorImagesEnabled: boolean; chatModelOverride?: { provider: "openai-compatible"; model: string } },
  options: { sendFails?: boolean } = {},
) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentSettingsOverrides: agent });
  const uploads: Array<{ url: string; multipart: boolean; locale: string | null }> = [];
  const sends: Array<{ message?: string; imageIds?: string[] }> = [];
  const views: string[] = [];
  let sentTurn: { turnId: string; attemptId: string } | null = null;
  // The photo the test reads back: the JPEG the operator attached.
  const storedPhoto: { jpeg: Buffer | null } = { jpeg: null };
  const stored = () => ({
    execution: {
      id: executionId, generation: 1, mode: "single", skillEffects: "suppressed", state: "completed", createdAt: nowIso, testValues: [], seededTurnCount: 0,
      sides: [{
        id: "side-1-0",
        revision: { id: "11111111-1111-4111-8111-111111111111", label: "Draft", kind: "candidate", versionNumber: null, createdAt: nowIso },
        conversationId: "conversation-1-0", state: "completed", retryable: false,
        history: sentTurn ? [
          { ...sentTurn, role: "user", content: `${typedText}\n<attached_photo index="1">${reading}</attached_photo>`, createdAt: nowIso, imageInput: { typedText, images: [{ id: imageId, reading }] } },
          { ...sentTurn, role: "assistant", content: "Here are three farmhouses like it.", messageId: "message-1", createdAt: nowIso },
        ] : [],
      }],
      attempts: [],
    },
  });

  await page.route(/\/backend\/api\/v1\/assistant\/images\?/, async (route) => {
    const form = route.request().postDataBuffer()?.toString("latin1") ?? "";
    uploads.push({
      url: route.request().url(),
      multipart: (route.request().headers()["content-type"] ?? "").startsWith("multipart/form-data"),
      locale: /name="locale"\r\n\r\n([^\r]+)/.exec(form)?.[1] ?? null,
    });
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: imageId, readingStatus: "read" }) });
  });
  await page.route(/\/backend\/api\/v1\/agents\/[^/]+\/test-executions\/[^/]+\/messages$/, async (route) => {
    const body = route.request().postDataJSON() as { message?: string; imageIds?: string[]; turnId: string; attemptId: string };
    sends.push({ message: body.message, imageIds: body.imageIds });
    if (options.sendFails) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal_error", message: "The test could not take the message." } }) });
      return;
    }
    sentTurn = { turnId: body.turnId, attemptId: body.attemptId };
    const identity = { executionId, generation: 1, sideId: "side-1-0", turnId: body.turnId, attemptId: body.attemptId };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        { type: "side_started", ...identity },
        { type: "message_delta", ...identity, delta: "Here are three farmhouses like it." },
        { type: "side_completed", ...identity, messageId: "message-1", answer: "Here are three farmhouses like it." },
        { type: "execution_completed", executionId, generation: 1, turnId: body.turnId, attemptId: body.attemptId },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    });
  });
  await page.route(/\/backend\/api\/v1\/agents\/[^/]+\/test-executions\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "GET" || !sentTurn) {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stored()) });
  });
  await page.route(/\/backend\/api\/v1\/agents\/[^/]+\/test-executions\/[^/]+\/images\/[^/?]+/, async (route) => {
    views.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "image/jpeg", body: storedPhoto.jpeg ?? Buffer.alloc(0) });
  });
  return { uploads, sends, views, photo: storedPhoto };
};

test("an operator attaches a photo in Test Chat, and the transcript shows it with what the agent read", async ({ page }) => {
  const backend = await mockPhotoBackend(page, { visitorImagesEnabled: true });
  await page.goto(testChatUrl);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();

  backend.photo.jpeg = await makePhoto(page);
  await page.getByTestId("visitor-image-input").setInputFiles({ name: "farmhouse.jpg", mimeType: "image/jpeg", buffer: backend.photo.jpeg });
  await expect(page.locator('[data-attachment-status="ready"]')).toHaveCount(1);
  await page.getByPlaceholder("Ask a question...").fill(typedText);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByText("Here are three farmhouses like it.").first()).toBeVisible();
  // Read in the operator's browser language, as a visitor's photo is read in the visitor's.
  expect(backend.uploads).toEqual([{ url: expect.stringContaining(`/assistant/images?agentId=${defaultAgentId}`), multipart: true, locale: "en-US" }]);
  expect(backend.sends).toEqual([{ message: typedText, imageIds: [imageId] }]);
  // The operator's bubble holds the photo and what they typed, never the reading the turn ran on.
  const thumbnails = page.getByTestId("visitor-image-thumbnails");
  await expect(thumbnails.getByRole("img", { name: "Photo sent in this test" })).toBeVisible();
  await expect(page.getByText(typedText, { exact: true })).toBeVisible();
  await expect(page.getByText("<attached_photo")).toHaveCount(0);
  expect(backend.views[0]).toContain(`/agents/${defaultAgentId}/test-executions/${executionId}/images/${imageId}`);

  await page.getByRole("button", { name: "What the agent read" }).click();
  await expect(page.getByText(reading)).toBeVisible();
  // The composer is empty again, ready for the next message.
  await expect(page.locator("[data-attachment-status]")).toHaveCount(0);
});

test("a message that never reaches the test gives back what was typed and the photo, and leaves no bubble", async ({ page }) => {
  const backend = await mockPhotoBackend(page, { visitorImagesEnabled: true }, { sendFails: true });
  await page.goto(testChatUrl);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();

  backend.photo.jpeg = await makePhoto(page);
  await page.getByTestId("visitor-image-input").setInputFiles({ name: "farmhouse.jpg", mimeType: "image/jpeg", buffer: backend.photo.jpeg });
  await expect(page.locator('[data-attachment-status="ready"]')).toHaveCount(1);
  await page.getByPlaceholder("Ask a question...").fill(typedText);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByText("The test could not take the message.")).toBeVisible();
  await expect(page.getByPlaceholder("Ask a question...")).toHaveValue(typedText);
  await expect(page.locator('[data-attachment-status="ready"]')).toHaveCount(1);
  await expect(page.getByTestId("visitor-image-thumbnails")).toHaveCount(0);
  expect(backend.sends).toEqual([{ message: typedText, imageIds: [imageId] }]);
});

test("Test Chat offers no attach control while the agent takes no photos from visitors", async ({ page }) => {
  await mockPhotoBackend(page, { visitorImagesEnabled: false });
  await page.goto(testChatUrl);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();

  await expect(page.getByRole("button", { name: "Attach photo" })).toHaveCount(0);
});

test("Test Chat says why it offers no photos when the agent's chat model cannot read them", async ({ page }) => {
  await mockPhotoBackend(page, { visitorImagesEnabled: true, chatModelOverride: { provider: "openai-compatible", model: "local-model" } });
  await page.goto(testChatUrl);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();

  await expect(page.getByText("Photos are on, but this agent’s chat model can’t read them.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach photo" })).toHaveCount(0);
});
