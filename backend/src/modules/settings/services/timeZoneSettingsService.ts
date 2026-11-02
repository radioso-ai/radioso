import type { AuditEventInput } from "../../audit/contracts/index.js";
import { badRequest, conflict, notFound } from "../../../shared/domain/errors.js";
import { fieldProposalVersion } from "../../../shared/domain/fieldProposalVersion.js";
import { chosenTimeZoneName } from "../../../shared/domain/referenceTimeZone.js";

export interface TimeZoneSettings {
  /**
   * The IANA zone the workspace reads "today" in, for a turn whose visitor's client reports no
   * zone of its own. Null reads today in UTC.
   */
  timeZone: string | null;
}

export interface TimeZoneSettingsStore {
  read(workspaceId: string): Promise<{ accountId: string; settings: TimeZoneSettings } | null>;
  /** Writes `settings`, unless `expected` is given and the stored settings no longer equal it. */
  write(input: { workspaceId: string; settings: TimeZoneSettings; expected?: TimeZoneSettings }): Promise<
    | { status: "written"; accountId: string; previous: TimeZoneSettings }
    | { status: "changed" }
    | { status: "not_found" }
  >;
}

/** Who changed the zone: a signed-in teammate, or null for a workspace credential. */
interface TimeZoneSettingsActor {
  userId: string | null;
}

type TimeZoneSettingsProposalApplyOutcome =
  | { readonly status: "applied" }
  | { readonly status: "changed"; readonly fields: readonly string[] }
  | { readonly status: "target_deleted" };

const fields = ["timeZone"] as const;

/** The stored form: the IANA name the operator chose, in its IANA case, or null. Refuses anything `Intl` does not know. */
const normalize = (settings: TimeZoneSettings): TimeZoneSettings => {
  if (settings.timeZone === null) return { timeZone: null };
  const timeZone = chosenTimeZoneName(settings.timeZone);
  if (!timeZone) throw badRequest("timeZone must be an IANA time zone name, such as Europe/Rome, or null to read today in UTC");
  return { timeZone };
};

/**
 * A workspace's time zone: the zone "today", "tomorrow" and "this weekend" resolve in for a turn
 * whose visitor's client reports none. Writing one records a content-free audit event naming the
 * zones it moved between.
 */
export class TimeZoneSettingsService {
  constructor(private readonly deps: {
    store: TimeZoneSettingsStore;
    audit: { record(event: AuditEventInput): Promise<unknown> };
  }) {}

  async get(workspaceId: string): Promise<TimeZoneSettings> {
    return (await this.read(workspaceId)).settings;
  }

  async update(workspaceId: string, settings: TimeZoneSettings, actor: TimeZoneSettingsActor): Promise<TimeZoneSettings> {
    const normalized = normalize(settings);
    const written = await this.deps.store.write({ workspaceId, settings: normalized });
    if (written.status === "not_found") throw notFound("Workspace not found");
    if (written.status === "changed") throw conflict("The time zone changed while it was being saved");
    await this.record(workspaceId, written.accountId, written.previous, normalized, { actorUserId: actor.userId });
    return normalized;
  }

  /**
   * Ray's draft of a change: the named zone validated, with the stored zone the apply compares
   * against. Refuses a change that names nothing or restates what is stored.
   */
  async prepareFieldProposal(workspaceId: string, patch: Partial<TimeZoneSettings>): Promise<{
    normalized: TimeZoneSettings;
    expected: TimeZoneSettings;
    current: TimeZoneSettings;
  }> {
    if (patch.timeZone === undefined) throw badRequest("Name the time zone to change to, or null to read today in UTC");
    const { settings: current } = await this.read(workspaceId);
    const normalized = normalize({ timeZone: patch.timeZone });
    if (normalized.timeZone === current.timeZone) throw badRequest("The workspace already reads today in this time zone");
    return { normalized, expected: current, current };
  }

  async readFieldProposalVersion(workspaceId: string): Promise<string> {
    const { settings } = await this.read(workspaceId);
    return fieldProposalVersion({ ...settings });
  }

  async readFieldProposalDisplay(workspaceId: string): Promise<TimeZoneSettings> {
    return (await this.read(workspaceId)).settings;
  }

  /** Applies a drafted change only while the stored zone still equals the one it was drafted against. */
  async applyFieldProposal(
    workspaceId: string,
    prepared: { normalized: TimeZoneSettings; expected: TimeZoneSettings },
  ): Promise<TimeZoneSettingsProposalApplyOutcome> {
    const normalized = normalize(prepared.normalized);
    const written = await this.deps.store.write({ workspaceId, settings: normalized, expected: prepared.expected });
    if (written.status === "not_found") return { status: "target_deleted" };
    if (written.status === "changed") return { status: "changed", fields: [...fields] };
    await this.record(workspaceId, written.accountId, written.previous, normalized, { source: "copilot_proposal" });
    return { status: "applied" };
  }

  private async read(workspaceId: string): Promise<{ accountId: string; settings: TimeZoneSettings }> {
    const found = await this.deps.store.read(workspaceId);
    if (!found) throw notFound("Workspace not found");
    return found;
  }

  private async record(
    workspaceId: string,
    accountId: string,
    previous: TimeZoneSettings,
    next: TimeZoneSettings,
    attribution: Record<string, unknown>,
  ): Promise<void> {
    if (previous.timeZone === next.timeZone) return;
    await this.deps.audit.record({
      accountId,
      workspaceId,
      eventType: "workspace.time_zone_settings.updated",
      eventStatus: "success",
      metadata: { ...attribution, timeZone: { from: previous.timeZone, to: next.timeZone } },
    });
  }
}
