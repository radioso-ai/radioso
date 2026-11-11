import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  testExecutionFixtureId,
  workspaceKey,
} from "./dashboard-fixtures";

// Test Chat's Talk journey (#1536): the operator talks to the draft under test through the same
// voice session and call controls as the website embed, with Test Chat's own session start, and the
// call's turns land in the test's transcript marked spoken. The backend is mocked at its edges (the
// start answers as it would, and the test's transcript is read back with the spoken turns the
// backend recorded); the vendor's WebSocket is a stand-in the test speaks the vendor's protocol
// through; the microphone is Chromium's fake device behind a granted permission.

const testChatUrl = `/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`;
const SIGNED_URL = "wss://vendor.test/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
const SESSION_KEY = "44444444-4444-4444-8444-444444444444";
// A second and a half of silence at the vendor's default output format, 16 kHz 16-bit PCM.
const SILENCE_PCM_16K = Buffer.alloc(48_000).toString("base64");
const voiceOn = {
  enabled: true,
  bridgeLines: {},
  fallbackLine: {},
  runtime: { vendor: "elevenlabs" as const, agentId: "agent_42", region: "eu" as const },
};

/**
 * A microphone that hears a quiet tone, made in the page itself: the call needs a stream, not a
 * device, and a page-made stream behaves the same on every machine that runs the suite.
 */
const givenAMicrophone = (page: Page) => page.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext();
    const tone = context.createOscillator();
    const quiet = context.createGain();
    quiet.gain.value = 0.01;
    const stream = context.createMediaStreamDestination();
    tone.connect(quiet).connect(stream);
    tone.start();
    return stream.stream;
  };
});

/** The vendor's end of the call: what the client sent, and a way to answer as the vendor would. */
const vendorStandIn = async (page: Page) => {
  const sockets: WebSocketRoute[] = [];
  const initiations: Array<Record<string, unknown>> = [];
  await page.routeWebSocket("wss://vendor.test/**", (socket) => {
    sockets.push(socket);
    socket.onMessage((message) => {
      const event = JSON.parse(String(message)) as Record<string, unknown>;
      if (event.type === "conversation_initiation_client_data") initiations.push(event);
    });
    socket.onClose((code, reason) => void socket.close({ code, reason }));
  });
  const send = (event: Record<string, unknown>) => sockets.at(-1)!.send(JSON.stringify(event));
  return {
    opened: () => sockets.length,
    initiations: () => initiations,
    accept: () => send({
      type: "conversation_initiation_metadata",
      conversation_initiation_metadata_event: { conversation_id: "conv_1", agent_output_audio_format: "pcm_16000", user_input_audio_format: "pcm_16000" },
    }),
    callerSays: (text: string, eventId: number) => send({ type: "user_transcript", user_transcription_event: { user_transcript: text, event_id: eventId } }),
    agentAnswers: (text: string, eventId: number) => {
      send({ type: "agent_response", agent_response_event: { agent_response: text, event_id: eventId } });
      send({ type: "audio", audio_event: { audio_base_64: SILENCE_PCM_16K, event_id: eventId } });
    },
  };
};

/**
 * Test Chat over the dashboard mocks, with the agent's voice as the readiness read reports it, a
 * session start that answers as the backend would, and the test's transcript as the backend records
 * a call's turns once the call has had them.
 */
