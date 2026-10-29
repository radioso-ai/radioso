import { describe, expect, it, vi } from "vitest";

import {
  ELEVENLABS_PRESET_LANGUAGES,
  ELEVENLABS_SESSION_LANGUAGES,
  createElevenLabsRuntimeProvisioner,
} from "../../src/modules/voiceChannel/adapters/elevenlabs/runtimeProvisioner.js";
import { VoiceVendorRequestError } from "../../src/modules/voiceChannel/domain.js";

type ProvisionerFetch = Parameters<typeof createElevenLabsRuntimeProvisioner>[0]["fetch"];
type FetchInit = Parameters<ProvisionerFetch>[1];

const credential = { apiKey: "xi-secret-0123456789" };
const spec = {
  displayName: "Front desk",
  completionsBaseUrl: "https://api.example.com/api/v1/agents/7f0c2a8e-5b1d-4c47-9a1e-0d6b2f7c9e41/voice/elevenlabs/v1",
  primaryLocale: "it-IT",
};
const US = "https://api.elevenlabs.io";
const EU = "https://api.eu.residency.elevenlabs.io";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = (status: number) => new Response(null, { status });
const invalidKeyOnOtherHost = () => json(400, { detail: { type: "authentication_error", code: "invalid_api_key", message: "Invalid API key" } });

