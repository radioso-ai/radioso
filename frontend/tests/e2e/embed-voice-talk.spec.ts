import { expect, test, type Frame, type Page, type Route } from "@playwright/test";

// The website embed's Talk journey, driven through the real launcher and the real chat frame with
// the network mocked at its edges: the embed config says whether the agent takes voice calls, the
// session start answers as the backend would, and the vendor's browser client is swapped for a
// stand-in the frame's own origin installs (`window.__radiosoVoiceRuntime`), so the test plays the
// vendor: it connects, changes who is speaking, says lines and records being ended. The microphone
// is Chromium's fake device behind a granted permission, so the frame's permissions policy and the
// launcher's `allow="microphone"` delegation are both exercised.

const TOKEN = "e2e-voice-token";
const SIGNED_URL = "wss://vendor.test/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
const SESSION_KEY = "33333333-3333-4333-8333-333333333333";

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

const fulfillJson = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const bootstrapSessionPayload = () => ({
  workspaceName: "Acme",
  agentId: "agent-1",
  agentName: "Support",
  assistantLinkUtmEnabled: false,
  citationDisplayEnabled: true,
  publicChatToken: TOKEN,
  publicSessionId: "11111111-1111-4111-8111-111111111111",
  publicSessionToken: "public-session-token",
  resumeToken: "resume-token",
  assistantBootstrapActive: false,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  resumeExpiresAt: new Date(Date.now() + 600_000).toISOString(),
});

type VoiceStartAnswer = { status: 200; body: unknown } | { status: 429 | 503; body: unknown };

const startedSession = {
  vendor: "elevenlabs",
  signedUrl: SIGNED_URL,
  sessionKey: SESSION_KEY,
  locale: "en",
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
};

/** A vendor stand-in the frame picks up in place of the ElevenLabs client. */
const installVendorStandIn = () => {
  type Callbacks = {
    onConnected: () => void;
    onModeChange: (mode: string) => void;
    onLine: (line: { speaker: string; text: string }) => void;
    onDisconnected: () => void;
  };
  const record: { opened: Array<Record<string, unknown>>; ended: number; callbacks: Callbacks | null } = {
    opened: [],
    ended: 0,
    callbacks: null,
  };
  Object.assign(window, {
    __voiceTest: record,
    __radiosoVoiceRuntime: {
      open: async (input: Record<string, unknown>, callbacks: Callbacks) => {
        record.opened.push(input);
        record.callbacks = callbacks;
        return {
          end: async () => {
            record.ended += 1;
            callbacks.onDisconnected();
          },
        };
      },
    },
  });
};

const openEmbed = async (
  page: Page,
  options: { voiceAvailable: boolean; voiceStart?: VoiceStartAnswer },
) => {
  const voiceStarts: Array<{ headers: Record<string, string>; body: unknown }> = [];
  await page.route("**/backend/api/v1/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/embed/config/**", (route) => fulfillJson(route, { voice: { available: options.voiceAvailable } }));
  await page.route("**/api/embed/session/**", (route) => fulfillJson(route, bootstrapSessionPayload()));
  await page.route("**/api/public/chat/*/voice/sessions", async (route) => {
    voiceStarts.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
    const answer = options.voiceStart ?? { status: 200, body: startedSession };
    await fulfillJson(route, answer.body, answer.status);
  });
  await page.addInitScript(installVendorStandIn);

  await page.goto(`/embed-test?token=${TOKEN}`);
  await page.locator(".radioso-launcher").click();
  const frame = page.frameLocator('iframe[src*="/embed-frame"]');
  await expect(frame.getByRole("textbox")).toBeVisible();
  return { frame, voiceStarts, chatFrame: () => page.frames().find((candidate) => candidate.url().includes("/embed-frame")) as Frame };
};

const vendor = (chatFrame: Frame) => ({
  connect: () => chatFrame.evaluate(() => (window as unknown as { __voiceTest: { callbacks: { onConnected: () => void } } }).__voiceTest.callbacks.onConnected()),
  speak: (mode: "speaking" | "listening") =>
    chatFrame.evaluate((next) => (window as unknown as { __voiceTest: { callbacks: { onModeChange: (mode: string) => void } } }).__voiceTest.callbacks.onModeChange(next), mode),
  say: (speaker: "caller" | "agent", text: string) =>
    chatFrame.evaluate(
      (line) => (window as unknown as { __voiceTest: { callbacks: { onLine: (line: unknown) => void } } }).__voiceTest.callbacks.onLine(line),
      { speaker, text },
    ),
  hangUp: () => chatFrame.evaluate(() => (window as unknown as { __voiceTest: { callbacks: { onDisconnected: () => void } } }).__voiceTest.callbacks.onDisconnected()),
  record: () => chatFrame.evaluate(() => {
    const record = (window as unknown as { __voiceTest: { opened: unknown[]; ended: number } }).__voiceTest;
    return { opened: record.opened, ended: record.ended };
  }),
});

