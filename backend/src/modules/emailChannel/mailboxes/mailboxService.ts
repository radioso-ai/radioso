import { createHash } from "node:crypto";

import { AppError, badRequest, notFound } from "../../../shared/domain/errors.js";
import { normalizeDomainName, type SendingDomainService } from "../domains/sendingDomainService.js";
import { sendingStateOf, type MailboxSendingState } from "../domains/sendingState.js";
import { recordEmailChannelAudit, type EmailChannelActor, type EmailChannelAuditDependencies } from "../emailChannelAudit.js";
import type { EmailDomainRecord, EmailDomainRepository } from "../persistence/emailDomainRepository.js";
import type {
  EmailMailboxRecord,
  EmailMailboxRepository,
  MailboxSettings,
  SetupCheckStep,
} from "../persistence/emailMailboxRepository.js";
import type { EngagementMode } from "./effectiveMode.js";
import type { MailboxPolicyChangeUnitOfWork } from "./mailboxPolicyChangeUnitOfWork.js";
import { deriveReceivingState } from "./receivingState.js";
import { generateOpaqueToken, parsePlusToken, splitPlusAddress } from "./relayTokens.js";

const RELAY_TOKEN_GRACE_SECONDS = 7 * 24 * 60 * 60;
const DISPLAY_NAME_MAX_LENGTH = 200;
const LOCAL_PART_MAX_LENGTH = 64;
// RFC 5322 dot-atom text without `+`, which is reserved for thread tokens.
const LOCAL_PART = /^[a-z0-9!#$%&'*/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*/=?^_`{|}~-]+)*$/;

type NumericSetting = "threadSendBudget" | "hourlyGenerationBudget" | "threadContextMessages" | "silenceThresholdHours";

/** Safe defaults (FR-001); the same as the column defaults. */
const MAILBOX_DEFAULTS: Omit<MailboxSettings, "displayName"> = {
  threadSendBudget: 3,
  hourlyGenerationBudget: 30,
  threadContextMessages: 10,
  spamOptIn: false,
  silenceThresholdHours: 72,
};

const SETTING_BOUNDS: Readonly<Record<NumericSetting, readonly [number, number]>> = {
  threadSendBudget: [1, 20],
  hourlyGenerationBudget: [1, 1000],
  threadContextMessages: [1, 50],
  silenceThresholdHours: [1, 2160],
};

const SETTING_KEYS: readonly (keyof MailboxSettings)[] = [
  "displayName",
  "threadSendBudget",
  "hourlyGenerationBudget",
  "threadContextMessages",
  "spamOptIn",
  "silenceThresholdHours",
];

type PolicyField = "engagementMode" | "enabled" | "agentId";

interface CreateMailboxRequest extends Partial<Omit<MailboxSettings, "displayName">> {
  address: string;
  displayName: string;
  agentId?: string | null;
  engagementMode?: EngagementMode;
}

interface UpdateMailboxRequest extends Partial<MailboxSettings> {
  agentId?: string | null;
  engagementMode?: EngagementMode;
  enabled?: boolean;
  /** When given, the change applies only to this policy version (optimistic concurrency). */
  expectedPolicyVersion?: number;
}

interface EmailMailboxSetupCheckView {
  step: SetupCheckStep;
  startedAt: string;
  status: "waiting" | "passed";
  passedAt: string | null;
  /** The real address, or for `plus_address` a plus-addressed variant of it. */
  instructions: { sendTo: string };
}

interface EmailMailboxView extends MailboxSettings {
  id: string;
  address: string;
  agentId: string | null;
  domainId: string;
  /** `<relay token>@<inbound domain>`: settings readers of the owning workspace only. */
  relayAddress: string;
  engagementMode: EngagementMode;
  enabled: boolean;
  policyVersion: number;
  receiving: { state: ReturnType<typeof deriveReceivingState>; lastReceivedAt: string | null };
  sending: { state: MailboxSendingState };
  plusAddressVerified: boolean;
  setupCheck: EmailMailboxSetupCheckView | null;
}

interface MailboxAgentDirectory {
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{ id: string } | null>;
}

interface MailboxServiceDependencies extends EmailChannelAuditDependencies {
  mailboxes: Pick<
    EmailMailboxRepository,
    "createWithPolicy" | "findActive" | "findActiveById" | "listActive" | "rotateRelayToken" | "startSetupCheck" | "recordReceipt" | "markRemoved"
  >;
  domainRecords: Pick<EmailDomainRepository, "findById" | "listActive">;
  sendingDomains: Pick<SendingDomainService, "ensureRegistered">;
  policyChanges: MailboxPolicyChangeUnitOfWork;
  agents: MailboxAgentDirectory;
  randomBytes: (size: number) => Uint8Array;
  clock: () => Date;
  config: {
    inboundDomain: string;
    /** The modes this deployment can run (plan, Questions settled, item 4). */
    supportedModes: readonly EngagementMode[];
  };
}

/** `draft` once it is supported (FR-005), `operator_only` until then. */
export const defaultEngagementMode = (supportedModes: readonly EngagementMode[]): EngagementMode =>
  supportedModes.includes("draft") ? "draft" : "operator_only";

const toIso = (value: Date | null): string | null => value?.toISOString() ?? null;

const invalidAddress = (): AppError => new AppError(400, "invalid_address", "Enter the mailbox's address, such as support@example.com.");

const splitAddress = (address: string): { local: string; domain: string } => {
  const at = address.lastIndexOf("@");
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
};

/**
 * The `+tag` the plus-address setup check asks the operator to write to. It is derived from the
 * check itself, so mail written for an earlier check never passes a later one.
 */
const setupCheckTag = (mailboxId: string, startedAt: Date): string =>
  `check${createHash("sha256").update(`${mailboxId}:${startedAt.getTime()}`).digest("hex").slice(0, 12)}`;

const setupCheckView = (mailbox: EmailMailboxRecord): EmailMailboxSetupCheckView | null => {
  const { setupCheckStep: step, setupCheckStartedAt: startedAt } = mailbox;
  if (!step || !startedAt) return null;
  const proof = step === "base" ? mailbox.lastReceivedAt : mailbox.plusAddressVerifiedAt;
  const passedAt = proof && proof.getTime() >= startedAt.getTime() ? proof : null;
  const { local, domain } = splitAddress(mailbox.address);
  return {
    step,
    startedAt: startedAt.toISOString(),
    status: passedAt ? "passed" : "waiting",
    passedAt: toIso(passedAt),
    instructions: { sendTo: step === "base" ? mailbox.address : `${local}+${setupCheckTag(mailbox.id, startedAt)}@${domain}` },
  };
};

const validatedSettings = (request: Partial<MailboxSettings>): Partial<MailboxSettings> => {
  const settings: Partial<MailboxSettings> = {};
  if (request.displayName !== undefined) {
    const displayName = request.displayName.trim();
    if (displayName === "" || displayName.length > DISPLAY_NAME_MAX_LENGTH) {
      throw badRequest(`displayName must be 1 to ${DISPLAY_NAME_MAX_LENGTH} characters`);
    }
    settings.displayName = displayName;
  }
  for (const key of Object.keys(SETTING_BOUNDS) as NumericSetting[]) {
    const value = request[key];
    if (value === undefined) continue;
    const [min, max] = SETTING_BOUNDS[key];
    if (!Number.isInteger(value) || value < min || value > max) throw badRequest(`${key} must be an integer from ${min} to ${max}`);
    settings[key] = value;
  }
  if (request.spamOptIn !== undefined) settings.spamOptIn = request.spamOptIn;
  return settings;
};

/**
 * Mailboxes: creation (which registers the sending domain and issues a relay token), the
 * engagement policy and its history, relay-token rotation, the guided setup check and the
 * receipt record the setup check and the receiving state are derived from.
 */
export class MailboxService {
  constructor(private readonly deps: MailboxServiceDependencies) {}

  modes(): { supportedModes: EngagementMode[]; defaultMode: EngagementMode } {
    return { supportedModes: [...this.deps.config.supportedModes], defaultMode: defaultEngagementMode(this.deps.config.supportedModes) };
  }

  async list(workspaceId: string): Promise<EmailMailboxView[]> {
    const [mailboxes, domains] = await Promise.all([
      this.deps.mailboxes.listActive(workspaceId),
      this.deps.domainRecords.listActive(workspaceId),
    ]);
    const domainsById = new Map(domains.map((domain) => [domain.id, domain]));
    return Promise.all(mailboxes.map(async (mailbox) =>
      this.toView(mailbox, domainsById.get(mailbox.domainId) ?? (await this.deps.domainRecords.findById(mailbox.domainId)))));
  }

  async get(workspaceId: string, mailboxId: string): Promise<EmailMailboxView> {
    return this.viewOf(await this.requireActive(workspaceId, mailboxId));
  }

  async create(actor: EmailChannelActor, workspaceId: string, request: CreateMailboxRequest): Promise<EmailMailboxView> {
    const address = this.normalizeAddress(request.address);
    const { displayName, ...requested } = validatedSettings(request);
    if (displayName === undefined) throw badRequest("displayName is required");
    const settings: MailboxSettings = { ...MAILBOX_DEFAULTS, ...requested, displayName };
    const engagementMode = request.engagementMode ?? this.modes().defaultMode;
    this.requireSupportedMode(engagementMode);
    const agentId = request.agentId ?? null;
    if (agentId) await this.requireAgent(workspaceId, agentId);

    const registration = await this.deps.sendingDomains.ensureRegistered(actor, workspaceId, address.domain);
    if (!registration.ok) {
      throw registration.refused === "claimed_elsewhere"
        ? new AppError(409, "domain_claimed_elsewhere", "This address's domain is already registered to another workspace.")
        : invalidAddress();
    }
    const domain = registration.domain;
    const mailbox = await this.deps.mailboxes.createWithPolicy({
      workspaceId,
      domainId: domain.id,
      agentId,
      // The registered domain, so the address is always on the domain of `domain_id`.
      address: `${address.local}@${domain.domain}`,
      relayToken: generateOpaqueToken(this.deps.randomBytes),
      engagementMode,
      enabled: true,
      ...settings,
      createdByUserId: actor.userId,
    });
    if (!mailbox) throw new AppError(409, "mailbox_exists", "A mailbox with this address already exists.");

    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.mailbox",
      action: "created",
      actor,
      workspaceId,
      metadata: { mailboxId: mailbox.id, domainId: domain.id, agentId, mode: engagementMode },
    });
    return this.toView(mailbox, domain);
  }

  /**
   * Updates settings and policy together. Mode, enabled and agent changes go through the
   * policy-change unit of work: the row is locked, a stale `expectedPolicyVersion` is refused, and
   * a real change writes the next version with its history row.
   */
  async update(
    actor: EmailChannelActor,
    workspaceId: string,
    mailboxId: string,
    request: UpdateMailboxRequest,
  ): Promise<EmailMailboxView> {
    const settings = validatedSettings(request);
    if (request.agentId) await this.requireAgent(workspaceId, request.agentId);

    const outcome = await this.deps.policyChanges.run(async ({ mailboxes }) => {
      const current = await mailboxes.lockForPolicyChange(workspaceId, mailboxId);
      if (!current) return { kind: "not_found" as const };
      if (request.expectedPolicyVersion !== undefined && request.expectedPolicyVersion !== current.policyVersion) {
        return { kind: "stale" as const, policyVersion: current.policyVersion };
      }
      const next = {
        engagementMode: request.engagementMode ?? current.engagementMode,
        enabled: request.enabled ?? current.enabled,
        agentId: request.agentId === undefined ? current.agentId : request.agentId,
      };
      if (next.engagementMode !== current.engagementMode && !this.deps.config.supportedModes.includes(next.engagementMode)) {
        return { kind: "mode_unavailable" as const };
      }
      const policyChanges = (["engagementMode", "enabled", "agentId"] as const).filter((field) => next[field] !== current[field]);
      const settingChanges = SETTING_KEYS.filter((key) => settings[key] !== undefined && settings[key] !== current[key]);

      let after = current;
      if (policyChanges.length > 0) {
        after = this.written(await mailboxes.appendPolicyVersion({
          mailboxId: current.id,
          expectedVersion: current.policyVersion,
          ...next,
          changedByUserId: actor.userId,
        }));
      }
      if (settingChanges.length > 0) {
        const changedSettings = Object.fromEntries(settingChanges.map((key) => [key, settings[key]])) as Partial<MailboxSettings>;
        after = this.written(await mailboxes.updateSettings(workspaceId, current.id, changedSettings));
      }
      return { kind: "updated" as const, before: current, after, policyChanges, settingChanges };
    });

    if (outcome.kind === "not_found") throw notFound("Mailbox was not found");
    if (outcome.kind === "stale") {
      throw new AppError(409, "stale_policy_version", "The mailbox's policy changed since it was read. Reload and try again.", {
        policyVersion: outcome.policyVersion,
      });
    }
    if (outcome.kind === "mode_unavailable") throw this.modeUnavailable();

    await this.auditUpdate(actor, workspaceId, outcome);
    return this.viewOf(outcome.after);
  }

  async remove(actor: EmailChannelActor, workspaceId: string, mailboxId: string): Promise<void> {
    const removed = await this.deps.mailboxes.markRemoved(workspaceId, mailboxId);
    if (!removed) throw notFound("Mailbox was not found");
    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.mailbox",
      action: "removed",
      actor,
      workspaceId,
      metadata: { mailboxId: removed.id, domainId: removed.domainId, agentId: removed.agentId },
    });
  }

  /** Issues a new relay address; the previous one keeps working for seven days. */
  async rotateRelayToken(actor: EmailChannelActor, workspaceId: string, mailboxId: string): Promise<EmailMailboxView> {
    const rotated = await this.deps.mailboxes.rotateRelayToken(workspaceId, mailboxId, {
      relayToken: generateOpaqueToken(this.deps.randomBytes),
      graceSeconds: RELAY_TOKEN_GRACE_SECONDS,
    });
    if (!rotated) throw notFound("Mailbox was not found");
    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.mailbox",
      action: "relay_token_rotated",
      actor,
      workspaceId,
      metadata: { mailboxId: rotated.id, graceExpiresAt: toIso(rotated.previousRelayTokenExpiresAt) },
    });
    return this.viewOf(rotated);
  }

  /**
   * Starts a setup-check step (FR-006). `base` passes on the next message received; `plus_address`
   * passes when a message written to the check's plus address arrives with its tag intact.
   */
  async startSetupCheck(workspaceId: string, mailboxId: string, step: SetupCheckStep): Promise<EmailMailboxSetupCheckView> {
    const started = await this.deps.mailboxes.startSetupCheck(workspaceId, mailboxId, step);
    const check = started ? setupCheckView(started) : null;
    if (!check) throw notFound("Mailbox was not found");
    return check;
  }

  /**
   * Records mail accepted for a mailbox at `receivedAt`, addressed to `deliveredTo` (the
   * delivered-to set). That is the last received time and, when a plus-address check is running,
   * its proof: plus-addressed mail reaches Radioso with the tag intact.
   */
  async recordInboundReceipt(input: { mailboxId: string; receivedAt: Date; deliveredTo: readonly string[] }): Promise<void> {
    const mailbox = await this.deps.mailboxes.findActiveById(input.mailboxId);
    if (!mailbox) return;
    const startedAt = mailbox.setupCheckStartedAt;
    const expectedTag = mailbox.setupCheckStep === "plus_address" && startedAt ? setupCheckTag(mailbox.id, startedAt) : null;
    const plusAddressProven = expectedTag !== null
      && startedAt !== null
      && input.receivedAt.getTime() >= startedAt.getTime()
      && input.deliveredTo.some((address) => parsePlusToken(address)?.toLowerCase() === expectedTag);
    await this.deps.mailboxes.recordReceipt(mailbox.id, { receivedAt: input.receivedAt, plusAddressProven });
  }

  private async auditUpdate(
    actor: EmailChannelActor,
    workspaceId: string,
    outcome: { before: EmailMailboxRecord; after: EmailMailboxRecord; policyChanges: PolicyField[]; settingChanges: (keyof MailboxSettings)[] },
  ): Promise<void> {
    const { before, after } = outcome;
    if (outcome.policyChanges.some((field) => field !== "agentId")) {
      await recordEmailChannelAudit(this.deps, {
        eventType: "email_channel.mailbox",
        action: "mode_changed",
        actor,
        workspaceId,
        metadata: {
          mailboxId: after.id,
          fromMode: before.engagementMode,
          toMode: after.engagementMode,
          enabled: after.enabled,
          policyVersion: after.policyVersion,
          supersededHeldReplies: 0,
        },
      });
    }
    const changedFields = [...outcome.policyChanges.filter((field) => field === "agentId"), ...outcome.settingChanges];
    if (changedFields.length > 0) {
      await recordEmailChannelAudit(this.deps, {
        eventType: "email_channel.mailbox",
        action: "updated",
        actor,
        workspaceId,
        metadata: { mailboxId: after.id, domainId: after.domainId, agentId: after.agentId, changedFields, policyVersion: after.policyVersion },
      });
    }
  }

  private normalizeAddress(input: string): { local: string; domain: string } {
    const parts = splitPlusAddress(input.trim().toLowerCase());
    if (!parts || parts.tag !== null || parts.base.length > LOCAL_PART_MAX_LENGTH || !LOCAL_PART.test(parts.base)) {
      throw invalidAddress();
    }
    const domain = normalizeDomainName(parts.domain);
    if (!domain) throw invalidAddress();
    return { local: parts.base, domain };
  }

  private requireSupportedMode(mode: EngagementMode): void {
    if (!this.deps.config.supportedModes.includes(mode)) throw this.modeUnavailable();
  }

  private modeUnavailable(): AppError {
    return new AppError(409, "engagement_mode_unavailable", "This engagement mode is not available yet.", {
      supportedModes: [...this.deps.config.supportedModes],
    });
  }

  private async requireAgent(workspaceId: string, agentId: string): Promise<void> {
    if (!(await this.deps.agents.findByIdAndWorkspaceId(agentId, workspaceId))) {
      throw badRequest("agentId does not name an agent in this workspace");
    }
  }

  private async requireActive(workspaceId: string, mailboxId: string): Promise<EmailMailboxRecord> {
    const mailbox = await this.deps.mailboxes.findActive(workspaceId, mailboxId);
    if (!mailbox) throw notFound("Mailbox was not found");
    return mailbox;
  }

  private written(record: EmailMailboxRecord | null): EmailMailboxRecord {
    // The row is locked for this transaction, so a write that matches nothing is a defect.
    if (!record) throw new Error("A locked mailbox row could not be written");
    return record;
  }

  private async viewOf(mailbox: EmailMailboxRecord): Promise<EmailMailboxView> {
    return this.toView(mailbox, await this.deps.domainRecords.findById(mailbox.domainId));
  }

  private toView(mailbox: EmailMailboxRecord, domain: EmailDomainRecord | null): EmailMailboxView {
    return {
      id: mailbox.id,
      address: mailbox.address,
      displayName: mailbox.displayName,
      agentId: mailbox.agentId,
      domainId: mailbox.domainId,
      relayAddress: `${mailbox.relayToken.toLowerCase()}@${this.deps.config.inboundDomain}`,
      engagementMode: mailbox.engagementMode,
      enabled: mailbox.enabled,
      policyVersion: mailbox.policyVersion,
      threadSendBudget: mailbox.threadSendBudget,
      hourlyGenerationBudget: mailbox.hourlyGenerationBudget,
      threadContextMessages: mailbox.threadContextMessages,
      spamOptIn: mailbox.spamOptIn,
      silenceThresholdHours: mailbox.silenceThresholdHours,
      receiving: {
        state: deriveReceivingState({
          lastReceivedAt: mailbox.lastReceivedAt,
          silenceThresholdHours: mailbox.silenceThresholdHours,
          now: this.deps.clock(),
        }),
        lastReceivedAt: toIso(mailbox.lastReceivedAt),
      },
      sending: { state: sendingStateOf(domain) },
      plusAddressVerified: mailbox.plusAddressVerifiedAt !== null,
      setupCheck: setupCheckView(mailbox),
    };
  }
}
