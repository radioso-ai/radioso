import type { Selectable } from "kysely";

import { currentTimestamp, nowPlusSeconds } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import type { EngagementMode } from "../mailboxes/effectiveMode.js";
import { readEnum, readOptionalEnum } from "./columnValues.js";

export type SetupCheckStep = "base" | "plus_address";

const ENGAGEMENT_MODES: readonly EngagementMode[] = ["operator_only", "draft", "auto"];
const SETUP_CHECK_STEPS: readonly SetupCheckStep[] = ["base", "plus_address"];

/** The operator-tunable settings that are not engagement policy, so they never bump its version. */
export interface MailboxSettings {
  displayName: string;
  threadSendBudget: number;
  hourlyGenerationBudget: number;
  threadContextMessages: number;
  spamOptIn: boolean;
  silenceThresholdHours: number;
}

/** The engagement policy: what `policy_version` and the history table version. */
interface MailboxPolicy {
  engagementMode: EngagementMode;
  enabled: boolean;
  agentId: string | null;
}

export interface EmailMailboxRecord extends MailboxSettings, MailboxPolicy {
  id: string;
  workspaceId: string;
  domainId: string;
  /** Lowercase `local@domain`; immutable. */
  address: string;
  /** Secret: the relay address's local part. Never logged and never in a Ray projection. */
  relayToken: string;
  previousRelayToken: string | null;
  previousRelayTokenExpiresAt: Date | null;
  policyVersion: number;
  plusAddressVerifiedAt: Date | null;
  setupCheckStep: SetupCheckStep | null;
  setupCheckStartedAt: Date | null;
  lastReceivedAt: Date | null;
  removedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailboxPolicyVersion extends MailboxPolicy {
  mailboxId: string;
  version: number;
  effectiveAt: Date;
  changedByUserId: string | null;
}

interface CreateMailboxInput extends MailboxSettings, MailboxPolicy {
  workspaceId: string;
  domainId: string;
  address: string;
  relayToken: string;
  createdByUserId: string | null;
}

interface AppendPolicyVersionInput extends MailboxPolicy {
  mailboxId: string;
  /** The version the caller read under its row lock; the write is a compare-and-set on it. */
  expectedVersion: number;
  changedByUserId: string | null;
}

type MailboxRow = Selectable<DB["email_mailboxes"]>;
type PolicyRow = Selectable<DB["email_mailbox_policies"]>;

const mapMailbox = (row: MailboxRow): EmailMailboxRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  domainId: row.domain_id,
  agentId: row.agent_id,
  address: row.address,
  displayName: row.display_name,
  relayToken: row.relay_token,
  previousRelayToken: row.previous_relay_token,
  previousRelayTokenExpiresAt: row.previous_relay_token_expires_at,
  engagementMode: readEnum(row.engagement_mode, ENGAGEMENT_MODES, "email_mailboxes.engagement_mode"),
  enabled: row.enabled,
  policyVersion: row.policy_version,
  threadSendBudget: row.thread_send_budget,
  hourlyGenerationBudget: row.hourly_generation_budget,
  threadContextMessages: row.thread_context_messages,
  spamOptIn: row.spam_opt_in,
  silenceThresholdHours: row.silence_threshold_hours,
  plusAddressVerifiedAt: row.plus_address_verified_at,
  setupCheckStep: readOptionalEnum(row.setup_check_step, SETUP_CHECK_STEPS, "email_mailboxes.setup_check_step"),
  setupCheckStartedAt: row.setup_check_started_at,
  lastReceivedAt: row.last_received_at,
  removedAt: row.removed_at,
  createdByUserId: row.created_by_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapPolicy = (row: PolicyRow): MailboxPolicyVersion => ({
  mailboxId: row.mailbox_id,
  version: row.version,
  engagementMode: readEnum(row.engagement_mode, ENGAGEMENT_MODES, "email_mailbox_policies.engagement_mode"),
  enabled: row.enabled,
  agentId: row.agent_id,
  effectiveAt: row.effective_at,
  changedByUserId: row.changed_by_user_id,
});

const settingsColumns = (settings: Partial<MailboxSettings>) => ({
  ...(settings.displayName !== undefined ? { display_name: settings.displayName } : {}),
  ...(settings.threadSendBudget !== undefined ? { thread_send_budget: settings.threadSendBudget } : {}),
  ...(settings.hourlyGenerationBudget !== undefined ? { hourly_generation_budget: settings.hourlyGenerationBudget } : {}),
  ...(settings.threadContextMessages !== undefined ? { thread_context_messages: settings.threadContextMessages } : {}),
  ...(settings.spamOptIn !== undefined ? { spam_opt_in: settings.spamOptIn } : {}),
  ...(settings.silenceThresholdHours !== undefined ? { silence_threshold_hours: settings.silenceThresholdHours } : {}),
});

/** Mailboxes and their append-only engagement policy history (research B16). */
export class EmailMailboxRepository {
  constructor(private readonly db: Db) {}

