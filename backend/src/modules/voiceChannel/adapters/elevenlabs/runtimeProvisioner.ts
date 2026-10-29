import { randomUUID } from "node:crypto";

import { VOICE_VENDOR_REGIONS, type VoiceVendorRegion } from "../../../../shared/domain/voiceVendor.js";
import {
  VoiceVendorRequestError,
  type VoiceRuntimeAgentEnsured,
  type VoiceRuntimeAgentSpec,
  type VoiceRuntimeProvisioner,
  type VoiceSessionLanguageSource,
  type VoiceVendorCredential,
} from "../../domain.js";
import { discardBody, isTimeout, readBoundedText } from "./fetchHelpers.js";
import { ELEVENLABS_API_HOST_OF_REGION } from "./hosts.js";

/**
 * The languages an ElevenLabs agent takes as a language preset, in the vendor's own words: the list
 * its validation names when a create carries any other (checked against the live API on
 * 2026-10-27). `pt-br` is the one regional variant; `pt` is the rest of Portuguese.
 */
export const ELEVENLABS_PRESET_LANGUAGES = [
  "en", "zh", "es", "hi", "pt", "fr", "de", "ja", "ar", "ko", "id", "it", "nl", "tr", "pl", "ru", "sv", "tl", "fil", "ms",
  "ro", "uk", "el", "cs", "da", "fi", "bg", "hr", "sk", "ta", "vi", "no", "hu", "af", "hy", "as", "ast", "az", "be", "bn",
  "bs", "ca", "yue", "et", "gl", "ka", "gu", "ha", "he", "is", "ga", "jv", "kn", "kk", "ky", "lv", "lt", "lb", "mk", "ml",
  "mt", "mi", "mr", "my", "mn", "ne", "oc", "or", "ps", "fa", "pa", "sr", "sd", "sl", "so", "sw", "tg", "te", "th", "ur",
  "uz", "yo", "cy", "am", "lo", "lg", "sn", "ckb", "wo", "zu", "pt-br",
] as const;

type ElevenLabsLanguage = (typeof ELEVENLABS_PRESET_LANGUAGES)[number];

const PRESET_LANGUAGES: ReadonlySet<string> = new Set(ELEVENLABS_PRESET_LANGUAGES);
/** Language subtags that name a language the vendor lists under another code. */
const LANGUAGE_ALIASES: Readonly<Record<string, ElevenLabsLanguage>> = { nb: "no", nn: "no" };
/** The language calls start in when the agent names none the vendor speaks, and the one every voice speaks. */
const ENGLISH: ElevenLabsLanguage = "en";

/**
 * Presets a session may not set as its language. The browser client's session override names a
 * shorter list (`ConversationConfigOverrideAgentLanguage` in `@elevenlabs/types`), and the vendor
 * closes a session (1008) that sets a language it does not take, which is worse than a call in the
 * agent's own language: a session in one of these sets none. `ELEVENLABS_SESSION_LANGUAGES` is the
 * rest, which the session start's contract publishes, so the embed's typecheck fails when the
 * client stops naming one of them.
 */
const SESSION_UNSETTABLE_LANGUAGES: ReadonlySet<string> = new Set<ElevenLabsLanguage>([
  "ast", "yue", "mt", "mi", "my", "mn", "oc", "or", "tg", "uz", "yo", "am", "lo", "lg", "sn", "ckb", "wo", "zu",
]);
/** Presets the session override names by another of the vendor's codes: Filipino is `tl` there. */
const SESSION_LANGUAGE_ALIASES: Readonly<Record<string, ElevenLabsLanguage | undefined>> = { fil: "tl" };

/** A vendor language as a session sets it: its own code, or the one the session override names it by. */
const sessionCodeOf = (language: string): string => SESSION_LANGUAGE_ALIASES[language] ?? language;

const isSessionSettable = (language: ElevenLabsLanguage): boolean =>
  !SESSION_UNSETTABLE_LANGUAGES.has(language) && sessionCodeOf(language) === language;

/** Every code a session may set as its language, in the preset table's order. */
export const ELEVENLABS_SESSION_LANGUAGES: readonly [ElevenLabsLanguage, ...ElevenLabsLanguage[]] = [
  ENGLISH,
  ...ELEVENLABS_PRESET_LANGUAGES.filter((language) => language !== ENGLISH && isSessionSettable(language)),
];

