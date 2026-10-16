import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";

// The website embed's Talk journey, driven through the real launcher, the real chat frame and the
// real ElevenLabs browser client, with the host page on 127.0.0.1 and the app host (the launcher
// script and the chat frame) on localhost, so the frame is cross-origin as on a customer's site,
// and the network mocked at its edges: the embed config says
// whether the agent takes voice calls, the session start answers as the backend would, and the
// vendor's WebSocket is a stand-in the test speaks the vendor's protocol through (handshake,
// transcripts, audio, interruption, corrections, hang-up). The microphone is Chromium's fake device
// behind a granted permission, so the frame's permissions policy, the launcher's
// `allow="microphone"` delegation and the client's worklets under the frame's script policy all run.

const TOKEN = "e2e-voice-token";
const SIGNED_URL = "wss://vendor.test/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
const SESSION_KEY = "33333333-3333-4333-8333-333333333333";
// A second and a half of silence at the vendor's default output format, 16 kHz 16-bit PCM.
const SILENCE_PCM_16K = Buffer.alloc(48_000).toString("base64");

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      // The host page is served through the test's route, which Chromium treats as a public
      // address; it would otherwise refuse that page the app host on the loopback address.
      "--disable-features=LocalNetworkAccessChecks",
    ],
  },
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

const startedSession = {
  vendor: "elevenlabs",
  signedUrl: SIGNED_URL,
  sessionKey: SESSION_KEY,
  locale: "en",
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
};

/** The vendor's end of the call: what the client sent, and a way to answer as the vendor would. */
const vendorStandIn = async (page: Page) => {
  const sockets: WebSocketRoute[] = [];
  const initiations: Array<Record<string, unknown>> = [];
  let closedByPage = 0;
  await page.routeWebSocket("wss://vendor.test/**", (socket) => {
    sockets.push(socket);
    socket.onMessage((message) => {
      const event = JSON.parse(String(message)) as Record<string, unknown>;
      if (event.type === "conversation_initiation_client_data") initiations.push(event);
    });
    socket.onClose(() => {
      closedByPage += 1;
    });
  });
  const send = (event: Record<string, unknown>) => sockets.at(-1)!.send(JSON.stringify(event));
  return {
    initiations: () => initiations,
    opened: () => sockets.length,
    closedByPage: () => closedByPage,
    accept: () => send({
      type: "conversation_initiation_metadata",
      conversation_initiation_metadata_event: { conversation_id: "conv_1", agent_output_audio_format: "pcm_16000", user_input_audio_format: "pcm_16000" },
    }),
    callerSays: (text: string, eventId: number) => send({ type: "user_transcript", user_transcription_event: { user_transcript: text, event_id: eventId } }),
    agentAnswers: (text: string, eventId: number) => {
      send({ type: "agent_response", agent_response_event: { agent_response: text, event_id: eventId } });
      send({ type: "audio", audio_event: { audio_base_64: SILENCE_PCM_16K, event_id: eventId } });
    },
    callerTalksOver: (eventId: number, heard: { original: string; spoken: string }) => {
      send({ type: "interruption", interruption_event: { event_id: eventId } });
      send({
        type: "agent_response_correction",
        agent_response_correction_event: { original_agent_response: heard.original, corrected_agent_response: heard.spoken, event_id: eventId },
      });
    },
    hangUp: () => sockets.at(-1)!.close({ code: 1000, reason: "agent ended the call" }),
    fails: (message: string) => send({ type: "error", error_event: { error_type: "internal_error", message } }),
  };
};

/**
 * The agent as the embed config reflects it: the backend serves `voice.available` only when the
 * operator offers calls on the website and the agent's voice is ready (the contract test pins that
 * rule); the embed reads the result.
 */
type AgentVoice = { voiceReady: boolean; voiceCallsOffered: boolean };
const callsOffered: AgentVoice = { voiceReady: true, voiceCallsOffered: true };

