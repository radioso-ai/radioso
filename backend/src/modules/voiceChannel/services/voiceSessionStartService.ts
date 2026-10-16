import { VOICE_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { AgentVoiceSettings } from "../../agents/public.js";
import {
  VoiceVendorRequestError,
  type VoiceSessionStarter,
  type VoiceSessionStartPort,
  type VoiceSessionStartRegistry,
  type VoiceSessionStartResult,
  type VoiceSessionVisitor,
  type VoiceVendorCredentialReader,
  type VoiceVendorCredentialReading,
} from "../domain.js";
import { resolveVoiceTurnLocale } from "./voiceLines.js";

/** What a session start needs from the agent's settings. */
interface VoiceRuntimeProfileSource {
  /** Null when the agent no longer exists. */
  findVoiceProfile(agent: { workspaceId: string; agentId: string }): Promise<{
    voice: Pick<AgentVoiceSettings, "enabled" | "runtime">;
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
  /** Mints the key the voice runtime sends back on every turn of the session. */
  newSessionKey: () => string;
  now?: () => number;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger: Pick<AppLogger, "warn">;
}

const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

const vendorErrorFields = (error: unknown) => ({
  errorClass: errorClassOf(error),
  ...(error instanceof VoiceVendorRequestError ? { reason: error.reason } : {}),
  ...(error instanceof VoiceVendorRequestError && error.vendorStatus !== undefined ? { vendorStatus: error.vendorStatus } : {}),
});

const FAILED_OUTCOME_OF_READING: Record<Exclude<VoiceVendorCredentialReading["kind"], "present">, VoiceSessionFailedOutcome> = {
  missing: "credential_missing",
  unreadable: "credential_unreadable",
};

/**
 * Starts a voice session for an agent on the vendor agent it is bound to, with the workspace's
 * own vendor key. It mints the Radioso session key the page hands the vendor and records it with
 * the visitor who asked, before the vendor call, so the session's first turn joins that visitor
 * and a start that cannot be recorded spends nothing at the vendor. Every failure reads the same
 * to the caller; the outcome label and the warn log say which it was, with ids only: never the key
 * or the vendor's URL.
 */
export class VoiceSessionStartService implements VoiceSessionStartPort {
  constructor(private readonly dependencies: VoiceSessionStartServiceDependencies) {}

  async start(input: { workspaceId: string; agentId: string; visitor: VoiceSessionVisitor; locale?: string }): Promise<VoiceSessionStartResult> {
    const { workspaceId, agentId } = input;
    const profile = await this.dependencies.agents.findVoiceProfile({ workspaceId, agentId });
    if (!profile) return this.unavailable("agent_not_found");
    if (!profile.voice.enabled) return this.unavailable("voice_off");
    const runtime = profile.voice.runtime;
    if (!runtime) return this.unavailable("no_runtime");
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
      });
    } catch (error) {
      return failed("registration_failed", { errorClass: errorClassOf(error) });
    }

    try {
      const session = await this.dependencies.starters[vendor].startSession({ vendorAgentId: runtime.agentId, credential: reading.credential });
      this.record(vendor, "started");
      return {
        kind: "started",
        vendor,
        signedUrl: session.signedUrl,
        sessionKey,
        locale: resolveVoiceTurnLocale({ requested: input.locale, agentDefault: profile.defaultLocale }),
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      };
    } catch (error) {
      return failed("vendor_failed", vendorErrorFields(error));
    }
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
