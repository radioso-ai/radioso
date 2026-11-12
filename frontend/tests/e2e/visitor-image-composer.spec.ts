import { expect, test, type Page, type Route } from "@playwright/test";

// The visitor image journey (#1754 follow-up): a visitor attaches a photo in the public chat, sees
// its preview while it uploads, sends it with a line of text, sees it in their thread, and still
// sees it after a reload. The backend is mocked; the photo is a real image made in the page, and the
// upload route checks what the browser actually sent.

const publicToken = "public-token-visitor-images";
const conversationId = "11111111-1111-4111-8111-111111111111";
const imageId = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";
const publicSessionToken = "public-session-token";
const typedText = "Something like this, near the coast";
const reading = "A two-storey stone farmhouse with a terracotta roof and green shutters.";
const nowIso = "2026-11-11T10:00:00.000Z";
const theme = { brand: "#0f172a", brandText: "#f8fafc", surface: "#ffffff", text: "#0f172a" };

/** A real JPEG made by the page's own canvas: smooth, then covered in shapes so it is big. */
const makePhoto = async (page: Page, width: number, height: number): Promise<Buffer> => {
  const base64 = await page.evaluate(async ([w, h]) => {
    const canvas = new OffscreenCanvas(w, h);
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, "#7aa0c4");
    gradient.addColorStop(1, "#c4a07a");
    context.fillStyle = gradient;
    context.fillRect(0, 0, w, h);
    let seed = 7;
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let index = 0; index < 5000; index += 1) {
      context.fillStyle = `rgb(${Math.floor(next() * 255)},${Math.floor(next() * 255)},${Math.floor(next() * 255)})`;
      context.fillRect(next() * w, next() * h, 4 + next() * 40, 4 + next() * 40);
    }
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }, [width, height] as const);
  return Buffer.from(base64, "base64");
};

/** The pixel size a JPEG declares, from its start-of-frame marker. */
const jpegSize = (jpeg: Buffer): { width: number; height: number } => {
  let offset = 2;
  while (offset + 9 < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = jpeg[offset + 1];
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) };
    }
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  throw new Error("no JPEG frame header");
};

/** The JPEG inside a multipart upload's `image` part. */
const uploadedJpeg = (body: Buffer): Buffer => {
  const headerEnd = body.indexOf(Buffer.from('name="image"'));
  const start = body.indexOf(Buffer.from("\r\n\r\n"), headerEnd) + 4;
  const end = body.indexOf(Buffer.from("\r\n--"), start);
  return body.subarray(start, end);
};

interface Observed {
  uploads: Array<{ jpeg: Buffer; sessionHeader: string | undefined; locale: string | null }>;
  imageReads: Array<{ sessionHeader: string | undefined }>;
  sentBodies: Array<Record<string, unknown>>;
}

interface MockOptions {
  acceptsImages: boolean;
  photo: Buffer;
  uploadDelayMs?: number;
  /** What each upload answers, in turn; the last answer repeats. Defaults to the photo being read. */
  uploadAnswers?: Array<{ status: number; body: unknown }>;
  /** What each message send answers with before one is taken; once these run out, a send streams the agent's reply. */
  sendRefusals?: Array<{ status: number; code: string }>;
  /** The chat's theme, for the contrast of what it shows. */
  theme?: typeof theme;
}

