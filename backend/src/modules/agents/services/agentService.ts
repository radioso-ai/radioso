import type { ZodError } from "zod";

import type {
  AgentGreetingUpdateOptions,
  AgentProposalCasGuard,
  AgentProposalCasOutcome,
  AgentRepositoryPort,
  AgentUpdateOptions,
} from "../../../db/repositories/agentRepository.js";
import type { DocumentSourceRepositoryPort } from "../../../db/repositories/documentSourceRepository.js";
import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AccessGrantService } from "../../accessGrants/public.js";
import type { AgentSkillRepositoryPort } from "../../agentSkills/public.js";
import { generateApiToken } from "../../auth/contracts/index.js";
import type { EmbedConfigCacheInvalidator } from "./embedConfigCacheInvalidator.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../documents/contracts/index.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { canonicalContentHash } from "../../../shared/domain/canonicalContentHash.js";
import { fieldProposalVersion } from "../../../shared/domain/fieldProposalVersion.js";
import { validateExactContentItem, type ExactContentValidationResult } from "../../../shared/domain/exactContent.js";
import {
  getWebsiteEmbedSurfaceSettings,
  isAgentBootstrapActive,
  mergeAgentSurfaceSettings,
  resolveEffectiveContactDelivery,
  validateAgentInput,
  type AgentInput,
  type AgentRecord,
} from "../domain.js";
import {
  agentInputFieldSchemas,
  agentReviewedSettingsPatchSchema,
  agentSettingProposalEffect,
  type AgentReviewedSettingsKey,
  type AgentReviewedSettingsPatch,
} from "../agentInputSchema.js";
import { DEFAULT_AGENT_LOCALE_FALLBACK, type AgentGreetingSnapshot } from "../agentRevision.js";
import { ensurePublicIdMintedForInput } from "./agentPublicIdentity.js";
import type { OwnerCommitHook } from "../../../shared/infra/kysely/types.js";
import type { AuditService } from "../../audit/contracts/index.js";
import { recipientEmailChangeMetadata } from "../../../shared/domain/recipientEmailAudit.js";
import {
  requestAddedRecipientConfirmations,
  type RecipientConfirmationRequester,
} from "../../../shared/domain/recipientConfirmationRequests.js";

export type AgentSettingsResource = Omit<AgentRecord, "authoredDirectives"> & {
  isDefault: boolean;
  assistantBootstrapActive: boolean;
};

export interface AgentFieldProposalPreparation {
  readonly targetAgentId: string;
  readonly normalizedPatch: AgentInput;
  readonly expected: { readonly key: string; readonly value: unknown };
  readonly display: { readonly current: unknown; readonly proposed: unknown };
}
export interface AgentFieldsProposalPreparation {
  readonly targetAgentId: string;
  readonly agentName: string;
  readonly normalizedPatch: AgentReviewedSettingsPatch;
  readonly expectedFields: ReadonlyArray<{ readonly key: AgentReviewedSettingsKey; readonly value: unknown }>;
  readonly changes: ReadonlyArray<{
    readonly key: AgentReviewedSettingsKey;
    readonly current: unknown;
    readonly proposed: unknown;
    readonly lifecycle: "live" | "agent_draft";
    readonly reach: boolean;
  }>;
  readonly unchanged: readonly AgentReviewedSettingsKey[];
  readonly effect: { readonly exposure: "draft" | "live"; readonly reversibility: "reversible"; readonly metered: false };
}
export type AgentFieldProposalApplyInput =
  | (Pick<AgentFieldProposalPreparation, "targetAgentId" | "normalizedPatch"> & {
    readonly expected: { readonly key: string; readonly value: unknown };
  })
  | {
    readonly targetAgentId: string;
    readonly normalizedPatch: AgentReviewedSettingsPatch;
    readonly expectedFields: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
  }
  | (Pick<AgentFieldProposalPreparation, "targetAgentId" | "normalizedPatch"> & {
    readonly expectedUpdatedAt: Date;
  });
export type AgentFieldProposalApplyOutcome =
  | { readonly status: "applied"; readonly followUp?: "side_effects_incomplete" }
  | { readonly status: "changed"; readonly fields: readonly string[] }
  | { readonly status: "target_changed" }
  | { readonly status: "target_deleted" };