/**
 * The vendor's text-to-speech models that speak English alone; its `_v2_5`, multilingual and v3
 * models speak the other presets too. An agent whose voice is one of these speaks no other
 * language, so a session on it sets none but English.
 */
const ENGLISH_ONLY_TTS_MODELS: ReadonlySet<string> = new Set(["eleven_monolingual_v1", "eleven_turbo_v2", "eleven_flash_v2"]);

/** The language subtag of a tag or vendor code: the `pt` of `pt-br`. */
const baseLanguageOf = (tag: string): string => tag.split("-")[0] ?? tag;

/** Marks every agent Radioso created, so the vendor's own list can filter them. */
const MANAGED_TAG = "radioso-managed";
const NAME_PREFIX = "Radioso";
/** Far below what the vendor shows in its lists; a longer Radioso agent name is cut. */
const MAX_NAME_CHARS = 128;
/** The model name Radioso's completions endpoint answers for; it serves one. */
const CUSTOM_LLM_MODEL_ID = "radioso";

/**
 * ElevenLabs's Detect language system tool. Always on: Radioso calls it only on a turn that switches
 * the call's language, which the agent's own `languageSwitching` setting gates, so its presence alone
 * changes nothing.
 */
const LANGUAGE_DETECTION_TOOL = {
  type: "system",
  name: "language_detection",
  description: "",
  params: { system_tool_type: "language_detection" },
} as const;

/** No cascade to a vendor-hosted model: an answer that does not come from Radioso is not the agent's. */
const BACKUP_LLM_DISABLED = { preference: "disabled" } as const;

const PROBE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** An agent document carries its whole configuration; one far larger is not one. */
const MAX_AGENT_RESPONSE_BYTES = 512 * 1024;
/** Create answers and error envelopes are a few hundred bytes. */
const MAX_SMALL_RESPONSE_BYTES = 16 * 1024;

/** The vendor's codes for a key it accepts that may not do what was asked. */
const PERMISSION_CODES: ReadonlySet<string> = new Set(["missing_permissions", "insufficient_permissions"]);

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * The slice of `fetch` the provisioner uses. A redirect is an error: the key travels in a header,
 * and following a 3xx would send it on to wherever the redirect points.
 */
type ProvisionerFetch = (
  url: string,
  init: { method: Method; headers: Record<string, string>; body?: string; redirect: "error"; signal: AbortSignal },
) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const recordOr = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

/** The vendor's language for a Radioso locale: the whole tag when the vendor lists it, else its language; null when it lists neither. */
const listedLanguageOf = (locale: string): ElevenLabsLanguage | null => {
  const tag = locale.toLowerCase();
  const subtag = tag.split("-")[0] ?? "";
  const listed = [tag, subtag].find((candidate) => PRESET_LANGUAGES.has(candidate)) as ElevenLabsLanguage | undefined;
  return listed ?? LANGUAGE_ALIASES[subtag] ?? null;
};

/** The language calls on the agent start in: the vendor's for the agent's default locale, else English. */
const vendorLanguageOf = (locale: string | null): { language: ElevenLabsLanguage; supported: boolean } => {
  if (!locale) return { language: ENGLISH, supported: true };
  const language = listedLanguageOf(locale);
  return language ? { language, supported: true } : { language: ENGLISH, supported: false };
};

/** Every language a call may switch to: all the vendor offers, but the one calls start in. */
const languagePresetsWithout = (primary: ElevenLabsLanguage): JsonRecord =>
  Object.fromEntries(ELEVENLABS_PRESET_LANGUAGES.filter((language) => language !== primary).map((language) => [language, { overrides: {} }]));

const agentNameOf = (displayName: string): string => {
  const name = displayName.trim();
  return Array.from(name ? `${NAME_PREFIX} · ${name}` : NAME_PREFIX).slice(0, MAX_NAME_CHARS).join("");
};

/** The vendor's error code, from either envelope it answers with (`detail.code`, or the older `detail.status`). */
const errorCodeOf = (text: string | null): string | null => {
  if (!text) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const detail = isRecord(body) ? body.detail : undefined;
  if (!isRecord(detail)) return null;
  const code = typeof detail.code === "string" ? detail.code : detail.status;
  return typeof code === "string" ? code : null;
};

/**
 * Why the vendor answered with an error. A wrong key on another region's host answers `400`, so a
 * `400` naming an authentication error is a wrong key too; any other `4xx` refused the request.
 */
