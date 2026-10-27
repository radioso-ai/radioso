import { VOICE_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { AgentVoiceSettings } from "../../agents/public.js";
import {
  VoiceVendorRequestError,
  type VoiceCallReadiness,
  type VoiceCallReadinessGap,
  type VoiceGreetingSource,
  type VoiceRuntimeConnectionStore,
  type VoiceSessionAvailabilityPort,
  type VoiceSessionStarter,
  type VoiceSessionStartPort,
  type VoiceSessionStartRegistry,
  type VoiceSessionStartResult,
  type VoiceSessionVisitor,
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
import { chooseRecordingNotice, resolveVoiceLanguage } from "./voiceLines.js";

/** What a session start needs from the agent's settings. */
interface VoiceRuntimeProfileSource {
  /** Null when the agent no longer exists. */
  findVoiceProfile(agent: { workspaceId: string; agentId: string }): Promise<{
    voice: Pick<AgentVoiceSettings, "enabled" | "runtime" | "recordingNotice">;
    defaultLocale: string | null;
  } | null>;
}

type VoiceSessionUnavailableOutcome = "agent_not_found" | "voice_off" | "no_runtime";

type VoiceSessionFailedOutcome =
  | "credential_missing"
  | "credential_unreadable"
  | "credential_read_failed"
  | "registration_failed"
  | "vendor_failed";

type VoiceSessionStartOutcome = "started" | VoiceSessionUnavailableOutcome | VoiceSessionFailedOutcome;

interface VoiceSessionStartServiceDependencies {
  agents: VoiceRuntimeProfileSource;
  credentials: VoiceVendorCredentialReader;
  starters: Readonly<Record<VoiceVendor, VoiceSessionStarter>>;
  starts: VoiceSessionStartRegistry;
  /** Whether Radioso maintains the bound vendor agent, which alone lets a session set its first message. */
  connections: Pick<VoiceRuntimeConnectionStore, "find">;
  /** The agent's greeting, which a call on a maintained vendor agent says first. */
  greetings: VoiceGreetingSource;
  /** How long a start waits for the greeting; `VOICE_BEHAVIOR.sessionGreetingWaitMs` unless a test names another. */
  greetingWaitMs?: number;
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

const READINESS_GAP_OF_OUTCOME = { voice_off: "voice_channel", no_runtime: "runtime" } as const satisfies Record<string, VoiceCallReadinessGap>;
const READINESS_GAP_OF_PRESENCE = { missing: "vendor_key", unreadable: "encryption" } as const satisfies Record<string, VoiceCallReadinessGap>;

const FAILED_OUTCOME_OF_READING: Record<Exclude<VoiceVendorCredentialReading["kind"], "present">, VoiceSessionFailedOutcome> = {
  missing: "credential_missing",
  unreadable: "credential_unreadable",
};

/** The runtime an agent takes sessions on, or why it takes none. Start and availability share it. */
const sessionRuntimeOf = <Runtime>(voice: { enabled: boolean; runtime: Runtime | null }):
  | { kind: "bound"; runtime: Runtime }
  | { kind: "unavailable"; outcome: "voice_off" | "no_runtime" } => {
  if (!voice.enabled) return { kind: "unavailable", outcome: "voice_off" };
  return voice.runtime ? { kind: "bound", runtime: voice.runtime } : { kind: "unavailable", outcome: "no_runtime" };
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
 * the call to start without it; it never fails the start.
 *
 * It also says whether a page should offer sessions at all, by the same gate a start passes plus
 * the key's presence. A stored key that cannot be decrypted still counts as present: the start
 * then fails as `credential_unreadable`, which the operator can see and fix.
 */
export class VoiceSessionStartService implements VoiceSessionStartPort, VoiceSessionAvailabilityPort {
  constructor(private readonly dependencies: VoiceSessionStartServiceDependencies) {}

  async readiness(input: { workspaceId: string; voice: Pick<AgentVoiceSettings, "enabled" | "runtime"> }): Promise<VoiceCallReadiness> {
    const binding = sessionRuntimeOf(input.voice);
    if (binding.kind === "unavailable") return { ready: false, missing: READINESS_GAP_OF_OUTCOME[binding.outcome] };
    const presence = await this.dependencies.credentials.presence({ workspaceId: input.workspaceId, vendor: binding.runtime.vendor });
    return presence === "stored" ? { ready: true, missing: null } : { ready: false, missing: READINESS_GAP_OF_PRESENCE[presence] };
  }

  async isAvailable(input: { workspaceId: string; voice: Pick<AgentVoiceSettings, "enabled" | "runtime"> }): Promise<boolean> {
    try {
      return (await this.readiness(input)).ready;
    } catch (error) {
      // A page that cannot learn whether it may talk offers text alone; the start would fail the same way.
      const vendor = input.voice.runtime?.vendor ?? "none";
      this.dependencies.logger.warn({ workspaceId: input.workspaceId, vendor, errorClass: errorClassOf(error) }, "Voice availability check failed");
      return false;
    }
  }

  async start(input: { workspaceId: string; agentId: string; visitor: VoiceSessionVisitor; locale?: string }): Promise<VoiceSessionStartResult> {
    const { workspaceId, agentId } = input;
    const profile = await this.dependencies.agents.findVoiceProfile({ workspaceId, agentId });
    if (!profile) return this.unavailable("agent_not_found");
    const binding = sessionRuntimeOf(profile.voice);
    if (binding.kind === "unavailable") return this.unavailable(binding.outcome);
    const { runtime } = binding;
    const { vendor } = runtime;
    const failed = (outcome: VoiceSessionFailedOutcome, fields: Record<string, unknown> = {}): VoiceSessionStartResult => {
      this.dependencies.logger.warn({ workspaceId, agentId, vendor, outcome, ...fields }, "Voice session start failed");
      this.record(vendor, outcome);
      return { kind: "failed" };
    };

    let reading: VoiceVendorCredentialReading;
    try {
      reading = await this.dependencies.credentials.read({ workspaceId, vendor });
    } catch (error) {
      return failed("credential_read_failed", { errorClass: errorClassOf(error) });
    }
    if (reading.kind !== "present") return failed(FAILED_OUTCOME_OF_READING[reading.kind]);

    const sessionKey = this.dependencies.newSessionKey();
    const now = (this.dependencies.now ?? Date.now)();
    try {
      await this.dependencies.starts.register({
        session: { workspaceId, agentId, vendor, sessionKey },
        visitor: input.visitor,
        expiresAt: new Date(now + VOICE_BEHAVIOR.sessionStartTtlMs),
        vendorAgent: { agentId: runtime.agentId, region: runtime.region },
      });
    } catch (error) {
      return failed("registration_failed", { errorClass: errorClassOf(error) });
    }

    // Read while the vendor opens the session; it never rejects.
    const preparing = prepareSessionFirstMessage(
      {
        connections: this.dependencies.connections,
        greetings: this.dependencies.greetings,
        waitMs: this.dependencies.greetingWaitMs ?? VOICE_BEHAVIOR.sessionGreetingWaitMs,
        now: this.dependencies.now ?? Date.now,
      },
      { workspaceId, agentId, runtime, locale: input.locale ?? null },
    );
    let session: VoiceVendorSession;
    try {
      session = await this.dependencies.starters[vendor].startSession({
        vendorAgentId: runtime.agentId,
        region: runtime.region,
        credential: reading.credential,
      });
    } catch (error) {
      return failed("vendor_failed", vendorErrorFields(error));
    }
    this.record(vendor, "started");
    const locale = resolveVoiceLanguage({ session: input.locale, agentDefault: profile.defaultLocale }).tag;
    const recordingNotice = chooseRecordingNotice(profile.voice, { session: input.locale, agentDefault: profile.defaultLocale });
    const preparation = await preparing;
    this.observeGreeting({ workspaceId, agentId, vendor }, preparation, recordingNotice !== null);
    const firstMessage = firstMessageOf(preparation, recordingNotice);
    return {
      kind: "started",
      vendor,
      signedUrl: session.signedUrl,
      sessionKey,
      locale,
      ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      ...(recordingNotice ? { recordingNotice } : {}),
      ...(firstMessage ? { firstMessage } : {}),
    };
  }

  /**
   * One log line and one count per started session on a vendor agent Radioso maintains, or whose
   * connection could not be read, saying how its greeting came out. Ids, closed values and timings
   * only: never the greeting or the notice.
   */
  private observeGreeting(
    session: { workspaceId: string; agentId: string; vendor: VoiceVendor },
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
      this.recordGreeting(session.vendor, "failed");
      return;
    }
    const { greeting, durationMs } = preparation;
    if (greeting.outcome === "timed_out") {
      const waitMs = this.dependencies.greetingWaitMs ?? VOICE_BEHAVIOR.sessionGreetingWaitMs;
      logger.warn({ ...session, outcome: greeting.outcome, recordingNotice, waitMs }, "Voice session greeting was not ready in time; the call starts without it");
    } else if (greeting.outcome === "failed") {
      logger.warn(
        { ...session, outcome: greeting.outcome, step: "greeting", errorClass: greeting.errorClass },
        "Voice session greeting could not be read; the call starts without it",
      );
    } else {
      logger.info({ ...session, outcome: greeting.outcome, recordingNotice, durationMs }, "Voice session greeting prepared");
    }
    this.recordGreeting(session.vendor, greeting.outcome);
  }

  private recordGreeting(vendor: VoiceVendor, outcome: SessionGreetingOutcome): void {
    this.dependencies.metrics?.incrementCounter("voice_session_greeting_total", {
      help: "Started voice sessions on a vendor agent Radioso maintains, by how the greeting the call opens with came out",
      labels: { vendor, outcome },
    });
  }

  private unavailable(outcome: VoiceSessionUnavailableOutcome): VoiceSessionStartResult {
    this.record("none", outcome);
    return { kind: "unavailable" };
  }

  /** Labels are closed enums: the bound vendor, or `none` before one is known. */
  private record(vendor: VoiceVendor | "none", outcome: VoiceSessionStartOutcome): void {
    this.dependencies.metrics?.incrementCounter("voice_session_start_total", {
      help: "Voice session starts, by the agent's bound vendor and how the start ended",
      labels: { vendor, outcome },
    });
  }
}