test("an agent without voice shows no Talk button", async ({ page }) => {
  const { frame } = await openEmbed(page, { voiceAvailable: false });

  await expect(frame.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toHaveCount(0);
  await expect(page.locator('iframe[src*="/embed-frame"]')).not.toHaveAttribute("allow", /microphone/);
});

test("a visitor talks to the agent: connecting, listening, speaking, spoken lines, then End call", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const { frame, voiceStarts, chatFrame } = await openEmbed(page, { voiceAvailable: true });
  await expect(page.locator('iframe[src*="/embed-frame"]')).toHaveAttribute("allow", /microphone/);

  await frame.getByRole("button", { name: "Talk" }).click();
  await expect(frame.getByRole("status").filter({ hasText: "Connecting…" })).toBeVisible();
  await expect.poll(async () => (await vendor(chatFrame()).record()).opened.length).toBe(1);

  expect(voiceStarts).toHaveLength(1);
  expect(voiceStarts[0].headers["x-radioso-public-session"]).toBe("public-session-token");
  expect((await vendor(chatFrame()).record()).opened[0]).toEqual({ signedUrl: SIGNED_URL, sessionKey: SESSION_KEY, locale: "en" });

  await vendor(chatFrame()).connect();
  await expect(frame.getByRole("status").filter({ hasText: "Listening" })).toBeVisible();
  await vendor(chatFrame()).say("caller", "Are you open on Sunday?");
  await vendor(chatFrame()).speak("speaking");
  await expect(frame.getByRole("status").filter({ hasText: "Speaking" })).toBeVisible();
  await vendor(chatFrame()).say("agent", "Yes, from ten until four.");
  await vendor(chatFrame()).speak("listening");
  await expect(frame.getByRole("status").filter({ hasText: "Listening" })).toBeVisible();

  await expect(frame.getByText("Are you open on Sunday?")).toBeVisible();
  await expect(frame.getByText("Yes, from ten until four.")).toBeVisible();
  await expect(frame.getByText("Spoken")).toHaveCount(2);
  // The composer gives way to the call bar while the call runs.
  await expect(frame.getByRole("textbox")).toHaveCount(0);

  await frame.getByRole("button", { name: "End call" }).click();
  await expect(frame.getByRole("status").filter({ hasText: "Call ended" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toBeVisible();
  await expect(frame.getByRole("textbox")).toBeVisible();
  expect((await vendor(chatFrame()).record()).ended).toBe(1);
});

test("a call ends when the vendor hangs up", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const { frame, chatFrame } = await openEmbed(page, { voiceAvailable: true });

  await frame.getByRole("button", { name: "Talk" }).click();
  await expect.poll(async () => (await vendor(chatFrame()).record()).opened.length).toBe(1);
  await vendor(chatFrame()).connect();
  await expect(frame.getByRole("status").filter({ hasText: "Listening" })).toBeVisible();

  await vendor(chatFrame()).hangUp();
  await expect(frame.getByRole("status").filter({ hasText: "Call ended" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toBeVisible();
});

test("closing the panel ends the call", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const { frame, chatFrame } = await openEmbed(page, { voiceAvailable: true });

  await frame.getByRole("button", { name: "Talk" }).click();
  await expect.poll(async () => (await vendor(chatFrame()).record()).opened.length).toBe(1);
  await vendor(chatFrame()).connect();
  await expect(frame.getByRole("status").filter({ hasText: "Listening" })).toBeVisible();

  await page.locator(".radioso-launcher").click();
  await expect.poll(async () => (await vendor(chatFrame()).record()).ended).toBe(1);
});

test("a session that cannot be started shows one line and keeps the Talk button", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const { frame, chatFrame } = await openEmbed(page, {
    voiceAvailable: true,
    voiceStart: { status: 503, body: { error: { code: "voice_unavailable", message: "The voice session could not be started. Try again later." } } },
  });

  await frame.getByRole("button", { name: "Talk" }).click();

  await expect(frame.getByRole("status").filter({ hasText: "Talking isn't available right now. Try again later." })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toBeVisible();
  expect((await vendor(chatFrame()).record()).opened).toEqual([]);
});

test("a refused microphone shows one line and spends no session start", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
      },
    });
  });
  const { frame, voiceStarts } = await openEmbed(page, { voiceAvailable: true });

  await frame.getByRole("button", { name: "Talk" }).click();

  await expect(frame.getByRole("status").filter({ hasText: "Talking needs your microphone." })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toBeVisible();
  expect(voiceStarts).toEqual([]);
});
