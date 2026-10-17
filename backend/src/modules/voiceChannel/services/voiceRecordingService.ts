import type { VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import {
  VoiceRecordingRequestError,
  type VoiceRecordingAvailabilityPort,
  type VoiceRecordingPlayback,
  type VoiceRecordingPlaybackPort,
  type VoiceRecordingRef,
  type VoiceRecordingSource,
  type VoiceRecordingStore,
  type VoiceVendorConversationReport,
  type VoiceVendorConversationReportPort,
  type VoiceVendorCredentialReader,
} from "../domain.js";

/**
 * The record a recording leaves: who played which conversation's recording, and which recording
 * was deleted at the vendor. Ids only, never audio. Composition writes them as audit events.
 */
export interface VoiceRecordingAudit {
  /** `partial`: the player asked for a byte range, as it does when it starts or seeks. */
  played(event: { workspaceId: string; conversationId: string; actorUserId: string | null; vendor: VoiceVendor; partial: boolean }): Promise<void>;
  /** `workspaceDeleted`: the workspace itself is gone, so the event cannot name it as its owner. */
  deleted(event: { workspaceId: string; workspaceDeleted: boolean; conversationId: string; vendor: VoiceVendor }): Promise<void>;
}

export interface VoiceRecordingDependencies {
  recordings: VoiceRecordingStore;
  credentials: VoiceVendorCredentialReader;
  sources: Readonly<Record<VoiceVendor, VoiceRecordingSource>>;
  audit: VoiceRecordingAudit;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger: Pick<AppLogger, "warn">;
}

type VoiceRecordingFetchOutcome =
  | "served"
  | "no_recording"
  | "store_failed"
  | "credential_missing"
  | "credential_unreadable"
  | "credential_read_failed"
  | "vendor_not_found"
  | "vendor_failed"
  | "audit_failed";

export const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** Why a vendor call failed, by reason and status only: the vendor's body never reaches a log. */
export const recordingErrorFields = (error: unknown) => ({
  ...(error instanceof VoiceRecordingRequestError
    ? { reason: error.reason, ...(error.vendorStatus === undefined ? {} : { vendorStatus: error.vendorStatus }) }
    : { errorClass: errorClassOf(error) }),
});

/**
 * Voice recordings as the operator meets them: the page reports the vendor's id for the call it
 * opened, the Inbox learns whether a conversation has a recording, and an operator plays it. The
 * recording stays with the vendor; a play streams it from there with the workspace's own key, and
 * every play that opens is audited before a byte reaches the listener. Failures read as one
 * `unavailable` to the caller; the outcome label and the warn log say which, with ids only.
 */
export class VoiceRecordingService implements VoiceVendorConversationReportPort, VoiceRecordingAvailabilityPort, VoiceRecordingPlaybackPort {
  constructor(private readonly dependencies: VoiceRecordingDependencies) {}

  async report(input: VoiceVendorConversationReport): Promise<"recorded" | "rejected"> {
    if (await this.dependencies.recordings.recordVendorConversation(input)) return "recorded";
    this.dependencies.logger.warn({ workspaceId: input.workspaceId, agentId: input.agentId }, "Voice vendor conversation report was refused");
    return "rejected";
  }

  async isAvailable(input: { workspaceId: string; conversationId: string }): Promise<boolean> {
    const recording = await this.dependencies.recordings.findRecording(input);
    if (!recording) return false;
    return (await this.dependencies.credentials.presence({ workspaceId: input.workspaceId, vendor: recording.vendor })) === "stored";
  }

  async play(input: {
    workspaceId: string;
    conversationId: string;
    actorUserId: string | null;
    range?: string;
    signal?: AbortSignal;
  }): Promise<VoiceRecordingPlayback> {
    const { workspaceId, conversationId } = input;
    let recording: VoiceRecordingRef | null;
    try {
      recording = await this.dependencies.recordings.findRecording({ workspaceId, conversationId });
    } catch (error) {
      return this.unavailable(input, "none", "store_failed", { errorClass: errorClassOf(error) });
    }
    if (!recording) {
      this.record("none", "no_recording");
      return { kind: "not_found" };
    }
    const { vendor } = recording;

    let reading;
    try {
      reading = await this.dependencies.credentials.read({ workspaceId, vendor });
    } catch (error) {
      return this.unavailable(input, vendor, "credential_read_failed", { errorClass: errorClassOf(error) });
    }
    if (reading.kind !== "present") {
      return this.unavailable(input, vendor, reading.kind === "missing" ? "credential_missing" : "credential_unreadable");
    }

    let stream;
    try {
      stream = await this.dependencies.sources[vendor].fetchRecording({
        vendorConversationId: recording.vendorConversationId,
        region: recording.region,
        credential: reading.credential,
        ...(input.range ? { range: input.range } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (error instanceof VoiceRecordingRequestError && error.reason === "not_found") {
        this.warn(input, vendor, "vendor_not_found", recordingErrorFields(error));
        this.record(vendor, "vendor_not_found");
        return { kind: "not_found" };
      }
      return this.unavailable(input, vendor, "vendor_failed", recordingErrorFields(error));
    }

    try {
      await this.dependencies.audit.played({ workspaceId, conversationId, actorUserId: input.actorUserId, vendor, partial: input.range !== undefined });
    } catch (error) {
      // A play that leaves no record does not happen.
      await stream.body.cancel().catch(() => undefined);
      return this.unavailable(input, vendor, "audit_failed", { errorClass: errorClassOf(error) });
    }
    this.record(vendor, "served");
    return { kind: "recording", recording: stream };
  }

  private unavailable(
    input: { workspaceId: string; conversationId: string },
    vendor: VoiceVendor | "none",
    outcome: VoiceRecordingFetchOutcome,
    fields: Record<string, unknown> = {},
  ): VoiceRecordingPlayback {
    this.warn(input, vendor, outcome, fields);
    this.record(vendor, outcome);
    return { kind: "unavailable" };
  }

  private warn(
    input: { workspaceId: string; conversationId: string },
    vendor: VoiceVendor | "none",
    outcome: VoiceRecordingFetchOutcome,
    fields: Record<string, unknown>,
  ): void {
    this.dependencies.logger.warn(
      { workspaceId: input.workspaceId, conversationId: input.conversationId, vendor, outcome, ...fields },
      "Voice recording could not be read",
    );
  }

  /** Labels are closed enums: the recording's vendor, or `none` before one is known. */
  private record(vendor: VoiceVendor | "none", outcome: VoiceRecordingFetchOutcome): void {
    this.dependencies.metrics?.incrementCounter("voice_recording_fetch_total", {
      help: "Voice recording plays, by the recording's vendor and how opening it ended",
      labels: { vendor, outcome },
    });
  }
}
