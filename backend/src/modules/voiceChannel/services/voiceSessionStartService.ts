import { VOICE_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { AgentPublicationReader, AgentVoiceSettings } from "../../agents/public.js";
import {
  VoiceVendorRequestError,
  type VoiceCallReadiness,
  type VoiceCallReadinessGap,
  type VoiceGreetingSource,
  type VoiceReadinessSubject,
  type VoiceRuntimeConnectionStore,
  type VoiceSessionAvailabilityPort,
  type VoiceSessionLanguageSource,
  type VoiceSessionStarter,
  type VoiceSessionStartFor,
  type VoiceSessionStartPort,
  type VoiceSessionStartRegistry,
  type VoiceSessionStartResult,
  type VoiceSessionSurface,
  type VoiceVendorCredentialReader,
  type VoiceVendorCredentialReading,
  type VoiceVendorSession,
} from "../domain.js";
import {
  firstMessageOf,
  prepareSessionFirstMessage,
  type SessionFirstMessagePreparation,
  type SessionGreetingOutcome,
} from "./sessionFirstMessage.js";
import {
  languageToSet,
  prepareSessionLanguage,
  type SessionLanguageOutcome,
  type SessionLanguagePreparation,
} from "./sessionLanguage.js";
import { testChatSessionKey } from "../testChatSessionDomain.js";
import { readSessionMaintenance } from "./sessionPreparation.js";
import { chooseRecordingNotice, resolveVoiceLanguage } from "./voiceLines.js";

/** What a session start needs from the agent's settings. */
interface VoiceRuntimeProfileSource {
  /** Null when the agent no longer exists. */
  findVoiceProfile(agent: { workspaceId: string; agentId: string }): Promise<{
    voice: Pick<AgentVoiceSettings, "enabled" | "runtime" | "recordingNotice">;
    defaultLocale: string | null;
  } | null>;
}

type VoiceSessionUnavailableOutcome = "agent_not_found" | "not_published" | "voice_off" | "no_runtime";

type VoiceSessionFailedOutcome =
  | "credential_missing"
  | "credential_unreadable"
  | "credential_read_failed"
  | "registration_failed"
  | "vendor_failed";

type VoiceSessionStartOutcome = "started" | VoiceSessionUnavailableOutcome | VoiceSessionFailedOutcome;

interface VoiceSessionStartServiceDependencies {
  agents: VoiceRuntimeProfileSource;
  /** Whether the agent has a published release: every turn runs on it, so an agent with none takes no calls. */
  publication: AgentPublicationReader;
  credentials: VoiceVendorCredentialReader;
  starters: Readonly<Record<VoiceVendor, VoiceSessionStarter>>;
  starts: VoiceSessionStartRegistry;
  /** Whether Radioso maintains the bound vendor agent, which alone lets a session set its first message and language. */
  connections: Pick<VoiceRuntimeConnectionStore, "find">;
  /** The agent's greeting, which a call on a maintained vendor agent says first. */
  greetings: VoiceGreetingSource;
  /** Each vendor's answer for the language a session on a maintained vendor agent starts in. */
  sessionLanguages: Readonly<Record<VoiceVendor, VoiceSessionLanguageSource>>;
  /** How long a start waits for the greeting and for the language; `VOICE_BEHAVIOR.sessionPreparationWaitMs` unless a test names another. */
  preparationWaitMs?: number;
  /** Mints the key the voice runtime sends back on every turn of the session. */
  newSessionKey: () => string;
  now?: () => number;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger: Pick<AppLogger, "info" | "warn">;
}

const vendorErrorFields = (error: unknown) => ({
  errorClass: errorClassOf(error),
  ...(error instanceof VoiceVendorRequestError ? { reason: error.reason } : {}),
  ...(error instanceof VoiceVendorRequestError && error.vendorStatus !== undefined ? { vendorStatus: error.vendorStatus } : {}),
});

const READINESS_GAP_OF_OUTCOME = {
  not_published: "publication",
  voice_off: "voice_channel",
  no_runtime: "runtime",
} as const satisfies Record<string, VoiceCallReadinessGap>;
const READINESS_GAP_OF_PRESENCE = { missing: "vendor_key", unreadable: "encryption" } as const satisfies Record<string, VoiceCallReadinessGap>;

const FAILED_OUTCOME_OF_READING: Record<Exclude<VoiceVendorCredentialReading["kind"], "present">, VoiceSessionFailedOutcome> = {
  missing: "credential_missing",
  unreadable: "credential_unreadable",
};

/** Where a start comes from, for its count. */
const surfaceOf = (start: VoiceSessionStartFor): VoiceSessionSurface => (start.test ? "test_chat" : "website_embed");

/** Whom the registry records a started session for: the visitor, or the test, without its greeting. */
const startedFor = (start: VoiceSessionStartFor) =>
  start.test
    ? { test: { testExecutionId: start.test.testExecutionId, accountId: start.test.accountId } }
    : { visitor: start.visitor };

/**
 * The runtime an agent takes sessions on, or why it takes none, first reason first: an agent nobody
 * published, then voice off, then no vendor agent bound. Start and availability share it.
 */
const sessionRuntimeOf = <Runtime>(agent: { published: boolean; voice: { enabled: boolean; runtime: Runtime | null } }):
  | { kind: "bound"; runtime: Runtime }
  | { kind: "unavailable"; outcome: keyof typeof READINESS_GAP_OF_OUTCOME } => {
  if (!agent.published) return { kind: "unavailable", outcome: "not_published" };
  if (!agent.voice.enabled) return { kind: "unavailable", outcome: "voice_off" };
  return agent.voice.runtime ? { kind: "bound", runtime: agent.voice.runtime } : { kind: "unavailable", outcome: "no_runtime" };
};

/**
 * Starts a voice session for an agent on the vendor agent it is bound to, with the workspace's
 * own vendor key. It mints the Radioso session key the page hands the vendor and records it with
 * the visitor who asked, before the vendor call, so the session's first turn joins that visitor
 * and a start that cannot be recorded spends nothing at the vendor. Every failure reads the same
 * to the caller; the outcome label and the warn log say which it was, with ids only: never the key
 * or the vendor's URL.
 *
 * On a vendor agent Radioso maintains, the start also hands the page the call's first message: the
 * recording notice, then the agent's greeting in the session's language, read while the vendor
 * opens the session and waited for only so long. A greeting that is late or cannot be read leaves
 * the call to start without it; it never fails the start. Beside it, the start asks the vendor
 * agent whether the session may set its language, and hands the page the vendor's code for the
 * session's language when it may; an answer that is late or cannot be read leaves the call to
 * start in the vendor agent's own language.
 *
 * It also says whether a page should offer sessions at all, by the same gate a start passes plus
 * the key's presence. An agent that has never been published takes no sessions: its first turn
 * would be refused, so a start gives the page no URL for a call that could say nothing. A stored
 * key that cannot be decrypted still counts as present: the start then fails as
 * `credential_unreadable`, which the operator can see and fix.
 */
export class VoiceSessionStartService implements VoiceSessionStartPort, VoiceSessionAvailabilityPort {
  private readonly preparationWaitMs: number;

  constructor(private readonly dependencies: VoiceSessionStartServiceDependencies) {
    this.preparationWaitMs = dependencies.preparationWaitMs ?? VOICE_BEHAVIOR.sessionPreparationWaitMs;
  }

  async readiness(input: VoiceReadinessSubject): Promise<VoiceCallReadiness> {
    const published = await this.dependencies.publication.isPublished({ workspaceId: input.workspaceId, agentId: input.agentId });
    const binding = sessionRuntimeOf({ published, voice: input.voice });
    if (binding.kind === "unavailable") return { ready: false, missing: READINESS_GAP_OF_OUTCOME[binding.outcome] };
    const presence = await this.dependencies.credentials.presence({ workspaceId: input.workspaceId, vendor: binding.runtime.vendor });
    return presence === "stored" ? { ready: true, missing: null } : { ready: false, missing: READINESS_GAP_OF_PRESENCE[presence] };
  }

  async isAvailable(input: VoiceReadinessSubject): Promise<boolean> {
    try {
      return (await this.readiness(input)).ready;
    } catch (error) {
      // A page that cannot learn whether it may talk offers text alone; the start would fail the same way.
      const vendor = input.voice.runtime?.vendor ?? "none";
      this.dependencies.logger.warn({ workspaceId: input.workspaceId, vendor, errorClass: errorClassOf(error) }, "Voice availability check failed");
      return false;
    }
  }

  /**
   * A Test Chat start passes the same gate as a website one: its turns run the test's revision, but
   * the call is placed on the same vendor agent, with the same key, as the agent's published calls.
   */
  async start(input: { workspaceId: string; agentId: string; locale?: string } & VoiceSessionStartFor): Promise<VoiceSessionStartResult> {
    const { workspaceId, agentId } = input;
    const surface = surfaceOf(input);
    const [profile, published] = await Promise.all([
      this.dependencies.agents.findVoiceProfile({ workspaceId, agentId }),
      this.dependencies.publication.isPublished({ workspaceId, agentId }),
    ]);
    if (!profile) return this.unavailable(surface, "agent_not_found");
    const binding = sessionRuntimeOf({ published, voice: profile.voice });
    if (binding.kind === "unavailable") return this.unavailable(surface, binding.outcome);
    const { runtime } = binding;
    const { vendor } = runtime;
    const failed = (outcome: VoiceSessionFailedOutcome, fields: Record<string, unknown> = {}): VoiceSessionStartResult => {
      this.dependencies.logger.warn({ workspaceId, agentId, vendor, surface, outcome, ...fields }, "Voice session start failed");
      this.record(vendor, surface, outcome);
      return { kind: "failed" };
    };

    let reading: VoiceVendorCredentialReading;
    try {
      reading = await this.dependencies.credentials.read({ workspaceId, vendor });
    } catch (error) {
      return failed("credential_read_failed", { errorClass: errorClassOf(error) });
    }
    if (reading.kind !== "present") return failed(FAILED_OUTCOME_OF_READING[reading.kind]);

    // A Test Chat session's key has the form Radioso reserves, so its turns never run as a conversation.
    const sessionKey = input.test ? testChatSessionKey(this.dependencies.newSessionKey()) : this.dependencies.newSessionKey();
    const clock = this.dependencies.now ?? Date.now;
    try {
      await this.dependencies.starts.register({
        session: { workspaceId, agentId, vendor, sessionKey },
        ...startedFor(input),
        expiresAt: new Date(clock() + VOICE_BEHAVIOR.sessionStartTtlMs),
        vendorAgent: { agentId: runtime.agentId, region: runtime.region },
      });
    } catch (error) {
      return failed("registration_failed", { errorClass: errorClassOf(error) });
    }

    const locale = resolveVoiceLanguage({ session: input.locale, agentDefault: profile.defaultLocale }).tag;
    // Read while the vendor opens the session, the connection once for both; none of it rejects.
    // A start the vendor refuses stops the language read, which nothing will wait for.
    const preparation = new AbortController();
    const maintenance = readSessionMaintenance(this.dependencies.connections, { workspaceId, agentId, runtime });
    // A test opens with its own greeting, already read, rather than the published one.
    const testGreeting = input.test?.greeting ?? null;
    const greetings: VoiceGreetingSource = input.test ? { greetingFor: async () => testGreeting } : this.dependencies.greetings;
    const preparingFirstMessage = maintenance.then((known) => prepareSessionFirstMessage(
      { greetings, waitMs: this.preparationWaitMs, now: clock },
      { maintenance: known, workspaceId, agentId, locale: input.locale ?? null },
    ));
    const preparingLanguage = maintenance.then((known) => prepareSessionLanguage(
      { languages: this.dependencies.sessionLanguages[vendor], waitMs: this.preparationWaitMs, now: clock },
      { maintenance: known, runtime, credential: reading.credential, locale, signal: preparation.signal },
    ));
    let session: VoiceVendorSession;
    try {
      session = await this.dependencies.starters[vendor].startSession({
        vendorAgentId: runtime.agentId,
        region: runtime.region,
        credential: reading.credential,
      });
    } catch (error) {
      preparation.abort();
      return failed("vendor_failed", vendorErrorFields(error));
    }
    this.record(vendor, surface, "started");
    const recordingNotice = chooseRecordingNotice(profile.voice, { session: input.locale, agentDefault: profile.defaultLocale });
    const [firstMessagePreparation, languagePreparation] = await Promise.all([preparingFirstMessage, preparingLanguage]);
    this.observeGreeting({ workspaceId, agentId, vendor }, surface, firstMessagePreparation, recordingNotice !== null);
    this.observeLanguage({ workspaceId, agentId, vendor }, surface, languagePreparation);
    const firstMessage = firstMessageOf(firstMessagePreparation, recordingNotice);
    const vendorLanguage = languageToSet(languagePreparation);
    return {
      kind: "started",
      vendor,
      signedUrl: session.signedUrl,
      sessionKey,
      locale,
      ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      ...(recordingNotice ? { recordingNotice } : {}),
      ...(firstMessage ? { firstMessage } : {}),
      ...(vendorLanguage ? { vendorLanguage } : {}),
    };
  }

  /**
   * One log line and one count per started session on a vendor agent Radioso maintains, saying how
   * its language came out and how long the answer took: the vendor's code when the session sets
   * one, closed values otherwise, ids only. A vendor agent that does not allow the language is a
   * warn, since Connect fixes it.
   */
  private observeLanguage(
    session: { workspaceId: string; agentId: string; vendor: VoiceVendor },
    surface: VoiceSessionSurface,
    preparation: SessionLanguagePreparation,
  ): void {
    if (preparation.outcome === "skipped") return;
    const { logger } = this.dependencies;
    switch (preparation.outcome) {
      case "set":
        logger.info(
          { ...session, outcome: preparation.outcome, language: preparation.language, durationMs: preparation.durationMs },
          "Voice session language prepared",
        );
        break;
      case "default":
      case "unsupported":
        logger.info({ ...session, outcome: preparation.outcome, durationMs: preparation.durationMs }, "Voice session language prepared");
        break;
      case "not_allowed":
        logger.warn(
          { ...session, outcome: preparation.outcome, durationMs: preparation.durationMs },
          "Voice session language is not allowed on the vendor agent; the call starts in its default language until Reconnect sets it up",
        );
        break;
      case "timed_out":
        logger.warn(
          { ...session, outcome: preparation.outcome, waitMs: this.preparationWaitMs },
          "Voice session language was not ready in time; the call starts in the vendor agent's default language",
        );
        break;
      case "failed": {
        const { outcome, ...failure } = preparation;
        logger.warn({ ...session, outcome, ...failure }, "Voice session language could not be read; the call starts in the vendor agent's default language");
        break;
      }
    }
    this.recordLanguage(session.vendor, surface, preparation.outcome);
  }

  private recordLanguage(vendor: VoiceVendor, surface: VoiceSessionSurface, outcome: SessionLanguageOutcome): void {
    this.dependencies.metrics?.incrementCounter("voice_session_language_total", {
      help: "Started voice sessions on a vendor agent Radioso maintains, by how the language the call starts in came out",
      labels: { vendor, surface, outcome },
    });
  }

  /**
   * One log line and one count per started session on a vendor agent Radioso maintains, or whose
   * connection could not be read, saying how its greeting came out. Ids, closed values and timings
   * only: never the greeting or the notice.
   */
  private observeGreeting(
    session: { workspaceId: string; agentId: string; vendor: VoiceVendor },
    surface: VoiceSessionSurface,
    preparation: SessionFirstMessagePreparation,
    recordingNotice: boolean,
  ): void {
    if (preparation.kind === "unmaintained") return;
    const { logger } = this.dependencies;
    if (preparation.kind === "unknown") {
      logger.warn(
        { ...session, outcome: "failed", step: "connection", errorClass: preparation.errorClass },
        "Voice session greeting could not be read; the call starts without it",
      );
      this.recordGreeting(session.vendor, surface, "failed");
      return;
    }
    const { greeting, durationMs } = preparation;
    if (greeting.outcome === "timed_out") {
      logger.warn(
        { ...session, outcome: greeting.outcome, recordingNotice, waitMs: this.preparationWaitMs },
        "Voice session greeting was not ready in time; the call starts without it",
      );
    } else if (greeting.outcome === "failed") {
      logger.warn(
        { ...session, outcome: greeting.outcome, step: "greeting", errorClass: greeting.errorClass },
        "Voice session greeting could not be read; the call starts without it",
      );
    } else {
      logger.info({ ...session, outcome: greeting.outcome, recordingNotice, durationMs }, "Voice session greeting prepared");
    }
    this.recordGreeting(session.vendor, surface, greeting.outcome);
  }

  private recordGreeting(vendor: VoiceVendor, surface: VoiceSessionSurface, outcome: SessionGreetingOutcome): void {
    this.dependencies.metrics?.incrementCounter("voice_session_greeting_total", {
      help: "Started voice sessions on a vendor agent Radioso maintains, by how the greeting the call opens with came out",
      labels: { vendor, surface, outcome },
    });
  }

  private unavailable(surface: VoiceSessionSurface, outcome: VoiceSessionUnavailableOutcome): VoiceSessionStartResult {
    this.record("none", surface, outcome);
    return { kind: "unavailable" };
  }

  /** Labels are closed enums: the bound vendor, or `none` before one is known; the surface; the outcome. */
  private record(vendor: VoiceVendor | "none", surface: VoiceSessionSurface, outcome: VoiceSessionStartOutcome): void {
    this.dependencies.metrics?.incrementCounter("voice_session_start_total", {
      help: "Voice session starts, by the agent's bound vendor, where the start came from and how it ended",
      labels: { vendor, surface, outcome },
    });
  }
}