/** Narrow owner port for proposal adapters and reviewed MCP preparation. */
export interface AgentSettingsProposalPort {
  prepareFieldProposal(workspaceId: string, agentId: string, input: { readonly settingKey: string; readonly value: unknown }): Promise<AgentFieldProposalPreparation>;
  prepareFieldsProposal(workspaceId: string, agentId: string, patch: AgentReviewedSettingsPatch): Promise<AgentFieldsProposalPreparation>;
  readFieldProposalVersion(workspaceId: string, agentId: string, expected?: { readonly key: string } | { readonly keys: readonly string[] }): Promise<string>;
  readFieldProposalDisplay(workspaceId: string, agentId: string, settingKey: string): Promise<unknown>;
  applyFieldProposal(workspaceId: string, prepared: AgentFieldProposalApplyInput, options?: { readonly onCommitted?: OwnerCommitHook<{ readonly agentId: string }> }): Promise<AgentFieldProposalApplyOutcome>;
}

const MAX_SETTING_ISSUE_PART_CHARS = 200;
/**
 * At most 200 UTF-16 units, ellipsis included. Cut by code point: half an emoji is a lone
 * surrogate, which the jsonb audit payload rejects (the same rule as Ray's `boundedSummary`).
 */
const boundedIssuePart = (text: string): string => {
  if (text.length <= MAX_SETTING_ISSUE_PART_CHARS) return text;
  const kept = Array.from(text).slice(0, MAX_SETTING_ISSUE_PART_CHARS - 1);
  while (kept.length > 0 && kept.join("").length > MAX_SETTING_ISSUE_PART_CHARS - 1) kept.pop();
  return `${kept.join("")}\u2026`;
};

/**
 * Where a proposed value first fails its schema, as a dot-path into the value. A nested block such
 * as `voice` is replaced whole, so the author needs the failing line, not only the setting's name.
 * The path holds caller-chosen keys and the message can echo a received value, so both are bounded
 * before they reach the 400, the audit record, or an MCP response.
 */
const settingValueIssue = (error: ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return "";
  const path = boundedIssuePart(issue.path.join("."));
  const message = boundedIssuePart(issue.message);
  return path ? ` at ${path}: ${message}` : `: ${message}`;
};

/** Equal as stored JSON: Postgres `jsonb` returns object keys in its own order, so key order means nothing. */
const sameSettingValue = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return canonicalContentHash(JSON.parse(JSON.stringify(left))) === canonicalContentHash(JSON.parse(JSON.stringify(right)));
};

const proposalSettingPatch = (settingKey: string, value: unknown): AgentInput => {
  if (settingKey === "surfaceSettings") {
    throw badRequest("Public channel and embed settings are proposed with propose_workspace_setting, which names each field and states on the card when a change alters who can reach the agent");
  }
  const schema = agentInputFieldSchemas[settingKey as keyof typeof agentInputFieldSchemas];
  if (!schema) throw badRequest(`Unknown agent setting: ${settingKey}`);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(`Invalid ${settingKey} setting value${settingValueIssue(parsed.error)}`);
  return { [settingKey]: parsed.data };
};
const proposalSettingValue = (settings: object, settingKey: string): unknown =>
  Object.hasOwn(settings, settingKey) ? (settings as Record<string, unknown>)[settingKey] : undefined;

/** An agent whose default locale a write changed, for what keeps a copy of it elsewhere. */
interface AgentDefaultLocaleChange {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly defaultLocale: string | null;
}

/** An agent about to be deleted: its row and everything it owns are still there. */
interface AgentDeletion {
  readonly workspaceId: string;
  readonly agentId: string;
}

export class AgentService {
  private readonly defaultLocaleListeners: Array<(change: AgentDefaultLocaleChange) => Promise<void>> = [];
  private readonly beforeDeleteListeners: Array<(agent: AgentDeletion) => Promise<void>> = [];

  constructor(
    private readonly agentRepository: AgentRepositoryPort,
    private readonly workspaceRepository: Pick<WorkspaceRepositoryPort, "findById" | "updateGeneralSettings">,
    private readonly documentSourceRepository?: Pick<
      DocumentSourceRepositoryPort,
      "findExistingIdsByWorkspaceId" | "countDocumentsWithoutSource"
    >,
    private readonly embedConfigCacheInvalidator?: EmbedConfigCacheInvalidator,
    private readonly accessGrantService?: AccessGrantService,
    private readonly agentSkills?: Pick<AgentSkillRepositoryPort, "findByName">,
    private readonly audit?: Pick<AuditService, "record">,
    private readonly recipientConfirmations?: RecipientConfirmationRequester,
  ) {}