  /**
   * Writes the mailbox and its policy version 1 in one statement. Null when an active mailbox
   * already has the address.
   */
  async createWithPolicy(input: CreateMailboxInput): Promise<EmailMailboxRecord | null> {
    const row = await this.db
      .with("created", (db) =>
        db
          .insertInto("email_mailboxes")
          .values({
            workspace_id: input.workspaceId,
            domain_id: input.domainId,
            agent_id: input.agentId,
            address: input.address,
            display_name: input.displayName,
            relay_token: input.relayToken,
            engagement_mode: input.engagementMode,
            enabled: input.enabled,
            policy_version: 1,
            thread_send_budget: input.threadSendBudget,
            hourly_generation_budget: input.hourlyGenerationBudget,
            thread_context_messages: input.threadContextMessages,
            spam_opt_in: input.spamOptIn,
            silence_threshold_hours: input.silenceThresholdHours,
            created_by_user_id: input.createdByUserId,
          })
          .onConflict((oc) => oc.doNothing())
          .returningAll(),
      )
      .with("first_policy", (db) =>
        db
          .insertInto("email_mailbox_policies")
          .columns(["mailbox_id", "version", "engagement_mode", "enabled", "agent_id", "changed_by_user_id"])
          .expression((eb) =>
            eb
              .selectFrom("created")
              .select(["id", "policy_version", "engagement_mode", "enabled", "agent_id", "created_by_user_id"]),
          )
          .returning("version"),
      )
      .selectFrom("created")
      .selectAll()
      .executeTakeFirst();
    return row ? mapMailbox(row) : null;
  }

