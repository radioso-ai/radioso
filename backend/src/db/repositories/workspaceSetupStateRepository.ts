import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export const workspaceSetupSteps = ["purpose", "documents", "conversation", "directives_or_routines", "notify_destination", "credential"] as const;
export type WorkspaceSetupStep = (typeof workspaceSetupSteps)[number];

export interface WorkspaceSetupStateRecord {
  workspaceId: string;
  purpose: string | null;
  dismissedAt: Date | null;
  skippedSteps: WorkspaceSetupStep[];
}

interface WorkspaceSetupStateRow {
  workspace_id: string;
  purpose: string | null;
  dismissed_at: Date | null;
  skipped_steps: string[];
}

const mapRow = (row: WorkspaceSetupStateRow): WorkspaceSetupStateRecord => ({
  workspaceId: row.workspace_id,
  purpose: row.purpose,
  dismissedAt: row.dismissed_at,
  skippedSteps: row.skipped_steps.filter((step): step is WorkspaceSetupStep => workspaceSetupSteps.includes(step as WorkspaceSetupStep)),
});

export interface WorkspaceSetupStateRepositoryPort {
  get(workspaceId: string): Promise<WorkspaceSetupStateRecord>;
  update(workspaceId: string, input: {
    purpose?: string | null;
    dismissed?: boolean;
    skippedSteps?: WorkspaceSetupStep[];
  }): Promise<WorkspaceSetupStateRecord>;
  getOutcomeFlags(workspaceId: string): Promise<{
    hasDirectivesOrRoutines: boolean;
    hasNotifyDestination: boolean;
    hasNotifyDeliveryConfirmed: boolean;
    hasCredential: boolean;
  }>;
}

const columns = ["workspace_id", "purpose", "dismissed_at", "skipped_steps"] as const;

export class WorkspaceSetupStateRepository implements WorkspaceSetupStateRepositoryPort {
  constructor(private readonly db: Db) {}

  async get(workspaceId: string): Promise<WorkspaceSetupStateRecord> {
    const row = await this.db.selectFrom("workspace_setup_state").select(columns).where("workspace_id", "=", workspaceId).executeTakeFirstOrThrow();
    return mapRow(row);
  }

  async update(workspaceId: string, input: { purpose?: string | null; dismissed?: boolean; skippedSteps?: WorkspaceSetupStep[] }): Promise<WorkspaceSetupStateRecord> {
    const row = await this.db.updateTable("workspace_setup_state").set({
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.dismissed !== undefined ? { dismissed_at: input.dismissed ? currentTimestamp() : null } : {}),
      ...(input.skippedSteps !== undefined ? { skipped_steps: input.skippedSteps } : {}),
      updated_at: currentTimestamp(),
    }).where("workspace_id", "=", workspaceId).returning(columns).executeTakeFirstOrThrow();
    return mapRow(row);
  }

  async getOutcomeFlags(workspaceId: string) {
    const row = await this.db
      .selectFrom("workspaces")
      .select(({ exists, or, selectFrom }) => [
        or([
          exists(selectFrom("agent_directives")
            .innerJoin("agents", "agents.id", "agent_directives.agent_id")
            .select("agent_directives.id")
            .where("agents.workspace_id", "=", workspaceId)),
          exists(selectFrom("routine_definition")
            .innerJoin("agents", "agents.id", "routine_definition.agent_id")
            .select("routine_definition.id")
            .where("agents.workspace_id", "=", workspaceId)),
        ]).as("has_directives_or_routines"),
        exists(selectFrom("workspace_webhook_destinations")
          .select("id")
          .where("workspace_id", "=", workspaceId)).as("has_notify_destination"),
        exists(selectFrom("workspace_webhook_destinations")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("last_delivery_status", "=", "success")).as("has_notify_delivery_confirmed"),
        exists(selectFrom("api_credentials")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("revoked_at", "is", null)
          .where((eb) => eb.or([
            eb("expires_at", "is", null),
            eb("expires_at", ">", new Date()),
          ]))).as("has_credential"),
      ])
      .where("workspaces.id", "=", workspaceId)
      .executeTakeFirstOrThrow();

    return {
      hasDirectivesOrRoutines: Boolean(row.has_directives_or_routines),
      hasNotifyDestination: Boolean(row.has_notify_destination),
      hasNotifyDeliveryConfirmed: Boolean(row.has_notify_delivery_confirmed),
      hasCredential: Boolean(row.has_credential),
    };
  }
}