const vendorErrorOf = async (response: Response): Promise<VoiceVendorRequestError> => {
  const { status } = response;
  if (status === 429 || status >= 500) {
    await discardBody(response);
    return new VoiceVendorRequestError("unreachable", status);
  }
  const code = errorCodeOf(await readBoundedText(response, MAX_SMALL_RESPONSE_BYTES).catch(() => null));
  if (code && PERMISSION_CODES.has(code)) return new VoiceVendorRequestError("insufficient_permissions", status);
  if (status === 403) return new VoiceVendorRequestError("insufficient_permissions", status);
  if (status === 401 || code === "invalid_api_key" || code === "unauthorized") return new VoiceVendorRequestError("rejected", status);
  return new VoiceVendorRequestError("refused", status);
};

interface StoredAgent {
  tags: string[];
  conversationConfig: JsonRecord;
  agent: JsonRecord;
  prompt: JsonRecord;
  platformSettings: JsonRecord;
  /** The workspace secret the agent sends as its bearer, when it names one. */
  secretId: string | null;
}

/** The parts of an agent document Radioso rewrites, as the vendor served them; null when it is not an agent. */
const parseStoredAgent = (text: string | null): StoredAgent | null => {
  if (text === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(body) || !isRecord(body.conversation_config)) return null;
  const conversationConfig = body.conversation_config;
  if (!isRecord(conversationConfig.agent) || !isRecord(conversationConfig.agent.prompt)) return null;
  const { agent } = conversationConfig;
  const prompt = conversationConfig.agent.prompt;
  const apiKey = isRecord(prompt.custom_llm) ? prompt.custom_llm.api_key : undefined;
  const secretId = isRecord(apiKey) && typeof apiKey.secret_id === "string" && apiKey.secret_id.length > 0 ? apiKey.secret_id : null;
  return {
    tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : [],
    conversationConfig,
    agent,
    prompt,
    platformSettings: recordOr(body.platform_settings),
    secretId,
  };
};

/**
 * The overrides with every one Radioso owns allowed, and everything else as stored: the custom LLM
 * extra body, which carries each session's key, the agent's first message, which a session Radioso
 * starts sets to the agent's greeting, and the agent's language, which it sets to the session's.
 * Each nested section goes back whole, since the vendor refuses one given in part. A session that
 * sets an override its agent does not allow is closed by the vendor, so only an agent Radioso
 * maintains is sent one, and a language only once `sessionLanguageAllowed` reads it allowed.
 */
const ownedOverrides = (stored: JsonRecord): JsonRecord => {
  const configOverride = recordOr(stored.conversation_config_override);
  return {
    ...stored,
    custom_llm_extra_body: true,
    conversation_config_override: { ...configOverride, agent: { ...recordOr(configOverride.agent), first_message: true, language: true } },
  };
};

/**
 * Whether the agent as stored lets a session set its language. A vendor agent Radioso created
 * before it allowed that, or one whose overrides someone changed in the vendor's dashboard, does
 * not, until Connect or a default-locale sync sets it up again.
 */
const sessionLanguageAllowed = (stored: StoredAgent): boolean => {
  const configOverride = recordOr(recordOr(stored.platformSettings.overrides).conversation_config_override);
  return recordOr(configOverride.agent).language === true;
};

/**
 * Whether the agent's voice model is one known to speak more than English. A document that names no
 * model, or names it in a form this cannot read, counts as English only: a session on it sets no
 * other language rather than have an English voice read one.
 */
const speaksBeyondEnglish = (stored: StoredAgent): boolean => {
  const modelId = recordOr(stored.conversationConfig.tts).model_id;
  return typeof modelId === "string" && modelId.length > 0 && !ENGLISH_ONLY_TTS_MODELS.has(modelId);
};

/**
 * Whether the agent as stored starts calls in the session's language already: its own language,
 * named either way the vendor names it, or a regional variant of it when the session names the bare
 * language (a `pt` session on an agent in `pt-br`). A document that names no language counts as not.
 */
const startsIn = (stored: StoredAgent, session: { locale: string; language: string }): boolean => {
  const own = typeof stored.agent.language === "string" ? sessionCodeOf(stored.agent.language.toLowerCase()) : null;
  if (!own) return false;
  if (own === session.language) return true;
  const namesBareLanguage = !session.locale.includes("-");
  return namesBareLanguage && baseLanguageOf(own) === baseLanguageOf(session.language);
};