/** An agent as ElevenLabs serves it, with settings Radioso does not own beside the ones it does. */
const storedAgent = (overrides: { secretId?: string | null; tags?: string[] } = {}) => ({
  agent_id: "agent_42",
  name: "Old name",
  tags: overrides.tags ?? ["support"],
  conversation_config: {
    agent: {
      first_message: "Hello there",
      language: "en",
      dynamic_variables: { dynamic_variable_placeholders: {} },
      prompt: {
        prompt: "Be nice",
        llm: "gemini-2.0-flash",
        temperature: 0.4,
        custom_llm: overrides.secretId === null
          ? null
          : { url: "https://old.example.com/v1", model_id: "radioso", api_key: { secret_id: overrides.secretId ?? "sec_old" } },
        built_in_tools: { end_call: { type: "system", name: "end_call" }, language_detection: null },
      },
    },
    language_presets: { de: { overrides: { agent: { first_message: "Hallo" } } } },
    turn: { turn_timeout: 7, speculative_turn: true },
    tts: { model_id: "eleven_v4_turbo", voice_id: "voice_1" },
    asr: { keywords: ["Radioso"] },
  },
  platform_settings: { overrides: { custom_llm_extra_body: false, conversation_config_override: { agent: { language: true } } }, call_limits: { daily_limit: 100 } },
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  redirect: string;
  body: unknown;
}

/** A scripted ElevenLabs: each request is answered by the first matching route, in order. */
const fakeElevenLabs = (routes: Array<[method: string, url: string | RegExp, respond: (call: Call) => Response | Promise<Response>]>) => {
  const calls: Call[] = [];
  const fetch = vi.fn<ProvisionerFetch>(async (url, init: FetchInit) => {
    const call: Call = { method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const route = routes.find(([method, match]) => method === init.method && (typeof match === "string" ? match === url : match.test(url)));
    if (!route) throw new Error(`Unexpected ${init.method} ${url}`);
    return route[2](call);
  });
  return { fetch, calls, provisioner: createElevenLabsRuntimeProvisioner({ fetch }) };
};

const rejectionOf = async (promise: Promise<unknown>): Promise<VoiceVendorRequestError> => {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(VoiceVendorRequestError);
  return error as VoiceVendorRequestError;
};

const probeUrl = (origin: string) => `${origin}/v1/convai/agents?page_size=1`;
const everyProbe = /\/v1\/convai\/agents\?page_size=1$/;

describe("ElevenLabs runtime provisioner: the account's region", () => {
  it("asks every region's host at once with the key in xi-api-key, follows no redirect, and names the one that answers 200", async () => {
    const { calls, provisioner } = fakeElevenLabs([
      ["GET", probeUrl(EU), () => json(200, { agents: [], next_cursor: null })],
      ["GET", everyProbe, invalidKeyOnOtherHost],
    ]);

    expect(await provisioner.locateAccount({ credential })).toEqual({ region: "eu" });
    expect(calls.map((call) => call.url).sort()).toEqual([
      probeUrl("https://api.elevenlabs.io"),
      probeUrl("https://api.eu.residency.elevenlabs.io"),
      probeUrl("https://api.in.residency.elevenlabs.io"),
      probeUrl("https://api.sg.residency.elevenlabs.io"),
    ]);
    for (const call of calls) {
      expect(call.headers).toEqual({ "xi-api-key": credential.apiKey });
      expect(call.redirect).toBe("error");
    }
  });

  it("rejects a key no host accepts", async () => {
    const { provisioner } = fakeElevenLabs([
      ["GET", probeUrl(US), () => json(401, { detail: { type: "authentication_error", code: "unauthorized", message: "Invalid API key" } })],
      ["GET", everyProbe, invalidKeyOnOtherHost],
    ]);

    const error = await rejectionOf(provisioner.locateAccount({ credential }));

    expect(error.reason).toBe("rejected");
    expect(error.vendorStatus).toBe(401);
  });

  it.each([
    ["the older envelope's status", 401, { detail: { status: "missing_permissions", message: "The API key you used is missing the permission convai_read to execute this operation." } }],
    ["the newer envelope's code", 403, { detail: { type: "authorization_error", code: "insufficient_permissions", message: "Forbidden" } }],
  ])("tells a key that may not read agents from a wrong key, by %s", async (_label, status, body) => {
    const { provisioner } = fakeElevenLabs([
      ["GET", probeUrl(US), () => json(status, body)],
      ["GET", everyProbe, invalidKeyOnOtherHost],
    ]);

    expect((await rejectionOf(provisioner.locateAccount({ credential }))).reason).toBe("insufficient_permissions");
  });

  it("does not call a key wrong while a host that could hold its account did not answer", async () => {
    const { provisioner } = fakeElevenLabs([
      ["GET", probeUrl(US), () => { throw new TypeError("fetch failed"); }],
      ["GET", everyProbe, invalidKeyOnOtherHost],
    ]);

    expect((await rejectionOf(provisioner.locateAccount({ credential }))).reason).toBe("unreachable");
  });

  it("reads a host's 5xx as unreachable", async () => {
    const { provisioner } = fakeElevenLabs([
      ["GET", probeUrl(US), () => empty(503)],
      ["GET", everyProbe, invalidKeyOnOtherHost],
    ]);

    const error = await rejectionOf(provisioner.locateAccount({ credential }));

    expect(error.reason).toBe("unreachable");
    expect(error.vendorStatus).toBe(503);
  });

  it("times a probe out on its own limit", async () => {
    const fetch = vi.fn<ProvisionerFetch>((url, init) => (url === probeUrl(US)
      ? new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })
      : Promise.resolve(invalidKeyOnOtherHost())));
    const provisioner = createElevenLabsRuntimeProvisioner({ fetch, probeTimeoutMs: 20 });

    expect((await rejectionOf(provisioner.locateAccount({ credential }))).reason).toBe("timeout");
  });
});

