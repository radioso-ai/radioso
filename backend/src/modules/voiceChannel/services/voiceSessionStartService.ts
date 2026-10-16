import type { VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { AgentVoiceSettings } from "../../agents/public.js";
import {
  VoiceVendorRequestError,
  type VoiceSessionStarter,
  type VoiceSessionStartPort,
  type VoiceSessionStartResult,
  type VoiceVendorCredential,
  type VoiceVendorCredentialReader,
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

type VoiceSessionStartOutcome =
  | "started"
  | "agent_not_found"
  | "voice_off"
  | "no_runtime"
  | "credential_missing"
  | "credential_unreadable"
  | "vendor_failed";

interface VoiceSessionStartServiceDependencies {
  agents: VoiceRuntimeProfileSource;
  credentials: VoiceVendorCredentialReader;
  starters: Readonly<Record<VoiceVendor, VoiceSessionStarter>>;
  /** Mints the key the voice runtime sends back on every turn of the session. */
  newSessionKey: () => string;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger: Pick<AppLogger, "warn">;
}

const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/**
 * Starts a voice session for an agent on the vendor agent it is bound to, with the workspace's
 * own vendor key, and mints the Radioso session key the page hands the vendor. The key and the
 * vendor's URL stay out of logs and metrics; the URL reaches only the caller of the port.
 */
export class VoiceSessionStartService implements VoiceSessionStartPort {
  constructor(private readonly dependencies: VoiceSessionStartServiceDependencies) {}

  async start(input: { workspaceId: string; agentId: string; locale?: string }): Promise<VoiceSessionStartResult> {
    const { workspaceId, agentId } = input;
    const profile = await this.dependencies.agents.findVoiceProfile({ workspaceId, agentId });
    if (!profile) return this.unavailable("agent_not_found");
    if (!profile.voice.enabled) return this.unavailable("voice_off");
    const runtime = profile.voice.runtime;
    if (!runtime) return this.unavailable("no_runtime");
    const { vendor } = runtime;

    let credential: VoiceVendorCredential | null;
    try {
      credential = await this.dependencies.credentials.read({ workspaceId, vendor });
    } catch (error) {
      this.dependencies.logger.warn(
        { workspaceId, agentId, vendor, errorClass: errorClassOf(error) },
        "Voice session start could not read the vendor credential",
      );
      return this.ended({ kind: "credential_unreadable", vendor });
    }
    if (!credential) return this.ended({ kind: "credential_missing", vendor });

    try {
      const session = await this.dependencies.starters[vendor].startSession({ vendorAgentId: runtime.agentId, credential });
      return this.ended({
        kind: "started",
        vendor,
        signedUrl: session.signedUrl,
        sessionKey: this.dependencies.newSessionKey(),
        locale: resolveVoiceTurnLocale({ requested: input.locale, agentDefault: profile.defaultLocale }),
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      });
    } catch (error) {
      this.dependencies.logger.warn(
        {
          workspaceId,
          agentId,
          vendor,
          errorClass: errorClassOf(error),
          ...(error instanceof VoiceVendorRequestError ? { reason: error.reason } : {}),
          ...(error instanceof VoiceVendorRequestError && error.vendorStatus !== undefined ? { vendorStatus: error.vendorStatus } : {}),
        },
        "Voice vendor refused the session start",
      );
      return this.ended({ kind: "vendor_failed", vendor });
    }
  }

  private unavailable(outcome: Extract<VoiceSessionStartOutcome, "agent_not_found" | "voice_off" | "no_runtime">): VoiceSessionStartResult {
    this.record("none", outcome);
    return { kind: "unavailable" };
  }

  private ended(result: Exclude<VoiceSessionStartResult, { kind: "unavailable" }>): VoiceSessionStartResult {
    this.record(result.vendor, result.kind);
    return result;
  }

  /** Labels are closed enums: the bound vendor, or `none` before one is known. */
  private record(vendor: VoiceVendor | "none", outcome: VoiceSessionStartOutcome): void {
    this.dependencies.metrics?.incrementCounter("voice_session_start_total", {
      help: "Voice session starts, by the agent's bound vendor and how the start ended",
      labels: { vendor, outcome },
    });
  }
}
