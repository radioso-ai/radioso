import { describe, expect, it, vi } from "vitest";

import { createPostgresMailboxPolicyChangeUnitOfWork } from "../../../src/app/composition/mailboxPolicyChange.js";
import type { AuditEventInput } from "../../../src/modules/audit/contracts/index.js";
import { emailMailboxPolicyRef, MailboxService } from "../../../src/modules/emailChannel/public.js";
import { createRecordingKysely, type RecordedAnswer } from "../../support/recordingKysely.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";
const domainId = "33333333-3333-4333-8333-333333333333";
const actor = { userId: "44444444-4444-4444-8444-444444444444", accountId: null };
const createdAt = new Date("2026-10-01T09:00:00.000Z");

const mailboxRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: mailboxId,
  workspace_id: workspaceId,
  domain_id: domainId,
  agent_id: null,
  address: "support@customer.example",
  display_name: "Support",
  relay_token: "relaytoken",
  previous_relay_token: null,
  previous_relay_token_expires_at: null,
  engagement_mode: "draft",
  enabled: true,
  policy_version: 4,
  thread_send_budget: 3,
  hourly_generation_budget: 30,
  thread_context_messages: 10,
  spam_opt_in: false,
  silence_threshold_hours: 72,
  plus_address_verified_at: null,
  setup_check_step: null,
  setup_check_started_at: null,
  last_received_at: null,
  removed_at: null,
  created_by_user_id: null,
  created_at: createdAt,
  updated_at: createdAt,
  ...overrides,
});

/** Classifies a statement by the table it writes or locks; null for any other. */
const kindOf = (sql: string): string | null => {
  if (/^select .* from "email_mailboxes" .*for update$/u.test(sql)) return "lock_mailbox";
  if (/^with "bumped" as \(update "email_mailboxes" .*insert into "email_mailbox_policies"/u.test(sql)) return "bump_policy_with_history";
  if (/^update "email_mailboxes" set "display_name"/u.test(sql)) return "update_settings";
  if (/^update "held_replies"/u.test(sql)) return "supersede_held_replies";
  return null;
};

const harness = (options: { superseded?: number; supersedeFails?: boolean } = {}) => {
  const { db, statements, log } = createRecordingKysely(({ sql, parameters }): RecordedAnswer => {
    switch (kindOf(sql)) {
      case "lock_mailbox":
        return { rows: [mailboxRow()] };
      case "bump_policy_with_history":
        return { rows: [mailboxRow({ engagement_mode: parameters[0], enabled: parameters[1], policy_version: 5 })] };
      case "update_settings":
        return { rows: [mailboxRow({ display_name: parameters[0] })] };
      case "supersede_held_replies":
        if (options.supersedeFails) throw new Error("held replies unavailable");
        return { changed: options.superseded ?? 0 };
      default:
        return undefined;
    }
  });
  const audit = { record: vi.fn(async (_event: AuditEventInput) => undefined) };
  const service = new MailboxService({
    mailboxes: {} as never,
    domainRecords: { findById: vi.fn(async () => null), listActive: vi.fn(async () => []) },
    sendingDomains: { ensureRegistered: vi.fn() },
    policyChanges: createPostgresMailboxPolicyChangeUnitOfWork({ db }),
    agents: { findByIdAndWorkspaceId: vi.fn(async () => null) },
    audit,
    logger: { warn: vi.fn() },
    randomBytes: (size) => new Uint8Array(size),
    clock: () => createdAt,
    config: { inboundDomain: "in.radioso.test", supportedModes: ["operator_only", "draft"] },
  });
  /** What the database received: BEGIN, COMMIT and ROLLBACK, and each statement by its kind. */
  const sent = () => log.map((entry) => (["BEGIN", "COMMIT", "ROLLBACK"].includes(entry) ? entry : kindOf(entry) ?? entry));
  const supersede = () => statements.find((statement) => kindOf(statement.sql) === "supersede_held_replies");
  return { service, statements, sent, supersede, audit };
};

describe("createPostgresMailboxPolicyChangeUnitOfWork", () => {
  it("locks the mailbox FOR UPDATE, bumps the version with its history row and supersedes its drafts, in one transaction", async () => {
    const { service, statements, sent, supersede, audit } = harness({ superseded: 2 });

    const view = await service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" });

    expect(view).toMatchObject({ engagementMode: "operator_only", policyVersion: 5 });
    expect(sent()).toEqual(["BEGIN", "lock_mailbox", "bump_policy_with_history", "supersede_held_replies", "COMMIT"]);
    expect(new Set(statements.map((statement) => statement.transaction))).toEqual(new Set([1]));
    // Every live draft bound to the mailbox's policy, whatever its conversation: pending or queued to send.
    expect(supersede()?.sql).toMatch(/where "policy_ref" = \$\d+ and "state" in \(\$\d+, \$\d+\)$/u);
    expect(supersede()?.parameters).toEqual(expect.arrayContaining([
      "superseded",
      "policy_changed",
      emailMailboxPolicyRef(mailboxId),
      "pending",
      "queued_auto",
    ]));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "email_channel.mailbox",
      metadata: expect.objectContaining({
        action: "mode_changed",
        fromMode: "draft",
        toMode: "operator_only",
        policyVersion: 5,
        supersededHeldReplies: 2,
      }),
    }));
  });

  it("leaves drafts alone for a settings change that is not policy, and for a stale policy version", async () => {
    const settingsOnly = harness();
    await settingsOnly.service.update(actor, workspaceId, mailboxId, { displayName: "Help desk" });
    expect(settingsOnly.sent()).toEqual(["BEGIN", "lock_mailbox", "update_settings", "COMMIT"]);

    const stale = harness();
    await expect(stale.service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only", expectedPolicyVersion: 3 }))
      .rejects.toMatchObject({ statusCode: 409, code: "stale_policy_version" });
    expect(stale.sent()).toEqual(["BEGIN", "lock_mailbox", "COMMIT"]);
  });

  it("rolls the policy change back when its drafts cannot be superseded, auditing nothing", async () => {
    const { service, sent, audit } = harness({ supersedeFails: true });

    await expect(service.update(actor, workspaceId, mailboxId, { engagementMode: "operator_only" }))
      .rejects.toThrow("held replies unavailable");

    expect(sent()).toEqual(["BEGIN", "lock_mailbox", "bump_policy_with_history", "supersede_held_replies", "ROLLBACK"]);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