describe("ElevenLabs runtime provisioner: keeping the agent", () => {
  it("creates a credential secret, then the agent on the region's host with every setting Radioso owns", async () => {
    const { calls, provisioner } = fakeElevenLabs([
      ["POST", `${EU}/v1/convai/secrets`, () => json(200, { type: "stored", secret_id: "sec_new", name: "radioso" })],
      ["POST", `${EU}/v1/convai/agents/create`, () => json(200, { agent_id: "agent_new" })],
    ]);

    const ensured = await provisioner.ensureAgent({ region: "eu", credential, spec, vendorAgentId: null, bearer: "rk_live_secret" });

    expect(ensured).toEqual({ outcome: "created", vendorAgentId: "agent_new", primaryLocaleSupported: true });
    const [secret, create] = calls;
    expect(secret.body).toMatchObject({ type: "new", value: "rk_live_secret" });
    expect((secret.body as { name: string }).name).toMatch(/^radioso-[A-Za-z0-9-]+$/);
    const body = create.body as {
      name: string;
      tags: string[];
      conversation_config: {
        agent: { first_message: string; language: string; prompt: Record<string, unknown> };
        language_presets: Record<string, unknown>;
        turn: Record<string, unknown>;
      };
      platform_settings: { overrides: Record<string, unknown> };
    };
    expect(body.name).toBe("Radioso · Front desk");
    expect(body.tags).toEqual(["radioso-managed"]);
    expect(body.conversation_config.agent.first_message).toBe("");
    expect(body.conversation_config.agent.language).toBe("it");
    expect(body.conversation_config.agent.prompt).toMatchObject({
      prompt: "",
      llm: "custom-llm",
      custom_llm: { url: spec.completionsBaseUrl, model_id: "radioso", api_key: { secret_id: "sec_new" } },
      built_in_tools: { language_detection: { type: "system", name: "language_detection", params: { system_tool_type: "language_detection" } } },
      backup_llm_config: { preference: "disabled" },
    });
    expect(Object.keys(body.conversation_config.language_presets).sort()).toEqual(ELEVENLABS_PRESET_LANGUAGES.filter((code) => code !== "it").sort());
    expect(body.conversation_config.language_presets.de).toEqual({ overrides: {} });
    expect(body.conversation_config.turn).toEqual({ speculative_turn: false });
    // The vendor default says nothing; a session Radioso starts may open with the agent's greeting,
    // in the session's language.
    expect(body.platform_settings).toEqual({
      overrides: { custom_llm_extra_body: true, conversation_config_override: { agent: { first_message: true, language: true } } },
    });
  });

  it("names the agent Radioso alone when the Radioso agent has no name", async () => {
    const { calls, provisioner } = fakeElevenLabs([
      ["POST", `${US}/v1/convai/secrets`, () => json(200, { secret_id: "sec_new" })],
      ["POST", `${US}/v1/convai/agents/create`, () => json(200, { agent_id: "agent_new" })],
    ]);

    await provisioner.ensureAgent({ region: "us", credential, spec: { ...spec, displayName: "  " }, vendorAgentId: null, bearer: "rk" });

    expect((calls[1].body as { name: string }).name).toBe("Radioso");
  });

  it.each([
    ["pt-BR", "pt-br", true],
    ["pt-PT", "pt", true],
    ["zh-Hant-TW", "zh", true],
    ["nb-NO", "no", true],
    ["fil", "fil", true],
    [null, "en", true],
    ["km", "en", false],
  ])("starts calls in the vendor's language for the default locale %s", async (locale, language, supported) => {
    const { calls, provisioner } = fakeElevenLabs([
      ["POST", `${US}/v1/convai/secrets`, () => json(200, { secret_id: "sec_new" })],
      ["POST", `${US}/v1/convai/agents/create`, () => json(200, { agent_id: "agent_new" })],
    ]);

    const ensured = await provisioner.ensureAgent({ region: "us", credential, spec: { ...spec, primaryLocale: locale }, vendorAgentId: null, bearer: "rk" });

    const body = calls[1].body as { conversation_config: { agent: { language: string }; language_presets: Record<string, unknown> } };
    expect(body.conversation_config.agent.language).toBe(language);
    expect(Object.hasOwn(body.conversation_config.language_presets, language)).toBe(false);
    expect(ensured).toMatchObject({ primaryLocaleSupported: supported });
  });

  it("deletes the secret it just created when the vendor refuses the agent, and says the request was refused", async () => {
    const { calls, provisioner } = fakeElevenLabs([
      ["POST", `${US}/v1/convai/secrets`, () => json(200, { secret_id: "sec_new" })],
      ["POST", `${US}/v1/convai/agents/create`, () => json(422, { detail: [{ loc: ["body", "conversation_config"], msg: "Preset languages must be one of …", type: "value_error" }] })],
      ["DELETE", `${US}/v1/convai/secrets/sec_new`, () => empty(204)],
    ]);

    const error = await rejectionOf(provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: null, bearer: "rk" }));

    expect(error.reason).toBe("refused");
    expect(error.vendorStatus).toBe(422);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(`DELETE ${US}/v1/convai/secrets/sec_new`);
  });

  it("sets the named agent up again by reading it and patching back each section Radioso owns whole, keeping its secret", async () => {
    const { calls, provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, storedAgent())],
      ["PATCH", `${US}/v1/convai/agents/agent_42`, () => json(200, { agent_id: "agent_42" })],
    ]);

    const ensured = await provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: null });

    expect(ensured).toEqual({ outcome: "repaired", vendorAgentId: "agent_42", primaryLocaleSupported: true });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    const patch = calls[1].body as {
      name: string;
      tags: string[];
      conversation_config: Record<string, Record<string, unknown>>;
      platform_settings: Record<string, unknown>;
    };
    expect(Object.keys(patch.conversation_config).sort()).toEqual(["agent", "language_presets", "turn"]);
    expect(Object.keys(patch.platform_settings)).toEqual(["overrides"]);
    expect(patch.name).toBe("Radioso · Front desk");
    expect(patch.tags).toEqual(["support", "radioso-managed"]);
    const agent = patch.conversation_config.agent as { first_message: string; language: string; dynamic_variables: unknown; prompt: Record<string, unknown> };
    // Settings Radioso does not own ride along as the vendor served them; the section goes back whole.
    expect(agent.dynamic_variables).toEqual({ dynamic_variable_placeholders: {} });
    expect(agent.prompt.temperature).toBe(0.4);
    expect(agent.prompt.built_in_tools).toMatchObject({ end_call: { type: "system", name: "end_call" }, language_detection: { name: "language_detection" } });
    expect(agent).toMatchObject({ first_message: "", language: "it" });
    expect(agent.prompt).toMatchObject({
      prompt: "",
      llm: "custom-llm",
      custom_llm: { url: spec.completionsBaseUrl, model_id: "radioso", api_key: { secret_id: "sec_old" } },
      backup_llm_config: { preference: "disabled" },
    });
    expect(patch.conversation_config.turn).toEqual({ turn_timeout: 7, speculative_turn: false });
    expect(Object.hasOwn(patch.conversation_config.language_presets, "de")).toBe(true);
    expect(patch.conversation_config.language_presets.de).toEqual({ overrides: {} });
    // The override sections go back whole, the session's first message allowed beside what the vendor served.
    expect(patch.platform_settings.overrides).toEqual({
      custom_llm_extra_body: true,
      conversation_config_override: { agent: { language: true, first_message: true } },
    });
  });

  it("allows the session's first message and language on an agent whose overrides name no section", async () => {
    const stored = { ...storedAgent(), platform_settings: { overrides: { custom_llm_extra_body: true } } };
    const { calls, provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, stored)],
      ["PATCH", `${US}/v1/convai/agents/agent_42`, () => json(200, { agent_id: "agent_42" })],
    ]);

    await provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: null });

    expect((calls[1].body as { platform_settings: { overrides: unknown } }).platform_settings.overrides).toEqual({
      custom_llm_extra_body: true,
      conversation_config_override: { agent: { first_message: true, language: true } },
    });
  });

  it("allows the session's language again on an agent where someone turned it off", async () => {
    const stored = {
      ...storedAgent(),
      platform_settings: { overrides: { conversation_config_override: { agent: { language: false, prompt: { prompt: false } }, tts: { voice_id: true } } } },
    };
    const { calls, provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, stored)],
      ["PATCH", `${US}/v1/convai/agents/agent_42`, () => json(200, { agent_id: "agent_42" })],
    ]);

    await provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: null });

    expect((calls[1].body as { platform_settings: { overrides: unknown } }).platform_settings.overrides).toEqual({
      custom_llm_extra_body: true,
      conversation_config_override: { agent: { language: true, prompt: { prompt: false }, first_message: true }, tts: { voice_id: true } },
    });
  });

  it("keeps the agent's tags without adding Radioso's twice", async () => {
    const { calls, provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, storedAgent({ tags: ["radioso-managed"] }))],
      ["PATCH", `${US}/v1/convai/agents/agent_42`, () => json(200, {})],
    ]);

    await provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: null });

    expect((calls[1].body as { tags: string[] }).tags).toEqual(["radioso-managed"]);
  });

  it("rotates the credential by creating the new secret, pointing the agent at it, and only then deleting the old one", async () => {
    const { calls, provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, storedAgent())],
      ["POST", `${US}/v1/convai/secrets`, () => json(200, { secret_id: "sec_new" })],
      ["PATCH", `${US}/v1/convai/agents/agent_42`, () => json(200, {})],
      ["DELETE", `${US}/v1/convai/secrets/sec_old`, () => empty(204)],
    ]);

    const ensured = await provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: "rk_rotated" });

    expect(ensured).toMatchObject({ outcome: "repaired", vendorAgentId: "agent_42" });
    expect(calls.map((call) => `${call.method} ${call.url.replace(US, "")}`)).toEqual([
      "GET /v1/convai/agents/agent_42",
      "POST /v1/convai/secrets",
      "PATCH /v1/convai/agents/agent_42",
      "DELETE /v1/convai/secrets/sec_old",
    ]);
    expect((calls[2].body as { conversation_config: { agent: { prompt: { custom_llm: { api_key: unknown } } } } }).conversation_config.agent.prompt.custom_llm.api_key)
      .toEqual({ secret_id: "sec_new" });
  });

  it("still reports the rotation when the old secret will not go", async () => {
    const { provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, storedAgent())],
      ["POST", `${US}/v1/convai/secrets`, () => json(200, { secret_id: "sec_new" })],
      ["PATCH", `${US}/v1/convai/agents/agent_42`, () => json(200, {})],
      ["DELETE", `${US}/v1/convai/secrets/sec_old`, () => json(400, { detail: { message: "Secret is still referenced" } })],
    ]);

    expect(await provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: "rk" })).toMatchObject({ outcome: "repaired" });
  });

  it("deletes the new secret and keeps the old one when the patch fails", async () => {
    const { calls, provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, storedAgent())],
      ["POST", `${US}/v1/convai/secrets`, () => json(200, { secret_id: "sec_new" })],
      ["PATCH", `${US}/v1/convai/agents/agent_42`, () => empty(500)],
      ["DELETE", `${US}/v1/convai/secrets/sec_new`, () => empty(204)],
    ]);

    expect((await rejectionOf(provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: "rk" }))).reason).toBe("unreachable");
    const deletes = calls.filter((call) => call.method === "DELETE").map((call) => call.url);
    expect(deletes).toEqual([`${US}/v1/convai/secrets/sec_new`]);
  });

  it("creates a new agent when the named one is gone and a credential secret is given", async () => {
    const { calls, provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(404, { detail: { type: "not_found", code: "agent_not_found" } })],
      ["POST", `${US}/v1/convai/secrets`, () => json(200, { secret_id: "sec_new" })],
      ["POST", `${US}/v1/convai/agents/create`, () => json(200, { agent_id: "agent_new" })],
    ]);

    expect(await provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: "rk" }))
      .toEqual({ outcome: "created", vendorAgentId: "agent_new", primaryLocaleSupported: true });
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["is gone", () => json(404, { detail: { code: "agent_not_found" } })],
    ["holds no credential", () => json(200, storedAgent({ secretId: null }))],
  ])("asks for a credential secret when the named agent %s and none was given", async (_label, respond) => {
    const { calls, provisioner } = fakeElevenLabs([["GET", `${US}/v1/convai/agents/agent_42`, respond]]);

    expect(await provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: null })).toEqual({ outcome: "needs_bearer" });
    expect(calls).toHaveLength(1);
  });

  it("reads a key the vendor stopped accepting as rejected", async () => {
    const { provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } })],
    ]);

    expect((await rejectionOf(provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: null }))).reason).toBe("rejected");
  });

  it("refuses an agent answer that is not an agent", async () => {
    const { provisioner } = fakeElevenLabs([["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, { agent_id: "agent_42" })]]);

    expect((await rejectionOf(provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: "agent_42", bearer: null }))).reason).toBe("malformed_response");
  });

  it("times a write out on its own limit", async () => {
    const fetch = vi.fn<ProvisionerFetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const provisioner = createElevenLabsRuntimeProvisioner({ fetch, requestTimeoutMs: 20 });

    expect((await rejectionOf(provisioner.ensureAgent({ region: "us", credential, spec, vendorAgentId: null, bearer: "rk" }))).reason).toBe("timeout");
  });
});

