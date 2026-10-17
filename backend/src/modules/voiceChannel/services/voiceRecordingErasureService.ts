import type { VendorHeldConversationDataErasure } from "../../../shared/domain/conversationDataErasure.js";
import type { VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import type {
  VoiceRecordingErasurePort,
  VoiceRecordingScope,
  VoiceRecordingToErase,
  VoiceVendorCredential,
} from "../domain.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import { recordingErrorFields, type VoiceRecordingDependencies } from "./voiceRecordingService.js";

/** At most this many vendor deletes run at once, so a large organization does not flood the vendor. */
const DELETE_CONCURRENCY = 4;
/**
 * How long one erasure keeps asking the vendor, all of its workspaces together. It runs inside the
 * deletion's request, which must finish; every recording left past it stays at the vendor and is
 * logged with where it is.
 */
const ERASURE_DEADLINE_MS = 20_000;

type VoiceRecordingDeleteOutcome =
  | "deleted"
  | "already_absent"
  | "vendor_failed"
  | "credential_missing"
  | "credential_unreadable"
  | "credential_read_failed"
  | "deadline_passed";

/** The workspace's key for one vendor, read at `prepare`, or why the vendor's recordings stay. */
type VendorCredential = { kind: "present"; credential: VoiceVendorCredential } | { kind: "absent"; outcome: VoiceRecordingDeleteOutcome };

/** One recording to delete, with the scope it came from and the key it is deleted with. */
interface ErasureItem {
  scope: VoiceRecordingScope;
  recording: VoiceRecordingToErase;
  credential: VendorCredential;
}

/**
 * Deletes recordings at the vendor when Radioso deletes their conversations, a visitor, a workspace
 * or an organization. `prepare` reads each scope's recordings and the workspace's vendor key, in order,
 * while both still exist (a workspace's deletion takes its key with it); `erase` asks the vendor to
 * delete each one after the deletion went through, all scopes in one queue under one concurrency
 * limit and one deadline, and never rejects, so a vendor that refuses or cannot be reached never
 * holds a deletion back. A recording left at the vendor is logged with its conversation and the
 * vendor's id for it, so an operator can delete it there; logs never carry a key.
 */
export class VoiceRecordingErasureService implements VoiceRecordingErasurePort {
  constructor(
    private readonly dependencies: VoiceRecordingDependencies,
    /** Tests only. */
    private readonly limits: { deadlineMs?: number; concurrency?: number } = {},
  ) {}

  async prepare(erasure: VendorHeldConversationDataErasure): Promise<{ erase(): Promise<void> }> {
    const items: ErasureItem[] = [];
    // A call can be in two scopes at once (a visitor's conversation, started by their key): once is enough.
    const seen = new Set<string>();
    for (const scope of erasure.scopes) {
      for (const item of await this.prepareScope(scope)) {
        const { vendor, region, vendorConversationId } = item.recording;
        const key = `${vendor}:${region}:${vendorConversationId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    }
    if (items.length === 0) return { erase: async () => undefined };
    return { erase: () => this.erase(erasure, items) };
  }

  private async prepareScope(scope: VoiceRecordingScope): Promise<ErasureItem[]> {
    let recordings: VoiceRecordingToErase[];
    try {
      recordings = await this.dependencies.recordings.listRecordings(scope);
    } catch (error) {
      this.dependencies.logger.warn(
        { workspaceId: scope.workspaceId, scope: scope.kind, errorClass: errorClassOf(error) },
        "Voice recordings to delete could not be read",
      );
      // An erasure of named conversations or a visitor fails whole rather than lose where their
      // recordings are; a workspace's deletion goes on without them.
      if (scope.kind !== "workspace") throw error;
      return [];
    }
    const items: ErasureItem[] = [];
    for (const vendor of new Set(recordings.map((recording) => recording.vendor))) {
      // One key read per vendor, while the workspace still holds it.
      const credential = await this.readCredential(scope.workspaceId, vendor);
      for (const recording of recordings) {
        if (recording.vendor === vendor) items.push({ scope, recording, credential });
      }
    }
    return items;
  }

  private async readCredential(workspaceId: string, vendor: VoiceVendor): Promise<VendorCredential> {
    try {
      const reading = await this.dependencies.credentials.read({ workspaceId, vendor });
      if (reading.kind === "present") return reading;
      return { kind: "absent", outcome: reading.kind === "missing" ? "credential_missing" : "credential_unreadable" };
    } catch {
      return { kind: "absent", outcome: "credential_read_failed" };
    }
  }

  /**
   * One deadline for the whole erasure: when it passes, the deletes still waiting on the vendor are
   * let go of and nothing more is asked, and every recording not deleted is left with its ids.
   */
  private async erase(erasure: VendorHeldConversationDataErasure, items: readonly ErasureItem[]): Promise<void> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.limits.deadlineMs ?? ERASURE_DEADLINE_MS);
    const queue = [...items];
    const worker = async (): Promise<void> => {
      while (!deadline.signal.aborted) {
        const item = queue.shift();
        if (!item) return;
        await this.eraseOne(erasure, item, deadline.signal);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.limits.concurrency ?? DELETE_CONCURRENCY, queue.length) }, worker));
    } finally {
      clearTimeout(timer);
    }
    for (const item of queue) this.left(item, "deadline_passed");
  }

  private async eraseOne(erasure: VendorHeldConversationDataErasure, item: ErasureItem, deadline: AbortSignal): Promise<void> {
    const { recording, credential } = item;
    if (credential.kind === "absent") {
      this.left(item, credential.outcome);
      return;
    }
    let outcome: "deleted" | "already_absent";
    try {
      outcome = await this.dependencies.sources[recording.vendor].deleteRecording({
        vendorConversationId: recording.vendorConversationId,
        region: recording.region,
        credential: credential.credential,
        signal: deadline,
      });
    } catch (error) {
      if (deadline.aborted) this.left(item, "deadline_passed");
      else this.left(item, "vendor_failed", recordingErrorFields(error));
      return;
    }
    this.record(recording.vendor, outcome);
    const { workspaceId, conversationId, vendor } = recording;
    await this.dependencies.audit
      .deleted({ account: erasure.account, workspaceId, workspaceDeleted: item.scope.kind === "workspace", conversationId, vendor, outcome })
      .catch((error: unknown) => {
        this.dependencies.logger.warn({ workspaceId, conversationId, vendor, errorClass: errorClassOf(error) }, "Voice recording deletion could not be audited");
      });
  }

  /** A recording that stays at the vendor, with where it is: its conversation and the vendor's id for it. */
  private left(item: ErasureItem, outcome: VoiceRecordingDeleteOutcome, fields: Record<string, unknown> = {}): void {
    const { workspaceId, conversationId, vendorConversationId, vendor } = item.recording;
    this.dependencies.logger.warn(
      { workspaceId, conversationId, vendorConversationId, vendor, outcome, ...fields },
      "Voice recording was left at the vendor",
    );
    this.record(vendor, outcome);
  }

  private record(vendor: VoiceVendor, outcome: VoiceRecordingDeleteOutcome): void {
    this.dependencies.metrics?.incrementCounter("voice_recording_delete_total", {
      help: "Voice recordings Radioso asked the vendor to delete, by vendor and how the request ended",
      labels: { vendor, outcome },
    });
  }
}