  /**
   * Adds a listener called after any write (a save, a reviewed proposal, an import) changes an
   * agent's default locale. Not awaited: the write never waits on it, and a listener that rejects
   * is dropped, so a listener logs its own failures.
   */
  onDefaultLocaleChange(listener: (change: AgentDefaultLocaleChange) => Promise<void>): void {
    this.defaultLocaleListeners.push(listener);
  }

  /**
   * Adds a listener called once an agent's deletion is allowed and before its row goes, so what
   * the agent owns elsewhere can let go of it first. Every listener is awaited, together; one that
   * rejects never stops the others or the deletion, so a listener logs its own failures.
   */
  onBeforeDelete(listener: (agent: AgentDeletion) => Promise<void>): void {
    this.beforeDeleteListeners.push(listener);
  }

  async list(workspaceId: string): Promise<AgentSettingsResource[]> {
    const [workspace, agents] = await Promise.all([
      this.requireWorkspace(workspaceId),
      this.agentRepository.listByWorkspaceId(workspaceId),
    ]);
    const list = agents.length > 0 ? agents : [await this.ensureDefaultAgent(workspaceId)];
    const defaultAgentId = workspace.defaultAgentId ?? (agents.length === 0 ? list[0]?.id : null);
    return list.map((agent) => this.present(agent, defaultAgentId));
  }

  /** Lists persisted agents without bootstrapping or changing workspace state. */
  async listExisting(workspaceId: string): Promise<AgentSettingsResource[]> {
    const [workspace, agents] = await Promise.all([
      this.requireWorkspace(workspaceId),
      this.agentRepository.listByWorkspaceId(workspaceId),
    ]);
    return agents.map((agent) => this.present(agent, workspace.defaultAgentId));
  }