/**
 * The agent section with every field Radioso owns set, and everything else as stored. Radioso
 * writes the agent's instructions, its first words (none of its own: a session Radioso starts sets
 * them, else the caller speaks first) and the language calls start in, and points its LLM at Radioso.
 */
const ownedAgentSection = (stored: JsonRecord, prompt: JsonRecord, input: { spec: VoiceRuntimeAgentSpec; secretId: string; language: string }): JsonRecord => ({
  ...stored,
  first_message: "",
  language: input.language,
  prompt: {
    ...prompt,
    prompt: "",
    llm: "custom-llm",
    custom_llm: { url: input.spec.completionsBaseUrl, model_id: CUSTOM_LLM_MODEL_ID, api_key: { secret_id: input.secretId } },
    built_in_tools: { ...recordOr(prompt.built_in_tools), language_detection: LANGUAGE_DETECTION_TOOL },
    backup_llm_config: BACKUP_LLM_DISABLED,
  },
});

/** Each request's own limit, its answer body included. */
const withTimeout = (timeoutMs: number) => AbortSignal.timeout(timeoutMs);

/**
 * Creates and maintains the ElevenLabs Agents agent that speaks for a Radioso agent, with the
 * workspace's ElevenLabs key in `xi-api-key`, on the host of the key's data residency region.
 *
 * An agent update replaces a nested object it is given only in part with an error, and replaces a
 * top-level section it is given whole, so every update reads the agent and sends back each section
 * Radioso owns whole: `conversation_config.agent` (instructions, first message, language, the
 * custom LLM and its secret, the Detect language tool, no backup model), `language_presets` (every
 * language the vendor offers but the one calls start in, so a mid-call switch can reach any
 * language an answer is written in), `turn` (no speculative turns: each one would be a real
 * Radioso turn) and `platform_settings.overrides` (the custom LLM extra body that carries the
 * session key, and the first message and language a session sets). The REST credential's secret
 * lives in a workspace secret the agent references; a secret stays while an agent references it,
 * so a rotation points the agent at the new one first and a release deletes the agent first.
 *
 * It is also the `VoiceSessionLanguageSource`: it reads the agent, which the vendor serves with
 * its overrides and its voice, so a session sets its language only on an agent that allows it
 * today and can speak it.
 */