const mockPublicChat = async (page: Page, options: MockOptions): Promise<Observed> => {
  const observed: Observed = { uploads: [], imageReads: [], sentBodies: [] };
  let sent = false;
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

  await page.route(`**/backend/api/v1/public/chat/${publicToken}**`, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const sessionHeader = request.headers()["x-radioso-public-session"];

    if (pathname.endsWith("/sessions") && method === "POST") {
      return json(route, {
        agentId: "22222222-2222-4222-8222-222222222222",
        agentName: "Marta",
        assistantLinkUtmEnabled: true,
        workspaceName: "Acme",
        publicChatToken: publicToken,
        publicSessionId: "33333333-3333-4333-8333-333333333333",
        publicSessionToken,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        resumeToken: "resume-token",
        resumeExpiresAt: new Date(Date.now() + 120 * 60_000).toISOString(),
        assistantBootstrapActive: false,
        assistantAvatarUrl: null,
        acceptsImages: options.acceptsImages,
        theme: options.theme ?? theme,
        intakeActions: [],
      });
    }
    if (pathname.endsWith("/images") && method === "POST") {
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      const locale = /name="locale"\r\n\r\n([^\r]*)/.exec(body.toString("latin1"))?.[1] ?? null;
      observed.uploads.push({ jpeg: uploadedJpeg(body), sessionHeader, locale });
      await new Promise((resolve) => setTimeout(resolve, options.uploadDelayMs ?? 0));
      const answers = options.uploadAnswers ?? [{ status: 201, body: { id: imageId, readingStatus: "read" } }];
      const answer = answers[Math.min(observed.uploads.length - 1, answers.length - 1)];
      return json(route, answer.body, answer.status);
    }
    if (pathname.endsWith(`/images/${imageId}`) && method === "GET") {
      observed.imageReads.push({ sessionHeader });
      return route.fulfill({ status: 200, contentType: "image/jpeg", body: options.photo });
    }
    if (pathname.endsWith(`/history/${conversationId}`) && method === "GET") {
      return json(route, {
        conversationId,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        agentId: "22222222-2222-4222-8222-222222222222",
        agentName: "Marta",
        sourceChannel: "anonymous",
        callerKind: "visitor",
        sourceOrigin: null,
        title: null,
        channelContext: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        messagesTotal: 2,
        messageWindowOffset: 0,
        messageWindowLimit: 10,
        hasOlderMessages: false,
        nextCursor: null,
        tailCursor: null,
        messages: [
          {
            id: "55555555-5555-4555-8555-555555555551",
            role: "user",
            source: "customer",
            // The turn text the agent saw: the typed text with the reading after it. A thread never shows this.
            content: `${typedText}\n<attached_photo index="1">${reading}</attached_photo>`,
            createdAt: nowIso,
            inputMetadata: { method: "typed", imageInput: { typedText, images: [{ id: imageId, reading }] } },
          },
          { id: "55555555-5555-4555-8555-555555555552", role: "assistant", source: "ai_agent", content: "I found three farmhouses on the coast.", createdAt: nowIso },
        ],
      });
    }
    if (pathname.endsWith(`/tail/${conversationId}`) && method === "GET") {
      return json(route, { messages: [], cursor: null });
    }
    if (pathname.includes(`/events/${conversationId}`)) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
    }
    if (method === "GET") {
      return json(route, {
        workspaceName: "Acme",
        assistantAvatarUrl: null,
        assistantLinkUtmEnabled: true,
        citationDisplayEnabled: true,
        // A chat that reloads reads this, not the session response, to know whether to offer photos.
        acceptsImages: options.acceptsImages,
        theme: options.theme ?? theme,
        intakeActions: [],
        assistantBootstrapActive: false,
        conversations: sent
          ? [{ id: conversationId, sourceChannel: "anonymous", preview: typedText, messageCount: 2, createdAt: nowIso, updatedAt: nowIso }]
          : [],
        total: sent ? 1 : 0,
        nextCursor: null,
        hasMore: false,
      });
    }
    return route.continue();
  });

  await page.route(`**/api/public/chat/${publicToken}`, async (route) => {
    sent = true;
    observed.sentBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    const refusal = options.sendRefusals?.[observed.sentBodies.length - 1];
    if (refusal) {
      sent = false;
      await route.fulfill({ status: refusal.status, json: { error: { code: refusal.code, message: "Refused." } } });
      return;
    }
    const done = { conversationId, assistantMessageId: "55555555-5555-4555-8555-555555555552", answer: "I found three farmhouses on the coast." };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: conversation\ndata: ${JSON.stringify({ conversationId })}\n\n`,
        `event: chunk\ndata: ${JSON.stringify({ text: done.answer })}\n\n`,
        `event: done\ndata: ${JSON.stringify(done)}\n\n`,
      ].join(""),
    });
  });

  return observed;
};

const shownPhotos = (page: Page) => page.getByTestId("visitor-image-thumbnails").getByRole("img", { name: "Photo you sent" });

test("a visitor attaches a photo, sees it upload, sends it, and still sees it after a reload", async ({ page }) => {
  const photo = await makePhoto(page, 3200, 2400);
  expect(photo.length).toBeGreaterThan(300 * 1024);
  const observed = await mockPublicChat(page, { acceptsImages: true, photo, uploadDelayMs: 600 });

  await page.goto(`/chat/${publicToken}`);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();
  const send = page.getByRole("button", { name: "Send message" });
  await expect(send).toBeDisabled();

  // The photo shows as a preview while it uploads, and nothing can be sent until it is read.
  await page.getByTestId("visitor-image-input").setInputFiles({ name: "farmhouse.jpg", mimeType: "image/jpeg", buffer: photo });
  const chip = page.locator("[data-attachment-status]");
  await expect(chip).toHaveAttribute("data-attachment-status", "uploading");
  await expect(chip.locator("img")).toBeVisible();
  await expect(send).toBeDisabled();

  // Done: a photo alone makes the message sendable.
  await expect(chip).toHaveAttribute("data-attachment-status", "ready");
  await expect(send).toBeEnabled();

  // The browser shrank it before uploading: a JPEG of at most 1600 px on its long side, not the original.
  expect(observed.uploads).toHaveLength(1);
  const upload = observed.uploads[0];
  expect(upload.sessionHeader).toBe(publicSessionToken);
  const uploadedSize = jpegSize(upload.jpeg);
  expect(Math.max(uploadedSize.width, uploadedSize.height)).toBeLessThanOrEqual(1600);
  expect(uploadedSize.width / uploadedSize.height).toBeCloseTo(4 / 3, 1);
  expect(upload.jpeg.length).toBeLessThan(photo.length / 2);

  await page.getByPlaceholder("Ask a question...").fill(typedText);
  await send.click();

  // The thread shows the visitor's words and their photo, and the agent answers.
  await expect(page.getByText("I found three farmhouses on the coast.")).toBeVisible();
  expect(observed.sentBodies).toHaveLength(1);
  expect(observed.sentBodies[0]).toMatchObject({ message: typedText, imageIds: [imageId] });
  await expect(page.getByText(typedText)).toBeVisible();
  await expect(shownPhotos(page)).toHaveCount(1);
  await expect.poll(() => shownPhotos(page).evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  // The composer is empty again.
  await expect(page.locator("[data-attachment-status]")).toHaveCount(0);

  // After a reload the thread comes back from history: the same text and the photo, fetched with the
  // visitor's session, and never the agent's reading of it.
  await page.reload();
  await expect(page.getByText("I found three farmhouses on the coast.")).toBeVisible();
  await expect(page.getByText(typedText)).toBeVisible();
  await expect(shownPhotos(page)).toHaveCount(1);
  await expect.poll(() => shownPhotos(page).evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  expect(observed.imageReads.length).toBeGreaterThan(0);
  expect(observed.imageReads.every((read) => read.sessionHeader === publicSessionToken)).toBe(true);
  await expect(page.getByText("terracotta roof")).toHaveCount(0);
  await expect(page.getByText("attached_photo")).toHaveCount(0);
  // The attach control is still there: the list the reload read says the agent takes photos.
  await expect(page.getByRole("button", { name: "Attach photo" })).toBeVisible();
});

test("a visitor can remove a photo before sending, and is told when a file type is not accepted", async ({ page }) => {
  const photo = await makePhoto(page, 800, 600);
  await mockPublicChat(page, { acceptsImages: true, photo });

  await page.goto(`/chat/${publicToken}`);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();

  await page.getByTestId("visitor-image-input").setInputFiles({ name: "notes.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  await expect(page.getByTestId("visitor-image-notice")).toHaveText("Use a JPEG, PNG or WebP photo.");
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.getByRole("button", { name: /^Remove photo \d+ of \d+$/ }).click();
  await expect(page.locator("[data-attachment-status]")).toHaveCount(0);
  await expect(page.getByTestId("visitor-image-notice")).toHaveCount(0);

  await page.getByTestId("visitor-image-input").setInputFiles({ name: "farmhouse.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.locator("[data-attachment-status]")).toHaveAttribute("data-attachment-status", "ready");
  await page.getByRole("button", { name: /^Remove photo \d+ of \d+$/ }).click();
  await expect(page.locator("[data-attachment-status]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
});

test("a visitor can drop a photo on the composer and paste another, up to three", async ({ page }) => {
  const photo = await makePhoto(page, 400, 300);
  await mockPublicChat(page, { acceptsImages: true, photo });

  await page.goto(`/chat/${publicToken}`);
  const field = page.getByPlaceholder("Ask a question...");
  await expect(field).toBeVisible();

  const transferOf = (bytes: number[], name: string) =>
    page.evaluateHandle(
      ({ bytes: data, name: fileName }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(data)], fileName, { type: "image/jpeg" }));
        return transfer;
      },
      { bytes, name },
    );
  const bytes = [...photo];

  await field.dispatchEvent("drop", { dataTransfer: await transferOf(bytes, "dropped.jpg") });
  await expect(page.locator("[data-attachment-status]")).toHaveCount(1);

  const pasted = await transferOf(bytes, "pasted.jpg");
  await field.evaluate((element, clipboardData) => {
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, pasted);
  await expect(page.locator("[data-attachment-status]")).toHaveCount(2);

  // A fourth photo does not fit: the control is full after the third, and a drop of two says why.
  await field.dispatchEvent("drop", { dataTransfer: await transferOf(bytes, "third.jpg") });
  await expect(page.locator("[data-attachment-status]")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Attach photo" })).toBeDisabled();
  await field.dispatchEvent("drop", { dataTransfer: await transferOf(bytes, "fourth.jpg") });
  await expect(page.locator("[data-attachment-status]")).toHaveCount(3);
  await expect(page.getByTestId("visitor-image-notice")).toHaveText("You can send up to 3 photos at once.");
});

test("a chat whose agent takes no photos offers no attach control", async ({ page }) => {
  await mockPublicChat(page, { acceptsImages: false, photo: Buffer.alloc(0) });

  await page.goto(`/chat/${publicToken}`);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach photo" })).toHaveCount(0);
  await expect(page.getByTestId("visitor-image-input")).toHaveCount(0);
});

test("a photo the server is too busy to take is tried once more, and shows the error when it is busy again", async ({ page }) => {
  const photo = await makePhoto(page, 400, 300);
  const busy = { status: 503, body: { error: { code: "visitor_image_busy", message: "Try again." } } };
  const observed = await mockPublicChat(page, {
    acceptsImages: true,
    photo,
    uploadAnswers: [busy, { status: 201, body: { id: imageId, readingStatus: "read" } }],
  });

  await page.goto(`/chat/${publicToken}`);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();

  // Busy once: the browser waits a moment and tries the same photo again, with nothing for the visitor to do.
  await page.getByTestId("visitor-image-input").setInputFiles({ name: "farmhouse.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.locator("[data-attachment-status]")).toHaveAttribute("data-attachment-status", "ready", { timeout: 10_000 });
  expect(observed.uploads).toHaveLength(2);
  await expect(page.getByTestId("visitor-image-notice")).toHaveCount(0);
});

test("a photo the server stays too busy to take, or the plan cannot take, shows why on its chip", async ({ page }) => {
  const photo = await makePhoto(page, 400, 300);
  const busy = { status: 503, body: { error: { code: "visitor_image_busy", message: "Try again." } } };
  const observed = await mockPublicChat(page, { acceptsImages: true, photo, uploadAnswers: [busy] });

  await page.goto(`/chat/${publicToken}`);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();

  await page.getByTestId("visitor-image-input").setInputFiles({ name: "farmhouse.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.locator("[data-attachment-status]")).toHaveAttribute("data-attachment-status", "error", { timeout: 10_000 });
  await expect(page.getByTestId("visitor-image-notice")).toHaveText("Busy right now. Try that photo again.");
  expect(observed.uploads).toHaveLength(2);
  await page.getByRole("button", { name: /^Remove photo \d+ of \d+$/ }).click();

  // The plan has no answers left: photos cannot be sent now, and nothing is tried again.
  await page.unroute(`**/backend/api/v1/public/chat/${publicToken}**`);
  const limited = await mockPublicChat(page, {
    acceptsImages: true,
    photo,
    uploadAnswers: [{ status: 429, body: { error: { code: "usage_limit_exceeded", message: "Usage limit exceeded" } } }],
  });
  await page.getByTestId("visitor-image-input").setInputFiles({ name: "farmhouse.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.locator("[data-attachment-status]")).toHaveAttribute("data-attachment-status", "error");
  await expect(page.getByTestId("visitor-image-notice")).toHaveText("Photos can't be sent right now.");
  expect(limited.uploads).toHaveLength(1);
});

test("a send refused for its photos clears them, says why, and keeps what the visitor typed", async ({ page }) => {
  const photo = await makePhoto(page, 400, 300);
  const observed = await mockPublicChat(page, { acceptsImages: true, photo, sendRefusals: [{ status: 409, code: "visitor_image_unavailable" }] });

  await page.goto(`/chat/${publicToken}`);
  const field = page.getByPlaceholder("Ask a question...");
  await expect(field).toBeVisible();
  await page.getByTestId("visitor-image-input").setInputFiles({ name: "farmhouse.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.locator("[data-attachment-status]")).toHaveAttribute("data-attachment-status", "ready");
  await field.fill(typedText);
  await page.getByRole("button", { name: "Send message" }).click();

  // The operator turned photos off after the upload: the photos are gone, with the reason, and the words are still there.
  await expect.poll(() => observed.sentBodies.length).toBe(1);
  await expect(page.locator("[data-attachment-status]")).toHaveCount(0);
  await expect(page.getByTestId("visitor-image-notice")).toHaveText("Photos can't be sent right now.");
  await expect(field).toHaveValue(typedText);
  await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);
  // The chat stops offering photos, but the reason stays on screen.
  await expect(page.getByRole("button", { name: "Attach photo" })).toHaveCount(0);

  // The words go on their own.
  await page.unroute(`**/api/public/chat/${publicToken}`);
  await page.route(`**/api/public/chat/${publicToken}`, async (route) => {
    observed.sentBodies.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `event: done\ndata: ${JSON.stringify({ conversationId, assistantMessageId: "55555555-5555-4555-8555-555555555552", answer: "Tell me more." })}\n\n`,
    });
  });
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Tell me more.")).toBeVisible();
  expect(observed.sentBodies[1]).toMatchObject({ message: typedText });
  expect(observed.sentBodies[1]).not.toHaveProperty("imageIds");
});

const sendBar = (page: Page) => page.getByRole("button", { name: "Send message" });

test("photos and words come back to the composer when a send fails before the server takes the photos, and go out on the next try", async ({ page }) => {
  const photo = await makePhoto(page, 400, 300);
  const observed = await mockPublicChat(page, {
    acceptsImages: true,
    photo,
    sendRefusals: [{ status: 503, code: "upstream_unavailable" }, { status: 429, code: "rate_limit_exceeded" }],
  });

  await page.goto(`/chat/${publicToken}`);
  const field = page.getByPlaceholder("Ask a question...");
  await expect(field).toBeVisible();
  await page.getByTestId("visitor-image-input").setInputFiles({ name: "farmhouse.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.locator("[data-attachment-status]")).toHaveAttribute("data-attachment-status", "ready");
  await field.fill(typedText);

  // The server could not be reached: the thread shows nothing was sent, and both come back, uploaded as before.
  await sendBar(page).click();
  await expect.poll(() => observed.sentBodies.length).toBe(1);
  await expect(page.locator("[data-attachment-status]")).toHaveAttribute("data-attachment-status", "ready");
  await expect(field).toHaveValue(typedText);
  await expect(page.getByTestId("visitor-image-notice")).toHaveText("Sorry, something went wrong. Please try again.");
  await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);

  // Held back by a rate limit: they come back again.
  await sendBar(page).click();
  await expect.poll(() => observed.sentBodies.length).toBe(2);
  await expect(page.locator("[data-attachment-status]")).toHaveAttribute("data-attachment-status", "ready");
  await expect(field).toHaveValue(typedText);

  // Then it goes, with the very photo that was uploaded once.
  await sendBar(page).click();
  await expect(page.getByText("I found three farmhouses on the coast.")).toBeVisible();
  expect(observed.sentBodies.map((body) => body.imageIds)).toEqual([[imageId], [imageId], [imageId]]);
  expect(observed.uploads).toHaveLength(1);
  await expect(page.locator("[data-attachment-status]")).toHaveCount(0);
});

test("photos the chat stops offering mid-composition are dropped with the reason, and the message goes on its own", async ({ page }) => {
  const photo = await makePhoto(page, 400, 300);
  const observed = await mockPublicChat(page, {
    acceptsImages: true,
    photo,
    uploadAnswers: [{ status: 201, body: { id: imageId, readingStatus: "read" } }, { status: 404, body: { error: { code: "visitor_images_unavailable", message: "No photos." } } }],
  });

  await page.goto(`/chat/${publicToken}`);
  const field = page.getByPlaceholder("Ask a question...");
  await expect(field).toBeVisible();
  await page.getByTestId("visitor-image-input").setInputFiles({ name: "first.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.locator("[data-attachment-status]")).toHaveAttribute("data-attachment-status", "ready");

  // The operator turned photos off: the second upload is refused, the first photo goes with it, and the notice outlives the button.
  await page.getByTestId("visitor-image-input").setInputFiles({ name: "second.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.getByRole("button", { name: "Attach photo" })).toHaveCount(0);
  await expect(page.locator("[data-attachment-status]")).toHaveCount(0);
  await expect(page.getByTestId("visitor-image-notice")).toHaveText("Photos can't be sent right now.");
  // A photo that was ready does not count toward a send that is no longer allowed to carry it.
  await expect(sendBar(page)).toBeDisabled();

  await field.fill(typedText);
  await sendBar(page).click();
  await expect(page.getByText("I found three farmhouses on the coast.")).toBeVisible();
  expect(observed.sentBodies[0]).toMatchObject({ message: typedText });
  expect(observed.sentBodies[0]).not.toHaveProperty("imageIds");
});

test("a file dropped anywhere on the chat is not opened by the browser while photos are on, and is left alone when they are off", async ({ page }) => {
  const photo = await makePhoto(page, 400, 300);
  const dropOnPage = () =>
    page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }));
      const over = new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true });
      document.body.dispatchEvent(over);
      const drop = new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
      document.body.dispatchEvent(drop);
      return { overCancelled: over.defaultPrevented, dropCancelled: drop.defaultPrevented };
    });

  await mockPublicChat(page, { acceptsImages: true, photo });
  await page.goto(`/chat/${publicToken}`);
  await expect(page.getByRole("button", { name: "Attach photo" })).toBeVisible();
  expect(await dropOnPage()).toEqual({ overCancelled: true, dropCancelled: true });
  // Nothing was attached: the drop was outside the composer.
  await expect(page.locator("[data-attachment-status]")).toHaveCount(0);

  const offPage = await page.context().newPage();
  await mockPublicChat(offPage, { acceptsImages: false, photo });
  await offPage.goto(`/chat/${publicToken}`);
  await expect(offPage.getByPlaceholder("Ask a question...")).toBeVisible();
  const off = await offPage.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1])], "photo.jpg", { type: "image/jpeg" }));
    const drop = new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
    document.body.dispatchEvent(drop);
    return drop.defaultPrevented;
  });
  expect(off).toBe(false);
});

test("a photo is removed from the keyboard with focus moving on, each Remove names its photo, and the target is big enough to hit", async ({ page }) => {
  const photo = await makePhoto(page, 400, 300);
  await mockPublicChat(page, { acceptsImages: true, photo });

  await page.goto(`/chat/${publicToken}`);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();
  await page.getByTestId("visitor-image-input").setInputFiles([
    { name: "one.jpg", mimeType: "image/jpeg", buffer: photo },
    { name: "two.jpg", mimeType: "image/jpeg", buffer: photo },
  ]);
  await expect(page.locator("[data-attachment-status=ready]")).toHaveCount(2);

  const first = page.getByRole("button", { name: "Remove photo 1 of 2" });
  const second = page.getByRole("button", { name: "Remove photo 2 of 2" });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  const box = await first.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);

  // Removing the first moves focus to the next photo's Remove, which is now the only one.
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-attachment-status]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove photo 1 of 1" })).toBeFocused();

  // Removing the last moves focus to the attach control, and with the chips gone it is still there to use.
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-attachment-status]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach photo" })).toBeFocused();
});

test("a mouse removal leaves focus in the message field where the visitor was typing", async ({ page }) => {
  const photo = await makePhoto(page, 400, 300);
  await mockPublicChat(page, { acceptsImages: true, photo });

  await page.goto(`/chat/${publicToken}`);
  const field = page.getByPlaceholder("Ask a question...");
  await expect(field).toBeVisible();
  await page.getByTestId("visitor-image-input").setInputFiles(
    ["a", "b", "c"].map((name) => ({ name: `${name}.jpg`, mimeType: "image/jpeg", buffer: photo })),
  );
  await expect(page.locator("[data-attachment-status=ready]")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Attach photo" })).toBeDisabled();

  // A click on Remove keeps the visitor's place in the message field.
  await field.focus();
  await page.getByRole("button", { name: "Remove photo 3 of 3" }).click();
  await expect(page.locator("[data-attachment-status]")).toHaveCount(2);
  await expect(field).toBeFocused();
});

test("three large photos picked at once are shrunk one after another, previewed as shrunk, and all uploaded", async ({ page }) => {
  const photo = await makePhoto(page, 3200, 2400);
  const observed = await mockPublicChat(page, { acceptsImages: true, photo });

  await page.goto(`/chat/${publicToken}`);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();
  await page.getByTestId("visitor-image-input").setInputFiles(
    ["a", "b", "c"].map((name) => ({ name: `${name}.jpg`, mimeType: "image/jpeg", buffer: photo })),
  );

  await expect(page.locator("[data-attachment-status=ready]")).toHaveCount(3, { timeout: 30_000 });
  expect(observed.uploads).toHaveLength(3);
  for (const upload of observed.uploads) {
    expect(Math.max(jpegSize(upload.jpeg).width, jpegSize(upload.jpeg).height)).toBeLessThanOrEqual(1600);
  }
  // The chips show the photo as it was shrunk, not the original that is twice as wide.
  const widths = await page.locator("[data-attachment-status] img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).naturalWidth));
  expect(widths).toHaveLength(3);
  expect(Math.max(...widths)).toBeLessThanOrEqual(1600);
  expect(Math.min(...widths)).toBeGreaterThan(0);
});

test("the notice and a failed chip read at 4.5:1 or better on a dark chat theme", async ({ page }) => {
  const photo = await makePhoto(page, 400, 300);
  const dark = { brand: "#6366f1", brandText: "#ffffff", surface: "#0b1220", text: "#e2e8f0" };
  await mockPublicChat(page, { acceptsImages: true, photo, theme: dark });

  await page.goto(`/chat/${publicToken}`);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();
  await page.getByTestId("visitor-image-input").setInputFiles({ name: "animation.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  const notice = page.getByTestId("visitor-image-notice");
  await expect(notice).toHaveText("Use a JPEG, PNG or WebP photo.");

  const contrast = await notice.evaluate((element) => {
    const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = ([r, g, b]: number[]) => {
      const [lr, lg, lb] = [r, g, b].map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    let background = element as HTMLElement | null;
    while (background && /rgba\(.*, 0\)|transparent/.test(getComputedStyle(background).backgroundColor)) background = background.parentElement;
    const [light, dim] = [luminance(channels(getComputedStyle(element).color)), luminance(channels(getComputedStyle(background ?? document.body).backgroundColor))].sort((a, b) => b - a);
    return (light + 0.05) / (dim + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
});