  async get(workspaceId: string, agentId: string): Promise<AgentSettingsResource> {
    const [workspace, agent] = await Promise.all([
      this.requireWorkspace(workspaceId),
      this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId),
    ]);
    if (!agent) {
      throw notFound("Agent not found");
    }
    return this.present(agent, workspace.defaultAgentId);
  }

  async resolve(workspaceId: string, agentId?: string | null): Promise<AgentRecord> {
    const withSkillBackedFlags = async (agent: AgentRecord): Promise<AgentRecord> => {
      const notifySkill = await this.agentSkills?.findByName(workspaceId, agent.id, "contact_human");
      if (notifySkill?.kind !== "notify") {
        return agent;
      }
      return {
        ...agent,
        contactRequestsEnabled: notifySkill.enabled,
        // Resolve delivery from the same source dispatch sends to, so the contact
        // gate doesn't hide a working notify-skill destination behind a stale
        // legacy contactRequestDelivery (or vice versa).
        contactRequestDelivery: resolveEffectiveContactDelivery(notifySkill, agent.contactRequestDelivery),
      };
    };
    if (agentId) {
      const agent = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
      if (!agent) {
        throw notFound("Agent not found");
      }
      return withSkillBackedFlags(agent);
    }
    return withSkillBackedFlags(await this.ensureDefaultAgent(workspaceId));
  }

  async create(workspaceId: string, input: AgentInput, options: { agentId?: string } = {}): Promise<AgentSettingsResource> {
    const workspace = await this.requireWorkspace(workspaceId);
    await this.validateSourceScope(workspaceId, input);
    const existingDefault = workspace.defaultAgentId
      ? await this.agentRepository.findByIdAndWorkspaceId(workspace.defaultAgentId, workspaceId)
      : await this.agentRepository.findDefaultByWorkspaceId(workspaceId);
    const agent = await this.agentRepository.create(workspaceId, input, options);
    await this.syncPublicLaunchGrants(null, agent);
    await this.recordRecipientChange(workspace, null, agent);
    if (!existingDefault) {
      await this.agentRepository.setDefault(workspaceId, agent.id);
    }
    return this.present(agent, existingDefault?.id ?? agent.id);
  }

  async update(workspaceId: string, agentId: string, input: AgentInput, options?: AgentUpdateOptions): Promise<AgentSettingsResource> {
    const workspace = await this.requireWorkspace(workspaceId);
    await this.validateSourceScope(workspaceId, input);
    const existing = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!existing) {
      throw notFound("Agent not found");
    }
    // Minting rides the same write that flips the flag, so a card can never be published for an
    // agent that has no id to publish it under. Every writer — the dashboard, a bundle import,
    // Ray's applied proposal — goes through here.
    const updated = await this.agentRepository.update(
      agentId,
      workspaceId,
      ensurePublicIdMintedForInput(existing, input),
      options,
    );
    await this.afterAgentWrite(workspace, existing, updated);
    return this.present(updated, workspace.defaultAgentId);
  }

  /**
   * Proposal/reviewed-operation write boundary. The repository owns the locked comparison and
   * merge; this service owns source validation and the side effects that every live agent write
   * must run. Infrastructure failures deliberately escape rather than becoming a false stale
   * result after the row has already committed.
   */
  async applyProposalPatch(
    workspaceId: string,
    agentId: string,
    input: AgentInput,
    guard: AgentProposalCasGuard,
  ): Promise<AgentProposalCasOutcome & { readonly followUp?: "side_effects_incomplete" }> {
    const workspace = await this.requireWorkspace(workspaceId);
    await this.validateSourceScope(workspaceId, input);
    const outcome = await this.agentRepository.applyProposalPatch(agentId, workspaceId, input, guard);
    if (outcome.outcome !== "applied") {
      return outcome;
    }
    try {
      await this.afterAgentWrite(workspace, outcome.previous, outcome.agent);
    } catch (error) {
      // The receipt hook ran in the owner's transaction. A best-effort side effect cannot turn a
      // committed reviewed mutation into an uncertain one.
      if (guard.onCommitted) return { ...outcome, followUp: "side_effects_incomplete" };
      throw error;
    }
    return outcome;
  }

  /** The agent owner validates, normalizes, and captures the exact field a proposal changes. */
  async prepareFieldProposal(
    workspaceId: string,
    agentId: string,
    input: { readonly settingKey: string; readonly value: unknown },
  ): Promise<AgentFieldProposalPreparation> {
    const current = await this.get(workspaceId, agentId);
    const patch = proposalSettingPatch(input.settingKey, input.value);
    const merged = {
      ...current,
      ...patch,
      surfaceSettings: patch.surfaceSettings
        ? mergeAgentSurfaceSettings(current.surfaceSettings, patch.surfaceSettings)
        : current.surfaceSettings,
    };
    const normalized = validateAgentInput(merged);
    if (!Object.hasOwn(normalized, input.settingKey)) {
      throw badRequest(`Unknown agent setting: ${input.settingKey}`);
    }
    const proposed = proposalSettingValue(normalized, input.settingKey);
    const previous = proposalSettingValue(current, input.settingKey);
    return {
      targetAgentId: agentId,
      normalizedPatch: proposalSettingPatch(input.settingKey, proposed),
      expected: { key: input.settingKey, value: previous },
      display: { current: previous, proposed },
    };
  }

  /** Prepares several reviewable settings as one owner-validated, field-fenced patch. */
  async prepareFieldsProposal(
    workspaceId: string,
    agentId: string,
    patch: AgentReviewedSettingsPatch,
  ): Promise<AgentFieldsProposalPreparation> {
    const requested = agentReviewedSettingsPatchSchema.parse(patch);
    const current = await this.get(workspaceId, agentId);
    const keys = Object.keys(requested) as AgentReviewedSettingsKey[];
    const normalized = validateAgentInput({ ...current, ...requested } as AgentInput);
    const changes = keys.flatMap((key) => {
      const currentValue = proposalSettingValue(current, key);
      const proposed = proposalSettingValue(normalized, key);
      return sameSettingValue(currentValue, proposed)
        ? []
        : [{ key, current: currentValue, proposed, ...agentSettingProposalEffect(key) }];
    });
    if (changes.length === 0) throw badRequest("The agent settings already hold these values");
    return {
      targetAgentId: agentId,
      agentName: current.name,
      normalizedPatch: Object.fromEntries(changes.map((change) => [change.key, change.proposed])),
      expectedFields: changes.map((change) => ({ key: change.key, value: change.current })),
      changes,
      unchanged: keys.filter((key) => !changes.some((change) => change.key === key)),
      effect: { exposure: changes.some((change) => change.lifecycle === "live") ? "live" : "draft", reversibility: "reversible", metered: false },
    };
  }

  async readFieldProposalVersion(
    workspaceId: string,
    agentId: string,
    expected?: { readonly key: string } | { readonly keys: readonly string[] },
  ): Promise<string> {
    const current = await this.get(workspaceId, agentId);
    if (!expected) return current.updatedAt.toISOString();
    // Validate the key on every entry point, including legacy-card preview/read paths.
    const keys = "key" in expected ? [expected.key] : expected.keys;
    for (const key of keys) proposalSettingPatch(key, proposalSettingValue(current, key));
    return fieldProposalVersion(Object.fromEntries(keys.map((key) => [key, proposalSettingValue(current, key)])));
  }

  async readFieldProposalDisplay(workspaceId: string, agentId: string, settingKey: string): Promise<unknown> {
    const current = await this.get(workspaceId, agentId);
    proposalSettingPatch(settingKey, proposalSettingValue(current, settingKey));
    return proposalSettingValue(current, settingKey);
  }

  /** Applies a prepared single-field proposal through the agent repository's locked CAS. */
  async applyFieldProposal(
    workspaceId: string,
    prepared: AgentFieldProposalApplyInput,
    options?: { readonly onCommitted?: OwnerCommitHook<{ readonly agentId: string }> },
  ): Promise<AgentFieldProposalApplyOutcome> {
    const entries = Object.entries(prepared.normalizedPatch);
    if (entries.length !== 1 && !("expectedFields" in prepared)) {
      throw badRequest("An agent field proposal must name exactly one setting");
    }
    if (entries.length === 0) throw badRequest("An agent field proposal must name at least one setting");
    const normalizedPatch = "expectedFields" in prepared
      ? agentReviewedSettingsPatchSchema.parse(prepared.normalizedPatch) as AgentInput
      : proposalSettingPatch(entries[0][0], entries[0][1]);
    if ("expectedFields" in prepared) {
      const patchKeys = Object.keys(normalizedPatch).sort();
      const expectedKeys = prepared.expectedFields.map((field) => field.key).sort();
      if (patchKeys.join("\u0000") !== expectedKeys.join("\u0000")) {
        throw badRequest("An agent field proposal must fence exactly the settings it changes");
      }
    }
    const guard = "expected" in prepared
      ? { expectedFields: [prepared.expected] }
      : "expectedFields" in prepared
        ? { expectedFields: prepared.expectedFields }
        : { expectedUpdatedAt: prepared.expectedUpdatedAt };
    const outcome = await this.applyProposalPatch(
      workspaceId,
      prepared.targetAgentId,
      normalizedPatch,
      { ...guard, ...(options?.onCommitted ? { onCommitted: options.onCommitted } : {}) },
    );
    if (outcome.outcome === "applied") return { status: "applied", ...(outcome.followUp ? { followUp: outcome.followUp } : {}) };
    if (outcome.outcome === "targetDeleted") return { status: "target_deleted" };
    if (outcome.outcome === "changed" && outcome.fields.includes("target")) return { status: "target_changed" };
    return { status: "changed", fields: outcome.fields };
  }

  /**
   * Writes exact greeting content onto the agent draft (spec 1150 Slice A, FR-002/FR-007).
   * Unlike `update`, this never touches the live `agents` row — see
   * `AgentRepository#updateDraftGreeting`.
   *
   * Validation always runs when content is authored, so an operator always sees field-level
   * diagnostics for what they typed, but it only *blocks* the save when Exact words is the
   * selected mode: FR-007 requires valid complete content before Exact words can be
   * selected, but lets inactive (Automatic/Off) content stay saved-but-incomplete so a
   * half-finished draft is never silently discarded. Candidate creation and publish
   * (`assertCandidateSnapshotIsRunnable`) re-validate independently before either turns
   * this draft into something a conversation can use.
   */
  async updateDraftGreeting(
    workspaceId: string,
    agentId: string,
    input: AgentGreetingSnapshot,
    options?: AgentGreetingUpdateOptions,
  ): Promise<{ greeting: AgentGreetingSnapshot; validation: ExactContentValidationResult }> {
    const agent = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
    const validation: ExactContentValidationResult = input.exactContent
      ? validateExactContentItem(input.exactContent, {
          agentDefaultLocale: agent.assistantDefaultLocale ?? DEFAULT_AGENT_LOCALE_FALLBACK,
          // Bootstrap supplies no context variables and the greeting has no routine slots
          // (spec 1150 F4): every `{{…}}` in greeting content is unknown.
          availableReferenceKeys: new Set(),
        })
      : { ok: true };
    if (input.exactWordsEnabled && !validation.ok) {
      throw badRequest("Exact greeting content is invalid", { issues: validation.issues });
    }
    // Forwarded only when a caller actually supplies it (Ray's proposal apply); the dashboard's
    // own draft route passes none, keeping the 3-argument call every other draft field's
    // last-write-wins write already makes here.
    const greeting = options
      ? await this.agentRepository.updateDraftGreeting(agentId, workspaceId, input, options)
      : await this.agentRepository.updateDraftGreeting(agentId, workspaceId, input);
    return { greeting, validation };
  }

  /**
   * `allowLastAgent` exists for one caller: undoing a create that failed part-way.
   * The last-agent rule protects an operator from removing the only assistant their
   * workspace has; it must not strand an agent the operator never had, which is what
   * happens when a bundle import creates a workspace's first agent and then fails.
   */
  async delete(
    workspaceId: string,
    agentId: string,
    options: { allowLastAgent?: boolean } = {},
  ): Promise<void> {
    const workspace = await this.requireWorkspace(workspaceId);
    const agent = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }

    const total = await this.agentRepository.countByWorkspaceId(workspaceId);
    if (total <= 1 && options.allowLastAgent !== true) {
      throw badRequest("Cannot delete the last agent in this workspace");
    }

    await Promise.allSettled(this.beforeDeleteListeners.map(async (listener) => listener({ workspaceId, agentId })));
    await this.agentRepository.deleteByIdAndWorkspaceId(agentId, workspaceId);

    if (workspace.defaultAgentId === agentId) {
      const remaining = await this.agentRepository.listByWorkspaceId(workspaceId);
      const nextDefault = remaining[0];
      if (nextDefault) {
        await this.agentRepository.setDefault(workspaceId, nextDefault.id);
        await this.syncLegacyWorkspaceDefaults(workspace, nextDefault);
      }
    }
  }

  async setDefault(workspaceId: string, agentId: string): Promise<AgentSettingsResource> {
    const workspace = await this.requireWorkspace(workspaceId);
    const agent = await this.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
    await this.agentRepository.setDefault(workspaceId, agentId);
    await this.syncLegacyWorkspaceDefaults(workspace, agent);
    return this.present(agent, agentId);
  }

  async ensureDefaultAgent(workspaceId: string): Promise<AgentRecord> {
    const workspace = await this.requireWorkspace(workspaceId);
    const existing = await this.agentRepository.findDefaultByWorkspaceId(workspaceId);
    if (existing) {
      return existing;
    }
    const agent = await this.agentRepository.create(workspaceId, {
      name: workspace.assistantName ?? "",
      retrievalEnabled: true,
      sourceScope: { mode: "all" },
      greetingInstruction: workspace.greetingInstruction,
      assistantDefaultLocale: workspace.assistantDefaultLocale,
      proactiveGreetingEnabled: workspace.proactiveGreetingEnabled,
      surfaceSettings: {
        authenticatedChat: {
          enabled: true,
        },
        anonymousChat: {
          enabled: workspace.anonymousChatEnabled,
          token: workspace.anonymousChatToken,
        },
        websiteEmbed: {
          enabled: workspace.websiteEmbedEnabled,
          token: workspace.websiteEmbedToken,
          allowedOrigins: workspace.websiteEmbedAllowedOrigins,
          launcherLabel: workspace.websiteEmbedLauncherLabel,
          launcherPosition: workspace.websiteEmbedLauncherPosition,
        },
      },
    });
    await this.syncPublicLaunchGrants(null, agent);
    await this.agentRepository.setDefault(workspaceId, agent.id);
    return agent;
  }

  present(agent: AgentRecord, defaultAgentId?: string | null): AgentSettingsResource {
    const { authoredDirectives: _authoredDirectives, ...publicAgent } = agent;
    return {
      ...publicAgent,
      isDefault: defaultAgentId === agent.id,
      assistantBootstrapActive: isAgentBootstrapActive(agent),
    };
  }

  withRotatedTokens(agent: AgentRecord, input: AgentInput & {
    rotateAnonymousChatToken?: boolean;
    rotateWebsiteEmbedToken?: boolean;
  }): AgentInput {
    const inputSurfaceSettings = input.surfaceSettings ?? {};
    const currentAnonymousChat = agent.surfaceSettings.anonymousChat;
    const currentWebsiteEmbed = agent.surfaceSettings.websiteEmbed;
    const anonymousChatEnabled = inputSurfaceSettings.anonymousChat?.enabled ?? currentAnonymousChat.enabled;
    const websiteEmbedEnabled = inputSurfaceSettings.websiteEmbed?.enabled ?? currentWebsiteEmbed.enabled;
    const publicChatTokenRequired = anonymousChatEnabled || websiteEmbedEnabled;
    const anonymousChatToken = input.rotateAnonymousChatToken
      ? generateApiToken()
      : inputSurfaceSettings.anonymousChat?.token !== undefined
        ? inputSurfaceSettings.anonymousChat.token
        : publicChatTokenRequired && !currentAnonymousChat.token
          ? generateApiToken()
          : currentAnonymousChat.token;
    const websiteEmbedToken = input.rotateWebsiteEmbedToken
      ? generateApiToken()
      : inputSurfaceSettings.websiteEmbed?.token !== undefined
        ? inputSurfaceSettings.websiteEmbed.token
        : websiteEmbedEnabled && !currentWebsiteEmbed.token
          ? generateApiToken()
          : currentWebsiteEmbed.token;

    return {
      ...input,
      surfaceSettings: {
        ...inputSurfaceSettings,
        anonymousChat: {
          ...inputSurfaceSettings.anonymousChat,
          enabled: anonymousChatEnabled,
          token: anonymousChatToken,
        },
        websiteEmbed: {
          ...inputSurfaceSettings.websiteEmbed,
          enabled: websiteEmbedEnabled,
          token: websiteEmbedToken,
        },
      },
    };
  }

  private async requireWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (!workspace) {
      throw notFound("Workspace not found");
    }
    return workspace;
  }

  private async afterAgentWrite(
    workspace: WorkspaceRecord,
    previous: AgentRecord,
    updated: AgentRecord,
  ): Promise<void> {
    await this.syncPublicLaunchGrants(previous, updated);
    await this.recordRecipientChange(workspace, previous, updated);
    if (workspace.defaultAgentId === updated.id) {
      await this.syncLegacyWorkspaceDefaults(workspace, updated);
    }
    // Drop the CDN-cached embed config so settings changes take effect now
    // rather than after the cache TTL. Best effort — the invalidator never
    // throws, and most deployments wire the no-op.
    const embedToken = getWebsiteEmbedSurfaceSettings(updated).token;
    if (embedToken && this.embedConfigCacheInvalidator) {
      await this.embedConfigCacheInvalidator.invalidateForToken(embedToken);
    }
    if (previous.assistantDefaultLocale !== updated.assistantDefaultLocale) {
      const change = { workspaceId: workspace.id, agentId: updated.id, defaultLocale: updated.assistantDefaultLocale };
      for (const listener of this.defaultLocaleListeners) void Promise.resolve().then(() => listener(change)).catch(() => undefined);
    }
  }

  /**
   * Drops the CDN-cached embed config of every agent in the workspace, for a change outside the
   * agents that the config still reflects: the voice vendor key whose presence decides whether the
   * embed offers calls. Best effort, like every invalidation here.
   */
  async invalidateEmbedConfigs(workspaceId: string): Promise<void> {
    if (!this.embedConfigCacheInvalidator) return;
    const agents = await this.agentRepository.listByWorkspaceId(workspaceId);
    for (const agent of agents) {
      const embedToken = getWebsiteEmbedSurfaceSettings(agent).token;
      if (embedToken) await this.embedConfigCacheInvalidator.invalidateForToken(embedToken);
    }
  }

  private async recordRecipientChange(
    workspace: WorkspaceRecord,
    previous: AgentRecord | null,
    updated: AgentRecord,
  ): Promise<void> {
    const previousRecipients = previous?.contactRequestDelivery.recipientEmails ?? [];
    const metadata = recipientEmailChangeMetadata(previousRecipients, updated.contactRequestDelivery.recipientEmails);
    if (!metadata) return;
    await this.audit?.record({
      accountId: workspace.accountId,
      workspaceId: workspace.id,
      eventType: "agent.contact_recipients.changed",
      eventStatus: "success",
      metadata: { agentId: updated.id, ...metadata },
    });
    await requestAddedRecipientConfirmations(this.recipientConfirmations, {
      workspaceId: workspace.id,
      agentId: updated.id,
      previous: previousRecipients,
      next: updated.contactRequestDelivery.recipientEmails,
    });
  }

  private async validateSourceScope(workspaceId: string, input: AgentInput): Promise<void> {
    if (input.sourceScope?.mode !== "selected") {
      return;
    }
    if (!this.documentSourceRepository) {
      throw badRequest("Document sources are not configured");
    }
    const sourceIds = input.sourceScope.sourceIds;
    const hasManualSourceIds = sourceIds.includes(MANUALLY_ADDED_DOCUMENTS_SOURCE_ID);
    const sourceIdsToValidate = sourceIds.filter((sourceId) => sourceId !== MANUALLY_ADDED_DOCUMENTS_SOURCE_ID);

    if (sourceIdsToValidate.length === 0 && !hasManualSourceIds) {
      return;
    }

    const existingIds = new Set(await this.documentSourceRepository.findExistingIdsByWorkspaceId(workspaceId, sourceIdsToValidate));
    const missingSourceId = sourceIdsToValidate.find((sourceId) => !existingIds.has(sourceId));
    if (missingSourceId) {
      throw badRequest("sourceScope.sourceIds contains a source that does not belong to this workspace");
    }

    if (!hasManualSourceIds) {
      return;
    }

    const documentsWithoutSourceCount = await this.documentSourceRepository.countDocumentsWithoutSource(workspaceId);
    if (documentsWithoutSourceCount === 0) {
      throw badRequest("sourceScope.sourceIds contains a source that does not belong to this workspace");
    }
  }

  private async syncLegacyWorkspaceDefaults(workspace: WorkspaceRecord, agent: AgentRecord): Promise<void> {
    const websiteEmbed = getWebsiteEmbedSurfaceSettings(agent);
    await this.workspaceRepository.updateGeneralSettings(workspace.id, {
      anonymousChatEnabled: agent.surfaceSettings.anonymousChat.enabled,
      anonymousChatToken: agent.surfaceSettings.anonymousChat.token,
      assistantName: agent.name,
      greetingInstruction: agent.greetingInstruction,
      assistantDefaultLocale: agent.assistantDefaultLocale,
      proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
      websiteEmbedEnabled: websiteEmbed.enabled,
      websiteEmbedToken: websiteEmbed.token,
      websiteEmbedAllowedOrigins: websiteEmbed.allowedOrigins,
      websiteEmbedLauncherLabel: websiteEmbed.launcherLabel,
      websiteEmbedLauncherPosition: websiteEmbed.launcherPosition,
    });
  }

  private async syncPublicLaunchGrants(previous: AgentRecord | null, current: AgentRecord): Promise<void> {
    if (!this.accessGrantService) {
      return;
    }

    await this.syncPublicLaunchGrant({
      previousToken: previous?.surfaceSettings.anonymousChat.token ?? null,
      currentToken: current.surfaceSettings.anonymousChat.token,
      workspaceId: current.workspaceId,
      agentId: current.id,
      label: "anonymous-chat",
      originConstraint: { mode: "allow-all", origins: [] },
    });

    const previousWebsiteEmbed = previous ? getWebsiteEmbedSurfaceSettings(previous) : null;
    const currentWebsiteEmbed = getWebsiteEmbedSurfaceSettings(current);
    await this.syncPublicLaunchGrant({
      previousToken: previousWebsiteEmbed?.token ?? null,
      currentToken: currentWebsiteEmbed.token,
      workspaceId: current.workspaceId,
      agentId: current.id,
      label: "website-embed",
      originConstraint: currentWebsiteEmbed.allowedOrigins.includes("*")
        ? { mode: "allow-all", origins: [] }
        : { mode: "list", origins: currentWebsiteEmbed.allowedOrigins },
    });
  }

  private async syncPublicLaunchGrant(input: {
    previousToken: string | null;
    currentToken: string | null;
    workspaceId: string;
    agentId: string;
    label: string;
    originConstraint: { mode: "allow-all"; origins: [] } | { mode: "list"; origins: string[] };
  }): Promise<void> {
    if (!this.accessGrantService || !input.currentToken) {
      return;
    }

    if (input.previousToken && input.previousToken !== input.currentToken) {
      const previousGrant = await this.accessGrantService.resolvePublicLaunchGrant(input.previousToken);
      if (previousGrant) {
        await this.accessGrantService.revokeGrant({
          grantId: previousGrant.id,
          reason: "surface_token_rotated",
        });
      }
    }

    const grant = await this.accessGrantService.resolveOrCreatePublicLaunchGrant({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      label: input.label,
      token: input.currentToken,
      originConstraint: input.originConstraint,
    });
    if (!grant.revokedAt) {
      await this.accessGrantService.updateGrantConstraints({
        grantId: grant.id,
        label: input.label,
        originConstraint: input.originConstraint,
        enabled: true,
      });
    }
  }
}