describe("ElevenLabs runtime provisioner: a session's language", () => {
  const agentUrl = `${US}/v1/convai/agents/agent_42`;
  /**
   * The agent as stored: the language its calls start in, whether a session may set another, and
   * its voice model (`undefined` leaves the model out, as a document without one would).
   */
  const storedFor = (options: { language?: string; allowed?: boolean; ttsModelId?: unknown } = {}) => {
    const stored = storedAgent();
    const { language = "en", allowed = true } = options;
    const ttsModelId = "ttsModelId" in options ? options.ttsModelId : "eleven_flash_v2_5";
    return {
      ...stored,
      conversation_config: {
        ...stored.conversation_config,
        agent: { ...stored.conversation_config.agent, language },
        tts: ttsModelId === undefined ? { voice_id: "voice_1" } : { model_id: ttsModelId, voice_id: "voice_1" },
      },
      platform_settings: {
        overrides: { custom_llm_extra_body: true, conversation_config_override: { agent: { first_message: true, language: allowed } } },
      },
    };
  };
  const vendorWith = (stored: unknown) => fakeElevenLabs([["GET", agentUrl, () => json(200, stored)]]);
  const languageFor = (provisioner: ReturnType<typeof fakeElevenLabs>["provisioner"], locale: string) =>
    provisioner.languageFor({ region: "us", credential, vendorAgentId: "agent_42", locale });

  it("names the vendor's language for the session's locale when the agent lets a session set it, read with the key on the region's host", async () => {
    const { calls, provisioner } = fakeElevenLabs([["GET", `${EU}/v1/convai/agents/agent_42`, () => json(200, storedFor())]]);

    expect(await provisioner.languageFor({ region: "eu", credential, vendorAgentId: "agent_42", locale: "it-CH" })).toEqual({ outcome: "set", language: "it" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", headers: { "xi-api-key": credential.apiKey }, redirect: "error" });
  });

  it.each([
    ["pt-BR", "pt-br"],
    ["pt-PT", "pt"],
    ["zh-Hant-TW", "zh"],
    ["nb-NO", "no"],
    ["EN", "en"],
  ])("maps the session's locale %s onto the vendor's preset languages as %s", async (locale, language) => {
    expect(await languageFor(vendorWith(storedFor({ language: "de" })).provisioner, locale)).toEqual({ outcome: "set", language });
  });

  it.each([
    ["the vendor agent's own language", "de-AT", "de"],
    ["it, though the agent does not let a session set its language", "de", "de"],
    ["Filipino as tl, on an agent that starts in fil", "tl", "fil"],
    ["Filipino as fil, on an agent that starts in tl", "fil-PH", "tl"],
    ["bare Portuguese, on an agent that starts in Brazilian Portuguese", "pt", "pt-br"],
  ])("sets no language when the session speaks %s, which the vendor agent's calls start in already", async (_case, locale, language) => {
    const allowed = !_case.includes("does not let");
    expect(await languageFor(vendorWith(storedFor({ language, allowed })).provisioner, locale)).toEqual({ outcome: "default" });
  });

  it("follows the language the vendor agent starts in, whatever the Radioso agent's default locale says", async () => {
    // A default-locale sync that failed, or an edit in the vendor's dashboard, leaves the vendor agent
    // in another language than Radioso's default: the session's own language is set all the same.
    const { provisioner } = vendorWith(storedFor({ language: "en" }));

    expect(await languageFor(provisioner, "it")).toEqual({ outcome: "set", language: "it" });
  });

  it.each([
    ["European Portuguese on an agent in Brazilian Portuguese", "pt-PT", "pt-br", "pt"],
    ["Brazilian Portuguese on an agent in European Portuguese", "pt-BR", "pt", "pt-br"],
    ["bare Portuguese on an agent in English", "pt", "en", "pt"],
  ])("sets %s", async (_case, locale, language, set) => {
    expect(await languageFor(vendorWith(storedFor({ language })).provisioner, locale)).toEqual({ outcome: "set", language: set });
  });

  it.each(["fil", "fil-PH"])("sets Filipino (%s) as tl, the code the client's session override names for it", async (locale) => {
    expect(await languageFor(vendorWith(storedFor()).provisioner, locale)).toEqual({ outcome: "set", language: "tl" });
  });

  it.each(["ast", "yue", "mt", "mi", "my", "mn", "oc", "or", "tg", "uz", "yo", "am", "lo", "lg", "sn", "ckb", "wo", "zu"])(
    "sets no language for %s, a preset the client's session override does not name, unless the agent starts in it",
    async (locale) => {
      expect(await languageFor(vendorWith(storedFor()).provisioner, locale)).toEqual({ outcome: "unsupported" });
      expect(await languageFor(vendorWith(storedFor({ language: locale })).provisioner, locale)).toEqual({ outcome: "default" });
    },
  );

  it("publishes the codes a session may set, and sets no other", async () => {
    const set = new Set<string>();
    for (const preset of ELEVENLABS_PRESET_LANGUAGES) {
      const answer = await languageFor(vendorWith(storedFor({ language: "km" })).provisioner, preset);
      if (answer.outcome === "set") set.add(answer.language);
      else expect(answer, preset).toEqual({ outcome: "unsupported" });
    }

    expect([...set].sort()).toEqual([...ELEVENLABS_SESSION_LANGUAGES].sort());
    expect(ELEVENLABS_SESSION_LANGUAGES).toHaveLength(72);
    expect(ELEVENLABS_SESSION_LANGUAGES).toContain("tl");
    expect(ELEVENLABS_SESSION_LANGUAGES).not.toContain("fil");
  });

  it.each([
    ["the English-only eleven_flash_v2", "eleven_flash_v2"],
    ["the English-only eleven_turbo_v2", "eleven_turbo_v2"],
    ["the English-only eleven_monolingual_v1", "eleven_monolingual_v1"],
    ["a model the agent does not name", undefined],
    ["a model id that is not a string", 7],
    ["an empty model id", ""],
  ])("sets no language but English on an agent whose voice is %s", async (_case, ttsModelId) => {
    expect(await languageFor(vendorWith(storedFor({ language: "en", ttsModelId })).provisioner, "it")).toEqual({ outcome: "unsupported" });
    expect(await languageFor(vendorWith(storedFor({ language: "it", ttsModelId })).provisioner, "en")).toEqual({ outcome: "set", language: "en" });
  });

  it.each(["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"])("sets the session's language on an agent whose voice is the multilingual %s", async (ttsModelId) => {
    expect(await languageFor(vendorWith(storedFor({ ttsModelId })).provisioner, "it")).toEqual({ outcome: "set", language: "it" });
  });

  it("asks the vendor nothing for a locale it speaks no language of: the call starts in the agent's own language", async () => {
    const { calls, provisioner } = fakeElevenLabs([]);

    expect(await languageFor(provisioner, "km-KH")).toEqual({ outcome: "unsupported" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["turns it off", { allowed: false }],
    ["does not name it", { allowed: undefined }],
  ])("says the session may not set its language on an agent that %s, since the vendor closes a session that sets it anyway", async (_case, options) => {
    const stored = storedFor();
    const agentOverride = options.allowed === undefined ? { first_message: true } : { first_message: true, language: options.allowed };
    const served = { ...stored, platform_settings: { overrides: { conversation_config_override: { agent: agentOverride } } } };

    expect(await languageFor(vendorWith(served).provisioner, "it")).toEqual({ outcome: "not_allowed" });
  });

  it("says the same of an agent whose overrides the vendor serves without a section", async () => {
    expect(await languageFor(vendorWith({ ...storedFor(), platform_settings: {} }).provisioner, "it")).toEqual({ outcome: "not_allowed" });
  });

  it.each([
    ["the agent is gone", () => json(404, { detail: { status: "agent_not_found" } }), "refused", 404],
    ["the vendor cannot serve now", () => empty(503), "unreachable", 503],
    ["the answer is not an agent", () => json(200, { agent_id: "agent_42" }), "malformed_response", 200],
  ] as const)("rejects when %s", async (_case, respond, reason, vendorStatus) => {
    const { provisioner } = fakeElevenLabs([["GET", agentUrl, respond]]);

    const error = await rejectionOf(languageFor(provisioner, "it"));

    expect(error.reason).toBe(reason);
    expect(error.vendorStatus).toBe(vendorStatus);
  });

  it("stops reading the agent when the caller lets go", async () => {
    const seen: { signal?: AbortSignal } = {};
    const fetch = vi.fn<ProvisionerFetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      seen.signal = init.signal;
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const provisioner = createElevenLabsRuntimeProvisioner({ fetch });
    const caller = new AbortController();

    const reading = provisioner.languageFor({ region: "us", credential, vendorAgentId: "agent_42", locale: "it", signal: caller.signal });
    await vi.waitFor(() => expect(seen.signal).toBeDefined());
    caller.abort();

    await expect(reading).rejects.toBeInstanceOf(VoiceVendorRequestError);
    expect(seen.signal?.aborted).toBe(true);
  });
});

describe("ElevenLabs runtime provisioner: releasing the agent", () => {
  it("deletes the agent first and its credential secret after, which the vendor keeps while an agent references it", async () => {
    const { calls, provisioner } = fakeElevenLabs([
      ["GET", `${EU}/v1/convai/agents/agent_42`, () => json(200, storedAgent())],
      ["DELETE", `${EU}/v1/convai/agents/agent_42`, () => empty(204)],
      ["DELETE", `${EU}/v1/convai/secrets/sec_old`, () => empty(204)],
    ]);

    await provisioner.releaseAgent({ region: "eu", credential, vendorAgentId: "agent_42" });

    expect(calls.map((call) => `${call.method} ${call.url.replace(EU, "")}`)).toEqual([
      "GET /v1/convai/agents/agent_42",
      "DELETE /v1/convai/agents/agent_42",
      "DELETE /v1/convai/secrets/sec_old",
    ]);
  });

  it("counts an agent the vendor no longer holds as released", async () => {
    const { calls, provisioner } = fakeElevenLabs([["GET", `${US}/v1/convai/agents/agent_42`, () => json(404, { detail: { code: "agent_not_found" } })]]);

    await provisioner.releaseAgent({ region: "us", credential, vendorAgentId: "agent_42" });

    expect(calls).toHaveLength(1);
  });

  it("counts an agent deleted between the read and the delete as released", async () => {
    const { provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, storedAgent())],
      ["DELETE", `${US}/v1/convai/agents/agent_42`, () => json(404, { detail: { code: "agent_not_found" } })],
      ["DELETE", `${US}/v1/convai/secrets/sec_old`, () => empty(204)],
    ]);

    await expect(provisioner.releaseAgent({ region: "us", credential, vendorAgentId: "agent_42" })).resolves.toBeUndefined();
  });

  it("finishes when the secret will not go", async () => {
    const { provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, storedAgent())],
      ["DELETE", `${US}/v1/convai/agents/agent_42`, () => empty(204)],
      ["DELETE", `${US}/v1/convai/secrets/sec_old`, () => { throw new TypeError("fetch failed"); }],
    ]);

    await expect(provisioner.releaseAgent({ region: "us", credential, vendorAgentId: "agent_42" })).resolves.toBeUndefined();
  });

  it("rejects when the agent will not go", async () => {
    const { provisioner } = fakeElevenLabs([
      ["GET", `${US}/v1/convai/agents/agent_42`, () => json(200, storedAgent())],
      ["DELETE", `${US}/v1/convai/agents/agent_42`, () => empty(502)],
    ]);

    expect((await rejectionOf(provisioner.releaseAgent({ region: "us", credential, vendorAgentId: "agent_42" }))).reason).toBe("unreachable");
  });
});