export const createElevenLabsRuntimeProvisioner = (dependencies: {
  fetch: ProvisionerFetch;
  /** A region probe's limit; tests only. */
  probeTimeoutMs?: number;
  /** Each management request's limit; tests only. */
  requestTimeoutMs?: number;
}): VoiceRuntimeProvisioner & VoiceSessionLanguageSource => {
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  /** One request; a request that never gets an answer rejects as unreachable or timeout. */
  const send = async (input: {
    method: Method;
    url: string;
    credential: VoiceVendorCredential;
    body?: JsonRecord;
    signal: AbortSignal;
  }): Promise<Response> => {
    try {
      return await dependencies.fetch(input.url, {
        method: input.method,
        headers: input.body === undefined
          ? { "xi-api-key": input.credential.apiKey }
          : { "xi-api-key": input.credential.apiKey, "content-type": "application/json" },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: "error",
        signal: input.signal,
      });
    } catch (error) {
      throw new VoiceVendorRequestError(isTimeout(error, input.signal) ? "timeout" : "unreachable");
    }
  };

  const readBody = async (response: Response, maxBytes: number, signal: AbortSignal): Promise<string | null> => {
    try {
      return await readBoundedText(response, maxBytes);
    } catch (error) {
      throw new VoiceVendorRequestError(isTimeout(error, signal) ? "timeout" : "unreachable", response.status);
    }
  };

  /** A request whose answer must be a JSON object naming `field` as a non-empty string. */
  const requestId = async (input: { method: Method; url: string; credential: VoiceVendorCredential; body: JsonRecord; field: string }): Promise<string> => {
    const signal = withTimeout(requestTimeoutMs);
    const response = await send({ ...input, signal });
    if (!response.ok) throw await vendorErrorOf(response);
    const text = await readBody(response, MAX_SMALL_RESPONSE_BYTES, signal);
    let body: unknown = null;
    try {
      body = text === null ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const id = isRecord(body) ? body[input.field] : undefined;
    if (typeof id !== "string" || id.length === 0) throw new VoiceVendorRequestError("malformed_response", response.status);
    return id;
  };

  /** A request whose answer is read only for its status. */
  const requestStatus = async (input: { method: Method; url: string; credential: VoiceVendorCredential; body?: JsonRecord }): Promise<void> => {
    const response = await send({ ...input, signal: withTimeout(requestTimeoutMs) });
    if (!response.ok) throw await vendorErrorOf(response);
    await discardBody(response);
  };

  const baseOf = (region: VoiceVendorRegion) => `https://${ELEVENLABS_API_HOST_OF_REGION[region]}/v1/convai`;

  const createSecret = (region: VoiceVendorRegion, credential: VoiceVendorCredential, bearer: string) =>
    requestId({
      method: "POST",
      url: `${baseOf(region)}/secrets`,
      credential,
      body: { type: "new", name: `radioso-${randomUUID()}`, value: bearer },
      field: "secret_id",
    });

  /** Best effort: a secret left behind holds a credential Radioso revokes anyway. */
  const deleteSecretQuietly = async (region: VoiceVendorRegion, credential: VoiceVendorCredential, secretId: string): Promise<void> => {
    await requestStatus({ method: "DELETE", url: `${baseOf(region)}/secrets/${encodeURIComponent(secretId)}`, credential }).catch(() => undefined);
  };

  /** The agent as stored; null when the vendor holds no agent by that id. `until` also ends the read when it aborts. */
  const readAgent = async (region: VoiceVendorRegion, credential: VoiceVendorCredential, vendorAgentId: string, until?: AbortSignal): Promise<StoredAgent | null> => {
    const signal = until ? AbortSignal.any([until, withTimeout(requestTimeoutMs)]) : withTimeout(requestTimeoutMs);
    const response = await send({ method: "GET", url: `${baseOf(region)}/agents/${encodeURIComponent(vendorAgentId)}`, credential, signal });
    if (response.status === 404) {
      await discardBody(response);
      return null;
    }
    if (!response.ok) throw await vendorErrorOf(response);
    const stored = parseStoredAgent(await readBody(response, MAX_AGENT_RESPONSE_BYTES, signal));
    if (!stored) throw new VoiceVendorRequestError("malformed_response", response.status);
    return stored;
  };

  /** A secret holding the bearer, then the agent; the secret goes again if the agent is not created. */
  const createAgent = async (input: { region: VoiceVendorRegion; credential: VoiceVendorCredential; spec: VoiceRuntimeAgentSpec; bearer: string }): Promise<VoiceRuntimeAgentEnsured> => {
    const { language, supported } = vendorLanguageOf(input.spec.primaryLocale);
    const secretId = await createSecret(input.region, input.credential, input.bearer);
    try {
      const vendorAgentId = await requestId({
        method: "POST",
        url: `${baseOf(input.region)}/agents/create`,
        credential: input.credential,
        field: "agent_id",
        body: {
          name: agentNameOf(input.spec.displayName),
          tags: [MANAGED_TAG],
          conversation_config: {
            agent: ownedAgentSection({}, {}, { spec: input.spec, secretId, language }),
            language_presets: languagePresetsWithout(language),
            turn: { speculative_turn: false },
          },
          platform_settings: { overrides: ownedOverrides({}) },
        },
      });
      return { outcome: "created", vendorAgentId, primaryLocaleSupported: supported };
    } catch (error) {
      await deleteSecretQuietly(input.region, input.credential, secretId);
      throw error;
    }
  };

  const patchAgent = (input: {
    region: VoiceVendorRegion;
    credential: VoiceVendorCredential;
    vendorAgentId: string;
    spec: VoiceRuntimeAgentSpec;
    stored: StoredAgent;
    secretId: string;
    language: ElevenLabsLanguage;
  }) => requestStatus({
    method: "PATCH",
    url: `${baseOf(input.region)}/agents/${encodeURIComponent(input.vendorAgentId)}`,
    credential: input.credential,
    body: {
      name: agentNameOf(input.spec.displayName),
      tags: input.stored.tags.includes(MANAGED_TAG) ? input.stored.tags : [...input.stored.tags, MANAGED_TAG],
      conversation_config: {
        agent: ownedAgentSection(input.stored.agent, input.stored.prompt, { spec: input.spec, secretId: input.secretId, language: input.language }),
        language_presets: languagePresetsWithout(input.language),
        turn: { ...recordOr(input.stored.conversationConfig.turn), speculative_turn: false },
      },
      platform_settings: { overrides: ownedOverrides(recordOr(input.stored.platformSettings.overrides)) },
    },
  });

  return {
    locateAccount: async ({ credential }) => {
      const probeTimeoutMs = dependencies.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
      // The key's account lives on exactly one region's host; every other host answers that it
      // does not know the key. So all four are asked at once, and the one that answers is the region.
      const answers = await Promise.all(VOICE_VENDOR_REGIONS.map(async (region): Promise<VoiceVendorRequestError | null> => {
        const signal = withTimeout(probeTimeoutMs);
        try {
          const response = await send({ method: "GET", url: `${baseOf(region)}/agents?page_size=1`, credential, signal });
          if (response.ok) {
            await discardBody(response);
            return null;
          }
          return await vendorErrorOf(response);
        } catch (error) {
          return error instanceof VoiceVendorRequestError ? error : new VoiceVendorRequestError("unreachable");
        }
      }));
      const accepted = answers.findIndex((answer) => answer === null);
      const region = VOICE_VENDOR_REGIONS[accepted];
      if (region) return { region };
      const failures = answers.filter((answer): answer is VoiceVendorRequestError => answer !== null);
      // A key that may not read agents is the operator's to fix in the vendor's dashboard; a host that
      // did not answer may be the key's own, so its silence is not a wrong key.
      const precedence = ["insufficient_permissions", "unreachable", "timeout"] as const;
      for (const reason of precedence) {
        const failure = failures.find((answer) => answer.reason === reason);
        if (failure) throw failure;
      }
      throw failures.find((answer) => answer.vendorStatus === 401) ?? new VoiceVendorRequestError("rejected", failures[0]?.vendorStatus);
    },

    ensureAgent: async (input) => {
      const { region, credential, spec } = input;
      if (input.vendorAgentId === null) return createAgent({ region, credential, spec, bearer: input.bearer });
      const { vendorAgentId, bearer } = input;
      const stored = await readAgent(region, credential, vendorAgentId);
      if (!stored) return bearer ? createAgent({ region, credential, spec, bearer }) : { outcome: "needs_bearer" };
      const { language, supported } = vendorLanguageOf(spec.primaryLocale);
      const repaired: VoiceRuntimeAgentEnsured = { outcome: "repaired", vendorAgentId, primaryLocaleSupported: supported };
      if (!bearer) {
        if (!stored.secretId) return { outcome: "needs_bearer" };
        await patchAgent({ region, credential, vendorAgentId, spec, stored, secretId: stored.secretId, language });
        return repaired;
      }
      const secretId = await createSecret(region, credential, bearer);
      try {
        await patchAgent({ region, credential, vendorAgentId, spec, stored, secretId, language });
      } catch (error) {
        await deleteSecretQuietly(region, credential, secretId);
        throw error;
      }
      if (stored.secretId && stored.secretId !== secretId) await deleteSecretQuietly(region, credential, stored.secretId);
      return repaired;
    },

    releaseAgent: async ({ region, credential, vendorAgentId }) => {
      const stored = await readAgent(region, credential, vendorAgentId);
      if (!stored) return;
      const response = await send({
        method: "DELETE",
        url: `${baseOf(region)}/agents/${encodeURIComponent(vendorAgentId)}`,
        credential,
        signal: withTimeout(requestTimeoutMs),
      });
      if (!response.ok && response.status !== 404) throw await vendorErrorOf(response);
      await discardBody(response);
      if (stored.secretId) await deleteSecretQuietly(region, credential, stored.secretId);
    },

    // Any language the vendor lists reads the agent: the language its calls start in, whether a
    // session may set another, and whether its voice can speak it all come from that document.
    languageFor: async ({ region, credential, vendorAgentId, locale, signal }) => {
      const listed = listedLanguageOf(locale);
      if (!listed) return { outcome: "unsupported" };
      const language = sessionCodeOf(listed);
      const stored = await readAgent(region, credential, vendorAgentId, signal);
      if (!stored) throw new VoiceVendorRequestError("refused", 404);
      if (startsIn(stored, { locale, language })) return { outcome: "default" };
      if (SESSION_UNSETTABLE_LANGUAGES.has(language)) return { outcome: "unsupported" };
      if (!sessionLanguageAllowed(stored)) return { outcome: "not_allowed" };
      return language === ENGLISH || speaksBeyondEnglish(stored) ? { outcome: "set", language } : { outcome: "unsupported" };
    },
  };
};
