import type { AuditEventInput } from "../audit/contracts/index.js";
import { badRequest, conflict, notFound } from "../../shared/domain/errors.js";
import { fieldProposalVersion } from "../../shared/domain/fieldProposalVersion.js";

/**
 * The days a conversation retention window may span. A week at least, so no window outruns a
 * conversation someone is still working through; ten years at most.
 */
export const CONVERSATION_RETENTION_DAYS_RANGE = { min: 7, max: 3650 } as const;

export interface PrivacySettings {
  /**
   * Days a conversation is kept after its last update or message, then erased with everything
   * derived from it. Null keeps every conversation until someone deletes it.
   */
  conversationRetentionDays: number | null;
}

export interface PrivacySettingsStore {
  read(workspaceId: string): Promise<{ accountId: string; settings: PrivacySettings } | null>;
  /** Writes `settings`, unless `expected` is given and the stored settings no longer equal it. */
  write(input: { workspaceId: string; settings: PrivacySettings; expected?: PrivacySettings }): Promise<
    | { status: "written"; accountId: string; previous: PrivacySettings }
    | { status: "changed" }
    | { status: "not_found" }
  >;
}

/** Who changed the settings: a signed-in teammate, or null for a workspace credential. */
interface PrivacySettingsActor {
  userId: string | null;
}

type PrivacySettingsProposalApplyOutcome =
  | { readonly status: "applied" }
  | { readonly status: "changed"; readonly fields: readonly string[] }
  | { readonly status: "target_deleted" };

const fields = ["conversationRetentionDays"] as const;

const assertValid = (settings: PrivacySettings): void => {
  const days = settings.conversationRetentionDays;
  const { min, max } = CONVERSATION_RETENTION_DAYS_RANGE;
  if (days !== null && (!Number.isInteger(days) || days < min || days > max)) {
    throw badRequest(`Conversation retention must be a whole number of days from ${min} to ${max}, or none to keep conversations until they are deleted`);
  }
};

/**
 * A workspace's privacy settings: how long it keeps conversations. The retention sweep reads the
 * same store and enforces what is set here. Writing one records a content-free audit event, since a
 * shorter window erases conversations nobody asked to erase one by one.
 */
export class PrivacySettingsService {
  constructor(private readonly deps: {
    store: PrivacySettingsStore;
    audit: { record(event: AuditEventInput): Promise<unknown> };
  }) {}

  async get(workspaceId: string): Promise<PrivacySettings> {
    return (await this.read(workspaceId)).settings;
  }

  async update(workspaceId: string, settings: PrivacySettings, actor: PrivacySettingsActor): Promise<PrivacySettings> {
    assertValid(settings);
    const written = await this.deps.store.write({ workspaceId, settings });
    if (written.status === "not_found") throw notFound("Workspace not found");
    if (written.status === "changed") throw conflict("The privacy settings changed while they were being saved");
    await this.record(workspaceId, written.accountId, written.previous, settings, { actorUserId: actor.userId });
    return settings;
  }

  /**
   * Ray's draft of a change: the named fields merged over the stored ones and validated, with the
   * stored values the apply compares against. Refuses a change that names nothing or restates what
   * is stored.
   */
  async prepareFieldProposal(workspaceId: string, patch: Partial<PrivacySettings>): Promise<{
    normalized: PrivacySettings;
    expected: PrivacySettings;
    current: PrivacySettings;
  }> {
    if (fields.every((field) => patch[field] === undefined)) throw badRequest("Name at least one privacy setting to change");
    const { settings: current } = await this.read(workspaceId);
    const normalized = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
    assertValid(normalized);
    if (fields.every((field) => normalized[field] === current[field])) throw badRequest("The privacy settings already hold these values");
    return { normalized, expected: current, current };
  }

  async readFieldProposalVersion(workspaceId: string): Promise<string> {
    const { settings } = await this.read(workspaceId);
    return fieldProposalVersion({ ...settings });
  }

  async readFieldProposalDisplay(workspaceId: string): Promise<PrivacySettings> {
    return (await this.read(workspaceId)).settings;
  }

  /** Applies a drafted change only while the stored settings still equal the ones it was drafted against. */
  async applyFieldProposal(
    workspaceId: string,
    prepared: { normalized: PrivacySettings; expected: PrivacySettings },
  ): Promise<PrivacySettingsProposalApplyOutcome> {
    assertValid(prepared.normalized);
    const written = await this.deps.store.write({ workspaceId, settings: prepared.normalized, expected: prepared.expected });
    if (written.status === "not_found") return { status: "target_deleted" };
    if (written.status === "changed") return { status: "changed", fields: [...fields] };
    await this.record(workspaceId, written.accountId, written.previous, prepared.normalized, { source: "copilot_proposal" });
    return { status: "applied" };
  }

  private async read(workspaceId: string): Promise<{ accountId: string; settings: PrivacySettings }> {
    const found = await this.deps.store.read(workspaceId);
    if (!found) throw notFound("Workspace not found");
    return found;
  }

  private async record(
    workspaceId: string,
    accountId: string,
    previous: PrivacySettings,
    next: PrivacySettings,
    attribution: Record<string, unknown>,
  ): Promise<void> {
    if (previous.conversationRetentionDays === next.conversationRetentionDays) return;
    await this.deps.audit.record({
      accountId,
      workspaceId,
      eventType: "workspace.privacy_settings.updated",
      eventStatus: "success",
      metadata: {
        ...attribution,
        conversationRetentionDays: { from: previous.conversationRetentionDays, to: next.conversationRetentionDays },
      },
    });
  }
}
