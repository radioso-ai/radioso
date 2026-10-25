import { VOICE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";
import type { VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import {
  VoiceRecordingRequestError,
  type VoiceRecordingAvailabilityPort,
  type VoiceRecordingLeftReason,
  type VoiceRecordingPlayback,
  type VoiceRecordingPlaybackPort,
  type VoiceRecordingRef,
  type VoiceRecordingSource,
  type VoiceRecordingStore,
  type VoiceRecordingStream,
  type VoiceVendorConversationReport,
  type VoiceVendorConversationReportPort,
  type VoiceVendorCredentialReader,
} from "../domain.js";

/**
 * The record a recording leaves: who played which conversation's recording, and how its deletion at
 * the vendor ended. Ids and closed codes only, never audio. Composition writes them as audit events.
 */
export interface VoiceRecordingAudit {
  /** `partial`: the audio sent starts past the recording's first byte, as a seek asks for. */
  played(event: { workspaceId: string; conversationId: string; actorUserId: string | null; vendor: VoiceVendor; partial: boolean }): Promise<void>;
  /**
   * `workspaceDeleted` and `account.deleted`: the workspace or the organization is gone since, so
   * the event keeps its id without pointing at it. `already_absent`: the vendor held nothing to
   * delete.
   */
  deleted(event: {
    account: { id: string; deleted: boolean };
    workspaceId: string;
    workspaceDeleted: boolean;
    conversationId: string | null;
    vendor: VoiceVendor;
    outcome: "deleted" | "already_absent";
  }): Promise<void>;
  /**
   * A recording Radioso gave up on, which stays at the vendor: why, and the vendor's id for it, so
   * the organization can delete it there.
   */
  left(event: {
    account: { id: string; deleted: boolean };
    workspaceId: string;
    workspaceDeleted: boolean;
    conversationId: string | null;
    vendor: VoiceVendor;
    vendorConversationId: string;
    reason: VoiceRecordingLeftReason;
  }): Promise<void>;
}

interface VoiceRecordingDependencies {
  recordings: VoiceRecordingStore;
  credentials: VoiceVendorCredentialReader;
  sources: Readonly<Record<VoiceVendor, VoiceRecordingSource>>;
  audit: Pick<VoiceRecordingAudit, "played">;
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
  | "range_not_satisfiable"
  | "vendor_failed"
  | "audit_failed";

type VoiceVendorConversationReportOutcome =
  | "recorded"
  | "no_session"
  | "vendor_not_found"
  | "vendor_agent_mismatch"
  | "already_reported"
  | "store_failed"
  | "credential_missing"
  | "credential_unreadable"
  | "credential_read_failed"
  | "vendor_failed";

/** What the page learns: refusals are final, and a report that could not be checked may be sent again. */
const REPORT_RESULT_OF_OUTCOME: Record<VoiceVendorConversationReportOutcome, "recorded" | "rejected" | "failed"> = {
  recorded: "recorded",
  no_session: "rejected",
  // Right after a call connects the vendor may not show it yet; the page's re-send at the call's end can succeed.
  vendor_not_found: "failed",
  vendor_agent_mismatch: "rejected",
  already_reported: "rejected",
  store_failed: "failed",
  credential_missing: "failed",
  credential_unreadable: "failed",
  credential_read_failed: "failed",
  vendor_failed: "failed",
};

/** A first byte past 0, as a seek or a resumed play asks for. Header syntax only. */
const FIRST_BYTE_OF_RANGE = /^bytes (\d+)-/;

/** Whether the audio sent is part of the recording other than its start: what `partial` on a play means. */
const isPartialPlay = (stream: VoiceRecordingStream): boolean => {
  if (stream.status !== 206 || !stream.contentRange) return false;
  const first = FIRST_BYTE_OF_RANGE.exec(stream.contentRange)?.[1];
  return first !== undefined && Number(first) > 0;
};

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

  /**
   * Stores the id only once the vendor says the conversation is a call on the vendor agent the
   * session was started on, so a visitor cannot attach another call of the same vendor account. One
   * vendor call per report, and none for a report no started session waits for.
   */
  async report(input: VoiceVendorConversationReport): Promise<"recorded" | "rejected" | "failed"> {
    const { vendorConversationId, ...sessionOfReport } = input;
    let session;
    try {
      session = await this.dependencies.recordings.findReportableSession(sessionOfReport);
    } catch (error) {
      return this.reportEnded(input, "none", "store_failed", { errorClass: errorClassOf(error) });
    }
    if (!session) return this.reportEnded(input, "none", "no_session");
    const { vendor, vendorAgent } = session;

    let reading;
    try {
      reading = await this.dependencies.credentials.read({ workspaceId: input.workspaceId, vendor });
    } catch (error) {
      return this.reportEnded(input, vendor, "credential_read_failed", { errorClass: errorClassOf(error) });
    }
    if (reading.kind !== "present") {
      return this.reportEnded(input, vendor, reading.kind === "missing" ? "credential_missing" : "credential_unreadable");
    }

    let held;
    try {
      held = await this.dependencies.sources[vendor].describeConversation({ vendorConversationId, region: vendorAgent.region, credential: reading.credential });
    } catch (error) {
      const notFound = error instanceof VoiceRecordingRequestError && error.reason === "not_found";
      return this.reportEnded(input, vendor, notFound ? "vendor_not_found" : "vendor_failed", recordingErrorFields(error));
    }
    if (held.vendorAgentId !== vendorAgent.agentId) return this.reportEnded(input, vendor, "vendor_agent_mismatch");

    let recorded: boolean;
    try {
      recorded = await this.dependencies.recordings.recordVendorConversation(input);
    } catch (error) {
      return this.reportEnded(input, vendor, "store_failed", { errorClass: errorClassOf(error) });
    }
    return this.reportEnded(input, vendor, recorded ? "recorded" : "already_reported");
  }

  async availability(input: { workspaceId: string; conversationId: string; sourceChannel: string | null }): Promise<boolean | null> {
    if (input.sourceChannel !== VOICE_SOURCE_CHANNEL) return null;
    const { workspaceId, conversationId } = input;
    try {
      const recording = await this.dependencies.recordings.findRecording({ workspaceId, conversationId });
      if (!recording) return false;
      return (await this.dependencies.credentials.presence({ workspaceId, vendor: recording.vendor })) === "stored";
    } catch (error) {
      this.dependencies.logger.warn({ workspaceId, conversationId, errorClass: errorClassOf(error) }, "Voice recording availability could not be read");
      return null;
    }
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
      // A listener who closed the player or seeked away is nobody's failure, and nobody is left to answer.
      if (input.signal?.aborted || (error instanceof VoiceRecordingRequestError && error.reason === "abandoned")) return { kind: "abandoned" };
      if (error instanceof VoiceRecordingRequestError && error.reason === "not_found") {
        this.warn(input, vendor, "vendor_not_found", recordingErrorFields(error));
        this.record(vendor, "vendor_not_found");
        return { kind: "not_found" };
      }
      if (error instanceof VoiceRecordingRequestError && error.reason === "range_not_satisfiable") {
        this.record(vendor, "range_not_satisfiable");
        return { kind: "range_not_satisfiable", ...(error.contentRange ? { contentRange: error.contentRange } : {}) };
      }
      return this.unavailable(input, vendor, "vendor_failed", recordingErrorFields(error));
    }

    try {
      await this.dependencies.audit.played({ workspaceId, conversationId, actorUserId: input.actorUserId, vendor, partial: isPartialPlay(stream) });
    } catch (error) {
      // A play that leaves no record does not happen.
      await stream.body.cancel().catch(() => undefined);
      return this.unavailable(input, vendor, "audit_failed", { errorClass: errorClassOf(error) });
    }
    this.record(vendor, "served");
    return { kind: "recording", recording: stream };
  }

  /** Logs and counts how a report ended, with ids only: never the reported id or the vendor's agent. */
  private reportEnded(
    input: VoiceVendorConversationReport,
    vendor: VoiceVendor | "none",
    outcome: VoiceVendorConversationReportOutcome,
    fields: Record<string, unknown> = {},
  ): "recorded" | "rejected" | "failed" {
    this.dependencies.metrics?.incrementCounter("voice_vendor_conversation_report_total", {
      help: "Vendor conversation ids pages reported for voice sessions, by vendor and how the report ended",
      labels: { vendor, outcome },
    });
    const result = REPORT_RESULT_OF_OUTCOME[outcome];
    if (result !== "recorded") {
      this.dependencies.logger.warn(
        { workspaceId: input.workspaceId, agentId: input.agentId, vendor, outcome, ...fields },
        result === "rejected" ? "Voice vendor conversation report was refused" : "Voice vendor conversation report could not be checked",
      );
    }
    return result;
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