const openEmbed = async (
  page: Page,
  options: AgentVoice & { voiceStart?: { status: number; body: unknown }; hostPermissionsPolicy?: string },
) => {
  const voiceStarts: Array<{ headers: Record<string, string>; body: unknown }> = [];
  await page.route("**/backend/api/v1/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/embed/config/**", (route) =>
    fulfillJson(route, { voice: { available: options.voiceReady && options.voiceCallsOffered } }));
  await page.route("**/api/embed/session/**", (route) => fulfillJson(route, bootstrapSessionPayload()));
  await page.route("**/api/public/chat/*/voice/sessions", async (route) => {
    voiceStarts.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
    const answer = options.voiceStart ?? { status: 200, body: startedSession };
    await fulfillJson(route, answer.body, answer.status);
  });

  // The host page stands in for a customer's site, which is not served with the app's own security
  // headers: no script policy that refuses the app host's launcher, and the site's own
  // Permissions-Policy, or none.
  await page.route((url) => url.pathname === "/embed-test", async (route) => {
    const response = await route.fetch();
    const headers = Object.fromEntries(Object.entries(response.headers())
      .filter(([name]) => name !== "content-security-policy" && name !== "permissions-policy"));
    await route.fulfill({
      response,
      headers: options.hostPermissionsPolicy ? { ...headers, "permissions-policy": options.hostPermissionsPolicy } : headers,
    });
  });

  // The host page and the app host are two origins, as a customer's site and app.radioso.ai are.
  const host = new URL(test.info().project.use.baseURL!);
  const appHost = new URL(host);
  appHost.hostname = "localhost";
  await page.goto(`${host.origin}/embed-test?token=${TOKEN}&appOrigin=${encodeURIComponent(appHost.origin)}`);
  await page.locator(".radioso-launcher").click();
  const frame = page.frameLocator('iframe[src*="/embed-frame"]');
  await expect(frame.getByRole("textbox")).toBeVisible();
  return { frame, voiceStarts };
};

const callStatus = (frame: ReturnType<Page["frameLocator"]>, text: string) => frame.getByRole("status").filter({ hasText: text });

test("an agent without voice shows no Talk button", async ({ page }) => {
  const { frame } = await openEmbed(page, { voiceReady: false, voiceCallsOffered: true });

  await expect(frame.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toHaveCount(0);
  await expect(page.locator('iframe[src*="/embed-frame"]')).not.toHaveAttribute("allow", /microphone/);
});

test("an agent whose voice is ready shows no Talk button until the operator offers calls on the website", async ({ page }) => {
  const { frame } = await openEmbed(page, { voiceReady: true, voiceCallsOffered: false });

  await expect(frame.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toHaveCount(0);
  await expect(page.locator('iframe[src*="/embed-frame"]')).not.toHaveAttribute("allow", /microphone/);
});

test("a host page whose Permissions-Policy denies the microphone shows no Talk button", async ({ page }) => {
  const { frame } = await openEmbed(page, { ...callsOffered, hostPermissionsPolicy: "microphone=()" });

  await expect(frame.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toHaveCount(0);
});

test("a page that cannot ask for a microphone shows no Talk button", async ({ page }) => {
  // What a host page served over plain http looks like to the frame: not a secure context.
  await page.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, get: () => false });
  });
  const { frame } = await openEmbed(page, callsOffered);

  await expect(frame.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toHaveCount(0);
});

test("a visitor talks to the agent: connecting, listening, speaking, talking over a reply, then End call", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const vendor = await vendorStandIn(page);
  const { frame, voiceStarts } = await openEmbed(page, callsOffered);
  const chatFrame = page.locator('iframe[src*="/embed-frame"]');
  await expect(chatFrame).toHaveAttribute("allow", /microphone/);
  // The frame is on the app host, another origin than the page that embeds it.
  await expect(chatFrame).toHaveAttribute("src", /^http:\/\/localhost:/);

  await frame.getByRole("button", { name: "Talk" }).click();
  await expect(callStatus(frame, "Connecting…")).toBeVisible();
  await expect.poll(() => vendor.opened()).toBe(1);
  expect(voiceStarts).toHaveLength(1);
  expect(voiceStarts[0].headers["x-radioso-public-session"]).toBe("public-session-token");
  await expect.poll(() => vendor.initiations()).toHaveLength(1);
  expect(vendor.initiations()[0].custom_llm_extra_body).toEqual({ session_key: SESSION_KEY, locale: "en" });

  vendor.accept();
  await expect(callStatus(frame, "Listening")).toBeVisible();
  // The call bar stands in for the composer, and typing goes nowhere.
  await expect(frame.getByRole("textbox")).toHaveCount(0);

  vendor.callerSays("Are you open on Sunday?", 1);
  vendor.agentAnswers("We open at ten and close at four on Sundays.", 2);
  await expect(callStatus(frame, "Speaking")).toBeVisible();
  await expect(frame.getByText("We open at ten and close at four on Sundays.")).toBeVisible();

  vendor.callerTalksOver(3, { original: "We open at ten and close at four on Sundays.", spoken: "We open at ten" });
  await expect(callStatus(frame, "Listening")).toBeVisible();
  await expect(frame.getByText("We open at ten", { exact: true })).toBeVisible();
  await expect(frame.getByText("We open at ten and close at four on Sundays.")).toHaveCount(0);
  await expect(frame.getByText("Are you open on Sunday?")).toBeVisible();
  await expect(frame.getByText("Spoken")).toHaveCount(2);

  await frame.getByRole("button", { name: "End call" }).click();
  await expect(callStatus(frame, "Call ended")).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toBeVisible();
  await expect(frame.getByRole("textbox")).toBeVisible();
  await expect.poll(() => vendor.closedByPage()).toBe(1);
});