const openTestChat = async (page: Page, readiness: { ready: true; missing: null } | { ready: false; missing: "runtime" | "vendor_key" }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    voiceCallReadiness: readiness,
    agentSettingsOverrides: { voice: voiceOn },
  });
  const starts: Array<{ url: string; headers: Record<string, string> }> = [];
  const publicStarts: string[] = [];
  let spokenTurnsRecorded = false;
  // The version the started test runs, as the test's own start answered it.
  let testedRevision: unknown = null;
  page.on("response", (response) => {
    if (response.request().method() === "POST" && /\/agents\/[^/]+\/test-executions$/.test(new URL(response.url()).pathname)) {
      void response.json().then((started: { sides: Array<{ revision: unknown }> }) => { testedRevision = started.sides[0]?.revision ?? null; }, () => undefined);
    }
  });
  await page.route("**/api/public/chat/*/voice/sessions", async (route) => {
    publicStarts.push(route.request().url());
    await route.abort();
  });
  await page.route(/\/backend\/api\/v1\/agents\/[^/]+\/test-executions\/[^/]+\/voice-sessions$/, async (route) => {
    starts.push({ url: route.request().url(), headers: route.request().headers() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ vendor: "elevenlabs", signedUrl: SIGNED_URL, sessionKey: SESSION_KEY, locale: "en", recordingNotice: "This call is recorded." }),
    });
  });
  await page.route(/\/backend\/api\/v1\/agents\/[^/]+\/test-executions\/[^/?]+$/, async (route) => {
    const executionId = new URL(route.request().url()).pathname.split("/").pop()!;
    if (route.request().method() !== "GET" || !spokenTurnsRecorded) {
      await route.fallback();
      return;
    }
    const spokenAt = (role: "user" | "assistant", content: string) => ({ turnId: "spoken-turn-1", role, content, attemptId: "spoken-attempt-1", createdAt: nowIso, spoken: true, ...(role === "assistant" ? { messageId: "spoken-message-1" } : {}) });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        execution: {
          id: executionId, generation: 1, mode: "single", skillEffects: "suppressed", state: "completed", createdAt: nowIso, testValues: [], seededTurnCount: 0,
          sides: [{
            id: "side-1-0",
            revision: testedRevision,
            conversationId: "conversation-1-0", state: "completed", retryable: false,
            history: [spokenAt("user", "Do you open on Sundays?"), spokenAt("assistant", "On Sundays we open at ten.")],
          }],
          attempts: [{ sideId: "side-1-0", turnId: "spoken-turn-1", attemptId: "spoken-attempt-1", fence: 1, state: "completed", failureCode: null, leaseExpiresAt: nowIso, createdAt: nowIso, updatedAt: nowIso }],
        },
      }),
    });
  });
  await page.goto(testChatUrl);
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();
  return { starts, publicStarts, recordSpokenTurns: () => { spokenTurnsRecorded = true; } };
};

test("an operator talks to the draft from Test Chat, and the call's turns land in the test marked spoken", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  await givenAMicrophone(page);
  const vendor = await vendorStandIn(page);
  const { starts, publicStarts, recordSpokenTurns } = await openTestChat(page, { ready: true, missing: null });

  await page.getByRole("button", { name: "Talk" }).click();
  // The test the call runs on was started for it, and the start went through Test Chat's own route.
  await expect.poll(() => starts.length).toBe(1);
  await expect.poll(() => vendor.opened(), { timeout: 15_000 }).toBe(1);
  expect(starts[0].url).toContain(`/agents/${defaultAgentId}/test-executions/${testExecutionFixtureId(1)}/voice-sessions`);
  expect(starts[0].headers["x-radioso-csrf"]).toBe("1");
  expect(publicStarts).toEqual([]);
  await expect.poll(() => vendor.initiations()).toHaveLength(1);
  expect(vendor.initiations()[0].custom_llm_extra_body).toEqual({ session_key: SESSION_KEY, locale: "en" });

  vendor.accept();
  await expect(page.getByRole("status").filter({ hasText: "Listening" })).toBeVisible();
  await expect(page.getByText("This call is recorded.")).toBeVisible();
  // The call bar stands in for the composer while the call runs.
  await expect(page.getByPlaceholder("Ask a question...")).toHaveCount(0);

  recordSpokenTurns();
  vendor.callerSays("Do you open on Sundays?", 1);
  vendor.agentAnswers("On Sundays we open at ten.", 2);
  await expect(page.getByText("On Sundays we open at ten.")).toBeVisible();
  await expect(page.getByText("Do you open on Sundays?")).toBeVisible();
  await expect(page.getByText("Spoken", { exact: true })).toHaveCount(2);

  await page.getByRole("button", { name: "End call" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Call ended" })).toBeVisible();
  await expect(page.getByPlaceholder("Ask a question...")).toBeVisible();
  await expect(page.getByText("Spoken", { exact: true })).toHaveCount(2);
});

test("Talk waits, disabled, with one line naming what the agent's voice still needs", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const { starts } = await openTestChat(page, { ready: false, missing: "vendor_key" });

  const talk = page.getByRole("button", { name: "Talk" });
  await expect(talk).toBeDisabled();
  await expect(page.getByText("Store the ElevenLabs key under Settings → Providers first.")).toBeVisible();
  expect(starts).toEqual([]);
});
