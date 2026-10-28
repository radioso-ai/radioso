import { z } from "zod";
import { publicVoiceSessionStartSchema, publicVoiceVendorConversationSchema } from "../../routes/publicChatRouteSchemas.js";
import { agentVoiceSettingsInputSchema, agentVoiceSettingsSchema } from "../../../../modules/agents/public.js";
import { VOICE_CALL_READINESS_GAPS } from "../../../../modules/voiceChannel/public.js";
import { VOICE_VENDORS } from "../../../../shared/domain/voiceVendor.js";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

// Split into three register functions, rather than one, because `agentSchemas.ts` calls each at
// the exact point the voice schema used to be defined inline: the OpenAPI document lists
// `components.schemas` in registration order, so interleaving these with `AgentMechanicsReplies`
// (unrelated, registered between the settings pair and the readiness schema) and with the many
// non-voice schemas registered between the settings/readiness schemas and the public session
// schemas keeps the generated document byte-identical to before the extraction.

export const registerAgentVoiceSettingsSchemas = (registry: OpenAPIRegistry) => {
  const AgentVoiceSettingsSchema = registry.register(
    "AgentVoiceSettings",
    agentVoiceSettingsSchema.openapi({
      description:
        "How the agent sounds on the voice channel. `bridgeLines`, `fallbackLine` and the optional `recordingNotice` are keyed by language tag "
        + "(at most 10 each); each style holds at most 5 lines of 1 to 200 characters, and each notice is one line of 1 to 200 characters. "
        + "The website embed shows the `recordingNotice` for the session's language as a call starts. `runtime` binds the agent to one "

        + "vendor agent (the vendor's own agent id, 1 to 128 letters, digits, underscores and hyphens), which a voice "
        + "session start opens, in the data residency region of the vendor account (`region`, which picks the vendor host); "
        + "null binds none. `languageSwitching` lets the agent switch the call's language, and with it the runtime's voice "
        + "and transcription, when the caller changes language mid-call; off (absent) unless the operator turns it on, and "
        + "only on a runtime that offers the switch. An update replaces the block whole.",
    }),
  );

  const AgentVoiceSettingsUpdateSchema = registry.register(
    "AgentVoiceSettingsUpdate",
    agentVoiceSettingsInputSchema.openapi({
      description:
        "The `voice` block as an update sends it: `AgentVoiceSettings`, except that `runtime` may be left out, "
        + "which binds the agent to no vendor agent, and `runtime.region` may be left out for the vendor's default region, `us`. "
        + "`languageSwitching` may be left out, which turns it off. "
        + "A key either object does not name is refused. The update replaces the block whole.",
    }),
  );

  return { AgentVoiceSettingsSchema, AgentVoiceSettingsUpdateSchema };
};

export const registerVoiceCallReadinessSchema = (registry: OpenAPIRegistry) =>
  registry.register(
    "VoiceCallReadiness",
    z.object({
      ready: z.boolean(),
      missing: z.enum(VOICE_CALL_READINESS_GAPS).nullable(),
    }).openapi({
      description: "Whether the agent's voice is ready for calls, and when it is not, the first piece missing: the voice channel, the runtime binding, the workspace's vendor key, or the backend's master key to read it.",
    }),
  );

export const registerPublicVoiceSessionSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const PublicVoiceSessionRequestSchema = registry.register(
    "PublicVoiceSessionRequest",
    publicVoiceSessionStartSchema.openapi({
      description: "`locale` is the caller's language tag; without it the agent's default language applies, then `en`.",
    }),
  );

  const PublicVoiceSessionResponseSchema = registry.register(
    "PublicVoiceSessionResponse",
    z.object({
      vendor: z.enum(VOICE_VENDORS).openapi({ description: "The voice runtime the session opens on: the agent's `voice.runtime.vendor`." }),
      signedUrl: z.string().url().openapi({
        description: "The vendor's URL for opening a session on the agent's vendor agent. On `elevenlabs` it is valid for 15 minutes and is not limited to one session: "
          + "for that window anyone holding it can open sessions billed to the workspace's vendor account, so treat it as a bearer credential. "
          + "Hand it to the vendor's client once and never store, log or share it.",
      }),
      sessionKey: z.string().uuid().openapi({
        description: "Radioso's key for this session: a correlation handle, not a credential. The page hands it to the vendor, which sends it back on every turn "
          + "so the whole call is one conversation that joins the website visitor who started it; on `elevenlabs` it travels as the custom LLM extra body's `session_key`.",
      }),
      locale: z.string().openapi({ description: "The caller's language tag: the request's, else the agent's default language, else `en`. The page hands it to the vendor beside `sessionKey`." }),
      expiresAt: z.string().datetime().optional().openapi({
        description: "When `signedUrl` stops opening sessions: Radioso computes it from the validity the vendor documents (15 minutes on `elevenlabs`) and the time it asked for the URL.",
      }),
      recordingNotice: z.string().optional().openapi({
        description: "The agent's `voice.recordingNotice` in the session's language, when the agent wrote one for it: the page shows it to the caller as the call starts.",
      }),
      firstMessage: z.string().optional().openapi({
        description: "What the call says first: the recording notice, then the agent's greeting in the session's language, as plain speech. "
          + "Present only when the agent's vendor agent is one Radioso maintains (connected from the agent's Voice card) and there is something to say. "
          + "Pass it as the session's first-message override, on `elevenlabs` the client's `overrides.agent.firstMessage`, and send no override when it is absent: "
          + "a vendor agent set up outside Radioso closes a session that sets a first message it does not allow.",
      }),
      vendorLanguage: z.string().optional().openapi({
        description: "The vendor's code for the language the call starts in: `locale` mapped onto the languages the vendor speaks, such as `it` for `it-CH` or `pt-br` for `pt-BR`. "
          + "Present only when the agent's vendor agent is one Radioso maintains, that vendor agent lets a session set its language, and the vendor speaks `locale`'s language. "
          + "Pass it as the session's language override, on `elevenlabs` the client's `overrides.agent.language`, and send no override when it is absent: "
          + "the call then starts in the vendor agent's own language, and a vendor agent that does not allow the override closes a session that sets one.",
      }),
    }),
  );

  const PublicVoiceVendorConversationRequestSchema = registry.register(
    "PublicVoiceVendorConversationRequest",
    publicVoiceVendorConversationSchema.openapi({
      description: "The vendor's id for the call the page opened: on `elevenlabs`, what the client's `getId()` returns once the session is connected.",
    }),
  );

  Object.assign(schemas, {
    PublicVoiceSessionRequestSchema,
    PublicVoiceSessionResponseSchema,
    PublicVoiceVendorConversationRequestSchema,
  });
};