test("a call ends when the vendor hangs up", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const vendor = await vendorStandIn(page);
  const { frame } = await openEmbed(page, callsOffered);

  await frame.getByRole("button", { name: "Talk" }).click();
  await expect.poll(() => vendor.initiations()).toHaveLength(1);
  vendor.accept();
  await expect(callStatus(frame, "Listening")).toBeVisible();

  await vendor.hangUp();
  await expect(callStatus(frame, "Call ended")).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toBeVisible();
});

test("closing the panel ends the call", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const vendor = await vendorStandIn(page);
  const { frame } = await openEmbed(page, callsOffered);

  await frame.getByRole("button", { name: "Talk" }).click();
  await expect.poll(() => vendor.initiations()).toHaveLength(1);
  vendor.accept();
  await expect(callStatus(frame, "Listening")).toBeVisible();

  await page.locator(".radioso-launcher").click();
  await expect.poll(() => vendor.closedByPage()).toBe(1);
});

test("End call while connecting goes back to Talk with no notice, and ends the session once the vendor opens it", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const vendor = await vendorStandIn(page);
  const { frame } = await openEmbed(page, callsOffered);

  await frame.getByRole("button", { name: "Talk" }).click();
  await expect.poll(() => vendor.initiations()).toHaveLength(1);
  await frame.getByRole("button", { name: "End call" }).click();

  await expect(frame.getByRole("button", { name: "Talk" })).toBeVisible();
  await expect(frame.getByRole("status")).toHaveCount(0);

  vendor.accept();
  await expect.poll(() => vendor.closedByPage()).toBe(1);
  await expect(frame.getByRole("status")).toHaveCount(0);
});

test("a session that cannot be started shows one line and keeps the Talk button", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const vendor = await vendorStandIn(page);
  const { frame } = await openEmbed(page, {
    ...callsOffered,
    voiceStart: { status: 503, body: { error: { code: "voice_unavailable", message: "The voice session could not be started. Try again later." } } },
  });

  await frame.getByRole("button", { name: "Talk" }).click();

  await expect(callStatus(frame, "Talking isn't available right now. Try again later.")).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toBeVisible();
  expect(vendor.opened()).toBe(0);
});

test("a vendor error that leaves the socket open ends the call with the unavailable line", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const vendor = await vendorStandIn(page);
  const { frame } = await openEmbed(page, callsOffered);

  await frame.getByRole("button", { name: "Talk" }).click();
  await expect.poll(() => vendor.initiations()).toHaveLength(1);
  vendor.accept();
  await expect(callStatus(frame, "Listening")).toBeVisible();

  vendor.fails("The agent could not continue.");

  await expect(callStatus(frame, "Talking isn't available right now. Try again later.")).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toBeVisible();
  await expect.poll(() => vendor.closedByPage()).toBe(1);
});

test("a vendor that never answers the handshake gives up after the connect timeout and lets the microphone go", async ({ page, context }) => {
  test.setTimeout(60_000);
  await context.grantPermissions(["microphone"]);
  const vendor = await vendorStandIn(page);
  const { frame } = await openEmbed(page, callsOffered);

  await frame.getByRole("button", { name: "Talk" }).click();
  await expect.poll(() => vendor.initiations()).toHaveLength(1);
  await expect(callStatus(frame, "Connecting…")).toBeVisible();

  // VOICE_CALL_BEHAVIOR.connectTimeoutMs is 10 seconds.
  await expect(callStatus(frame, "Talking isn't available right now. Try again later.")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => vendor.closedByPage()).toBe(1);
});

for (const [situation, errorName] of [["a refused microphone", "NotAllowedError"], ["a missing microphone", "NotFoundError"]] as const) test(`${situation} shows one line`, async ({ page }) => {
  await page.addInitScript((name) => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.reject(new DOMException("The microphone is not available", name)),
      },
    });
  }, errorName);
  const vendor = await vendorStandIn(page);
  const { frame, voiceStarts } = await openEmbed(page, callsOffered);

  await frame.getByRole("button", { name: "Talk" }).click();

  await expect(callStatus(frame, "Talking needs your microphone.")).toBeVisible();
  await expect(frame.getByRole("button", { name: "Talk" })).toBeVisible();
  // The vendor's client asks for the microphone once the session is started, so the start is spent.
  expect(voiceStarts).toHaveLength(1);
  expect(vendor.opened()).toBe(0);
});