  async findActive(workspaceId: string, mailboxId: string): Promise<EmailMailboxRecord | null> {
    const row = await this.db
      .selectFrom("email_mailboxes")
      .selectAll()
      .where("id", "=", mailboxId)
      .where("workspace_id", "=", workspaceId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    return row ? mapMailbox(row) : null;
  }

  /** An active mailbox by id alone, for inbound processing, which is not workspace-scoped. */
  async findActiveById(mailboxId: string): Promise<EmailMailboxRecord | null> {
    const row = await this.db
      .selectFrom("email_mailboxes")
      .selectAll()
      .where("id", "=", mailboxId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    return row ? mapMailbox(row) : null;
  }

  /** Any mailbox, removed or not: a conversation keeps naming the mailbox it came through. */
  async findById(mailboxId: string): Promise<EmailMailboxRecord | null> {
    const row = await this.db.selectFrom("email_mailboxes").selectAll().where("id", "=", mailboxId).executeTakeFirst();
    return row ? mapMailbox(row) : null;
  }

  async listActive(workspaceId: string): Promise<EmailMailboxRecord[]> {
    const rows = await this.db
      .selectFrom("email_mailboxes")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("removed_at", "is", null)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(mapMailbox);
  }

  async countActiveOnDomain(domainId: string): Promise<number> {
    const row = await this.db
      .selectFrom("email_mailboxes")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("domain_id", "=", domainId)
      .where("removed_at", "is", null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * The relay rule's lookup (research B20): the active mailbox whose current token, or whose
   * previous token still inside its rotation grace by the database clock, is `relayToken`.
   */
  async resolveRelayToken(
    relayToken: string,
  ): Promise<{ mailboxId: string; workspaceId: string; generation: "current" | "previous" } | null> {
    const rows = await this.db
      .selectFrom("email_mailboxes")
      .select(["id", "workspace_id", "relay_token"])
      .where("removed_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("relay_token", "=", relayToken),
          eb.and([
            eb("previous_relay_token", "=", relayToken),
            eb("previous_relay_token_expires_at", ">", currentTimestamp()),
          ]),
        ]),
      )
      .limit(2)
      .execute();
    const row = rows.find((candidate) => candidate.relay_token === relayToken) ?? rows[0];
    if (!row) return null;
    return {
      mailboxId: row.id,
      workspaceId: row.workspace_id,
      generation: row.relay_token === relayToken ? "current" : "previous",
    };
  }

  /** The direct rule's lookup: the active mailbox with this lowercase, tag-free address. */
  async findActiveByAddress(address: string): Promise<{ mailboxId: string; workspaceId: string } | null> {
    const row = await this.db
      .selectFrom("email_mailboxes")
      .select(["id", "workspace_id"])
      .where("address", "=", address)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    return row ? { mailboxId: row.id, workspaceId: row.workspace_id } : null;
  }

  async updateSettings(
    workspaceId: string,
    mailboxId: string,
    settings: Partial<MailboxSettings>,
  ): Promise<EmailMailboxRecord | null> {
    const row = await this.db
      .updateTable("email_mailboxes")
      .set({ ...settingsColumns(settings), updated_at: currentTimestamp() })
      .where("id", "=", mailboxId)
      .where("workspace_id", "=", workspaceId)
      .where("removed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapMailbox(row) : null;
  }

  /** The current token becomes the previous one, accepted until the grace period ends. */
  async rotateRelayToken(
    workspaceId: string,
    mailboxId: string,
    input: { relayToken: string; graceSeconds: number },
  ): Promise<EmailMailboxRecord | null> {
    const row = await this.db
      .updateTable("email_mailboxes")
      .set((eb) => ({
        previous_relay_token: eb.ref("relay_token"),
        previous_relay_token_expires_at: nowPlusSeconds(input.graceSeconds),
        relay_token: input.relayToken,
        updated_at: currentTimestamp(),
      }))
      .where("id", "=", mailboxId)
      .where("workspace_id", "=", workspaceId)
      .where("removed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapMailbox(row) : null;
  }

  async startSetupCheck(workspaceId: string, mailboxId: string, step: SetupCheckStep): Promise<EmailMailboxRecord | null> {
    const row = await this.db
      .updateTable("email_mailboxes")
      .set({ setup_check_step: step, setup_check_started_at: currentTimestamp(), updated_at: currentTimestamp() })
      .where("id", "=", mailboxId)
      .where("workspace_id", "=", workspaceId)
      .where("removed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapMailbox(row) : null;
  }

  /**
   * Records mail received for the mailbox. Out-of-order processing never moves the last received
   * time backwards, because `greatest` ignores a null and keeps the later of the two.
   */
  async recordReceipt(mailboxId: string, input: { receivedAt: Date; plusAddressProven: boolean }): Promise<void> {
    await this.db
      .updateTable("email_mailboxes")
      .set((eb) => ({
        last_received_at: eb.fn<Date>("greatest", [eb.ref("last_received_at"), eb.val(input.receivedAt)]),
        ...(input.plusAddressProven
          ? { plus_address_verified_at: eb.fn<Date>("greatest", [eb.ref("plus_address_verified_at"), eb.val(input.receivedAt)]) }
          : {}),
      }))
      .where("id", "=", mailboxId)
      .execute();
  }

  async markRemoved(workspaceId: string, mailboxId: string): Promise<EmailMailboxRecord | null> {
    const row = await this.db
      .updateTable("email_mailboxes")
      .set({ removed_at: currentTimestamp(), updated_at: currentTimestamp() })
      .where("id", "=", mailboxId)
      .where("workspace_id", "=", workspaceId)
      .where("removed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapMailbox(row) : null;
  }

  /** Locks the active mailbox row for the rest of the caller's transaction. */
  async lockForPolicyChange(workspaceId: string, mailboxId: string): Promise<EmailMailboxRecord | null> {
    const row = await this.db
      .selectFrom("email_mailboxes")
      .selectAll()
      .where("id", "=", mailboxId)
      .where("workspace_id", "=", workspaceId)
      .where("removed_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    return row ? mapMailbox(row) : null;
  }

  /**
   * Writes the next policy version on the mailbox and appends it to the history in one
   * statement. Null when the version moved since the caller read it, or the mailbox is removed.
   */
  async appendPolicyVersion(input: AppendPolicyVersionInput): Promise<EmailMailboxRecord | null> {
    const row = await this.db
      .with("bumped", (db) =>
        db
          .updateTable("email_mailboxes")
          .set({
            engagement_mode: input.engagementMode,
            enabled: input.enabled,
            agent_id: input.agentId,
            policy_version: input.expectedVersion + 1,
            updated_at: currentTimestamp(),
          })
          .where("id", "=", input.mailboxId)
          .where("policy_version", "=", input.expectedVersion)
          .where("removed_at", "is", null)
          .returningAll(),
      )
      .with("history", (db) =>
        db
          .insertInto("email_mailbox_policies")
          .columns(["mailbox_id", "version", "engagement_mode", "enabled", "agent_id", "changed_by_user_id"])
          .expression((eb) =>
            eb
              .selectFrom("bumped")
              .select((sb) => [
                "id",
                "policy_version",
                "engagement_mode",
                "enabled",
                "agent_id",
                sb.cast<string | null>(sb.val(input.changedByUserId), "uuid").as("changed_by_user_id"),
              ]),
          )
          .returning("version"),
      )
      .selectFrom("bumped")
      .selectAll()
      .executeTakeFirst();
    return row ? mapMailbox(row) : null;
  }

  /** The policy in force at `at`: the newest version effective at or before it. */
  async policyEffectiveAt(mailboxId: string, at: Date): Promise<MailboxPolicyVersion | null> {
    const row = await this.db
      .selectFrom("email_mailbox_policies")
      .selectAll()
      .where("mailbox_id", "=", mailboxId)
      .where("effective_at", "<=", at)
      .orderBy("effective_at", "desc")
      .orderBy("version", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? mapPolicy(row) : null;
  }

  async listPolicyHistory(mailboxId: string): Promise<MailboxPolicyVersion[]> {
    const rows = await this.db
      .selectFrom("email_mailbox_policies")
      .selectAll()
      .where("mailbox_id", "=", mailboxId)
      .orderBy("version", "asc")
      .execute();
    return rows.map(mapPolicy);
  }
}
