import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AccessGrantService } from "../../accessGrants/public.js";
import type { AgentRecord, AgentService } from "../../agents/public.js";
import { getWebsiteEmbedSurfaceSettings, isAgentBootstrapActive } from "../../agents/public.js";
import { buildAssistantLogoCacheKey, buildOperatorAssistantLogoUrl } from "../../../app/http/shared/assistantLogoUrl.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { AppError, badRequest, notFound } from "../../../shared/domain/errors.js";
import { fieldProposalVersion } from "../../../shared/domain/fieldProposalVersion.js";
import { validateWebsiteEmbedSettings } from "../domain/websiteEmbedSettings.js";
import {
  DefaultWebsiteEmbedIntegrationProvider,
  type WebsiteEmbedIntegrationProvider,
} from "../domain/websiteEmbedIntegration.js";
import type {
  PlatformChannelsSettingsSection,
  PlatformSettingsPatch,
  PlatformSettingsResource,
} from "../domain/platformSettings.js";
import { resolvePublicLaunchLifecycle } from "../../accessGrants/public.js";
import type {
  PlatformSettingsFieldProposalApplyInput,
  PlatformSettingsFieldProposalApplyOutcome,
  PlatformSettingsFieldProposalPreparation,
  PlatformSettingsProposalPatch,
} from "../contracts/services.js";

const platformSettingsProposalFields = [
  "assistantName", "greetingInstruction", "assistantDefaultLocale", "proactiveGreetingEnabled",
  "suggestedQuestionsEnabled", "customInstruction", "anonymousChatEnabled", "websiteEmbedEnabled",
  "websiteEmbedAllowedOrigins", "websiteEmbedLauncherLabel", "websiteEmbedLauncherPosition",
] as const;
/** Internal agent-row CAS outcome; distinct from the copilot-facing `PlatformSettingsFieldProposalApplyOutcome`. */
type PlatformSettingsProposalApplyOutcome =
  | { readonly outcome: "applied" }
  | { readonly outcome: "changed"; readonly fields: readonly string[] }
  | { readonly outcome: "targetChanged" }
  | { readonly outcome: "targetDeleted" };

const platformProposalSurface = (settings: PlatformSettingsResource): Record<string, unknown> => ({
  assistantName: settings.assistant.assistantName,
  greetingInstruction: settings.assistant.greetingInstruction,
  assistantDefaultLocale: settings.assistant.assistantDefaultLocale,
  proactiveGreetingEnabled: settings.assistant.proactiveGreetingEnabled,
  suggestedQuestionsEnabled: settings.assistant.suggestedQuestionsEnabled,
  customInstruction: settings.assistant.customInstruction,
  anonymousChatEnabled: settings.channels.anonymousChatEnabled,
  websiteEmbedEnabled: settings.channels.websiteEmbedEnabled,
  websiteEmbedAllowedOrigins: [...settings.channels.websiteEmbedAllowedOrigins],
  websiteEmbedLauncherLabel: settings.channels.websiteEmbedLauncherLabel,
  websiteEmbedLauncherPosition: settings.channels.websiteEmbedLauncherPosition,
});

const sameProposalValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

interface PlatformSettingsServiceDependencies {
  workspaceRepository: Pick<WorkspaceRepositoryPort, "findById">;
  agentService: Pick<AgentService, "resolve" | "update" | "applyProposalPatch" | "withRotatedTokens">;
  accessGrantService?: Pick<AccessGrantService, "resolvePublicLaunchGrant">;
  auditService?: Pick<AuditService, "record">;
  logger?: Pick<AppLogger, "warn">;
  publicChatBaseUrl?: string;
  websiteEmbedIntegration?: WebsiteEmbedIntegrationProvider;
}

interface PlatformSettingsUpdateContext {
  accountId?: string | null;
  /** Prefix added by the frontend proxy, so browser image requests reach the backend. */
  forwardedPrefix?: string | null;
  /**
   * The version the caller decided against. Passed through to the agent write's own predicate so a
   * surface edited since then is refused rather than replaced wholesale — the copilot drafts a
   * whole-object proposal ahead of the operator's Apply, and without this a concurrent dashboard
   * edit would be silently overwritten by values drafted before it.
   */
  expectedUpdatedAt?: Date;
}

interface PlatformSettingsReadContext {
  /** Prefix added by the frontend proxy, so browser image requests reach the backend. */
  forwardedPrefix?: string | null;
}

/** The settings plus the version a conditional write can be predicated on, read in one pass. */
interface VersionedPlatformSettings {
  settings: PlatformSettingsResource;
  updatedAt: Date;
}

export class PlatformSettingsService {
  constructor(private readonly dependencies: PlatformSettingsServiceDependencies) {}

  private get websiteEmbedIntegration(): WebsiteEmbedIntegrationProvider {
    return this.dependencies.websiteEmbedIntegration
      ?? new DefaultWebsiteEmbedIntegrationProvider();
  }

  async getForWorkspace(
    workspaceId: string,
    context: PlatformSettingsReadContext = {},
  ): Promise<PlatformSettingsResource> {
    const workspace = await this.dependencies.workspaceRepository.findById(workspaceId);

    if (!workspace) {
      throw notFound("Workspace not found");
    }
    const agent = await this.dependencies.agentService.resolve(workspaceId);

    return {
      assistant: this.buildAssistantSection(agent, context.forwardedPrefix),
      channels: await this.buildChannelsSection(agent, workspace),
    };
  }

  /**
   * Deliberately one read: pairing values from one read with a version from a later one would let
   * an edit landing between them pass a version check it should have failed.
   */
  async getVersionedForWorkspace(
    workspaceId: string,
    context: PlatformSettingsReadContext = {},
  ): Promise<VersionedPlatformSettings> {
    const workspace = await this.dependencies.workspaceRepository.findById(workspaceId);

    if (!workspace) {
      throw notFound("Workspace not found");
    }
    const agent = await this.dependencies.agentService.resolve(workspaceId);

    return {
      settings: {
        assistant: this.buildAssistantSection(agent, context.forwardedPrefix),
        channels: await this.buildChannelsSection(agent, workspace),
      },
      updatedAt: agent.updatedAt,
    };
  }

  async updateForWorkspace(
    workspaceId: string,
    patch: PlatformSettingsPatch,
    context: PlatformSettingsUpdateContext = {},
  ): Promise<PlatformSettingsResource> {
    const { agent, workspace } = await this.writeForWorkspace(workspaceId, patch, context);

    return {
      assistant: this.buildAssistantSection(agent, context.forwardedPrefix),
      channels: await this.buildChannelsSection(agent, workspace),
    };
  }

  /**
   * The write on its own, for a caller that records an outcome rather than rendering one.
   *
   * Presenting the result reads the public launch grants — a second round trip, after the agent
   * write has committed. A caller rendering a page can fail there and be reloaded; a caller
   * recording whether the change happened would store "failed" for a channel that is already open,
   * and invite the operator to make the change twice.
   */
  async applyForWorkspace(
    workspaceId: string,
    patch: PlatformSettingsPatch,
    context: PlatformSettingsUpdateContext = {},
  ): Promise<void> {
    await this.writeForWorkspace(workspaceId, patch, context);
  }

  /**
   * The platform-settings proposal boundary owns normalization, field diffs, and the draft-time
   * values that its conditional write compares. Copilot only persists this prepared result.
   */
  async prepareFieldProposal(
    workspaceId: string,
    patch: PlatformSettingsProposalPatch,
  ): Promise<PlatformSettingsFieldProposalPreparation> {
    if (Object.values(patch).every((value) => value === undefined)) {
      throw badRequest("Name at least one workspace setting to change");
    }
    const { settings } = await this.getVersionedForWorkspace(workspaceId);
    const current = platformProposalSurface(settings);
    const named = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    let embed;
    try {
      embed = validateWebsiteEmbedSettings({
        websiteEmbedEnabled: (named.websiteEmbedEnabled as boolean | undefined) ?? current.websiteEmbedEnabled as boolean,
        websiteEmbedAllowedOrigins: (named.websiteEmbedAllowedOrigins as string[] | undefined) ?? current.websiteEmbedAllowedOrigins as string[],
        websiteEmbedLauncherLabel: (named.websiteEmbedLauncherLabel as string | undefined) ?? current.websiteEmbedLauncherLabel as string,
        websiteEmbedLauncherPosition: (named.websiteEmbedLauncherPosition as AgentRecord["surfaceSettings"]["websiteEmbed"]["launcherPosition"] | undefined) ?? current.websiteEmbedLauncherPosition as AgentRecord["surfaceSettings"]["websiteEmbed"]["launcherPosition"],
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The proposed embed settings are not valid";
      const embedFields = ["websiteEmbedEnabled", "websiteEmbedAllowedOrigins", "websiteEmbedLauncherLabel", "websiteEmbedLauncherPosition"];
      throw badRequest(embedFields.some((field) => field in named)
        ? reason
        : `The workspace's stored website embed settings block any settings change until they are fixed: ${reason}`);
    }
    const normalized = {
      ...current,
      ...named,
      websiteEmbedEnabled: embed.websiteEmbedEnabled,
      websiteEmbedAllowedOrigins: embed.websiteEmbedAllowedOrigins,
      websiteEmbedLauncherLabel: embed.websiteEmbedLauncherLabel,
      websiteEmbedLauncherPosition: embed.websiteEmbedLauncherPosition,
    } as PlatformSettingsProposalPatch;
    const changed = platformSettingsProposalFields.filter((field) => !sameProposalValue(current[field], normalized[field]));
    if (changed.length === 0) {
      throw badRequest("The workspace settings already hold these values");
    }
    const expected = Object.fromEntries(changed.map((field) => [field, current[field]])) as PlatformSettingsProposalPatch;
    return {
      normalizedPatch: normalized,
      expected,
      display: {
        current,
        proposed: normalized,
        changesReach: changed.some((field) => ["anonymousChatEnabled", "websiteEmbedEnabled", "websiteEmbedAllowedOrigins"].includes(field)),
      },
    };
  }

  async readFieldProposalVersion(
    workspaceId: string,
    expected?: PlatformSettingsProposalPatch,
  ): Promise<string> {
    const { settings, updatedAt } = await this.getVersionedForWorkspace(workspaceId);
    if (!expected) return updatedAt.toISOString();
    const current = platformProposalSurface(settings);
    return fieldProposalVersion(Object.fromEntries(Object.keys(expected).map((field) => [field, current[field]])));
  }

  async readFieldProposalDisplay(workspaceId: string): Promise<Record<string, unknown>> {
    const { settings } = await this.getVersionedForWorkspace(workspaceId);
    return platformProposalSurface(settings);
  }

  /** Applies a prepared proposal through the owner's locked CAS and post-write side effects. */
  async applyFieldProposal(
    workspaceId: string,
    prepared: PlatformSettingsFieldProposalApplyInput,
  ): Promise<PlatformSettingsFieldProposalApplyOutcome> {
    const patch = "expected" in prepared
      ? Object.fromEntries(Object.keys(prepared.expected).map((field) => [field, prepared.normalizedPatch[field as keyof PlatformSettingsProposalPatch]])) as PlatformSettingsProposalPatch
      : prepared.normalizedPatch;
    let outcome: PlatformSettingsProposalApplyOutcome;
    try {
      outcome = await this.applyProposalPatch({ workspaceId, patch, ...("expected" in prepared
        ? { expected: prepared.expected }
        : { expectedUpdatedAt: prepared.expectedUpdatedAt }) });
    } catch (error) {
      // AgentService runs its follow-up effects after the row commit. Confirming the narrowly
      // prepared surface here prevents a retry from duplicating a write that is already live.
      const actual = await this.readFieldProposalDisplay(workspaceId).catch(() => null);
      const proposed = Object.fromEntries(Object.keys(patch).map((field) => [field, prepared.normalizedPatch[field as keyof PlatformSettingsProposalPatch]]));
      if (actual && Object.entries(proposed).every(([field, value]) => sameProposalValue(actual[field], value))) {
        const reason = error instanceof Error ? error.message : "Workspace settings apply did not finish cleanly";
        return { status: "applied", reason: `The workspace settings now hold the proposed values, but the apply did not finish cleanly: ${reason}` };
      }
      throw error;
    }
    if (outcome.outcome === "applied") return { status: "applied" };
    if (outcome.outcome === "targetDeleted") return { status: "target_deleted" };
    if (outcome.outcome === "targetChanged") return { status: "target_changed" };
    return { status: "changed", fields: outcome.fields };
  }

  /** Owner-side field CAS used by both copilot proposals and reviewed operations. */
  async applyProposalPatch(input: {
    readonly workspaceId: string;
    readonly patch: PlatformSettingsProposalPatch;
  } & (
    | { readonly expected: PlatformSettingsProposalPatch }
    | { readonly expectedUpdatedAt: Date }
  )): Promise<PlatformSettingsProposalApplyOutcome> {
    const workspace = await this.dependencies.workspaceRepository.findById(input.workspaceId);
    if (!workspace) return { outcome: "targetDeleted" };
    let agent: AgentRecord;
    try {
      agent = await this.dependencies.agentService.resolve(input.workspaceId);
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") return { outcome: "targetDeleted" };
      throw error;
    }
    const agentInputForPatch = (patch: PlatformSettingsProposalPatch, current?: AgentRecord) => {
      const website = current?.surfaceSettings.websiteEmbed;
      const normalizedWebsite = website && (patch.websiteEmbedEnabled !== undefined || patch.websiteEmbedAllowedOrigins !== undefined || patch.websiteEmbedLauncherLabel !== undefined || patch.websiteEmbedLauncherPosition !== undefined)
        ? validateWebsiteEmbedSettings({
            websiteEmbedEnabled: patch.websiteEmbedEnabled ?? website.enabled,
            websiteEmbedToken: website.token,
            websiteEmbedAllowedOrigins: patch.websiteEmbedAllowedOrigins ?? website.allowedOrigins,
            websiteEmbedLauncherLabel: patch.websiteEmbedLauncherLabel ?? website.launcherLabel,
            websiteEmbedLauncherPosition: patch.websiteEmbedLauncherPosition ?? website.launcherPosition,
            websiteEmbedTheme: website.theme,
            websiteEmbedCopy: website.copy,
            websiteEmbedExpertOverrides: website.expertOverrides,
          })
        : null;
      const surfaceSettings = {
      ...(patch.anonymousChatEnabled === undefined ? {} : { anonymousChat: { enabled: patch.anonymousChatEnabled } }),
      ...(patch.websiteEmbedEnabled === undefined && patch.websiteEmbedAllowedOrigins === undefined && patch.websiteEmbedLauncherLabel === undefined && patch.websiteEmbedLauncherPosition === undefined ? {} : {
        websiteEmbed: {
          enabled: normalizedWebsite?.websiteEmbedEnabled ?? patch.websiteEmbedEnabled,
          allowedOrigins: normalizedWebsite?.websiteEmbedAllowedOrigins ?? patch.websiteEmbedAllowedOrigins,
          launcherLabel: normalizedWebsite?.websiteEmbedLauncherLabel ?? patch.websiteEmbedLauncherLabel,
          launcherPosition: normalizedWebsite?.websiteEmbedLauncherPosition ?? patch.websiteEmbedLauncherPosition,
        },
      }),
      };
      return {
        ...(patch.assistantName === undefined ? {} : { name: patch.assistantName }),
        ...(patch.greetingInstruction === undefined ? {} : { greetingInstruction: patch.greetingInstruction }),
        ...(patch.assistantDefaultLocale === undefined ? {} : { assistantDefaultLocale: patch.assistantDefaultLocale }),
        ...(patch.proactiveGreetingEnabled === undefined ? {} : { proactiveGreetingEnabled: patch.proactiveGreetingEnabled }),
        ...(patch.suggestedQuestionsEnabled === undefined ? {} : { suggestedQuestionsEnabled: patch.suggestedQuestionsEnabled }),
        ...(patch.customInstruction === undefined ? {} : { customInstruction: patch.customInstruction }),
        ...(Object.keys(surfaceSettings).length ? { surfaceSettings } : {}),
      };
    };
    const patch = input.patch;
    const outcome = await this.dependencies.agentService.applyProposalPatch(input.workspaceId, agent.id, {
        ...agentInputForPatch(patch),
      }, "expected" in input
        ? { expectedFields: Object.entries(input.expected).map(([key, value]) => ({ key: key === "assistantName" ? "name" : key, value })), expectedDefaultAgentId: agent.id, normalizeLocked: (current) => agentInputForPatch(patch, current) }
        : { expectedUpdatedAt: input.expectedUpdatedAt, expectedDefaultAgentId: agent.id, normalizeLocked: (current) => agentInputForPatch(patch, current) });
    if (outcome.outcome === "targetDeleted") return outcome;
    if (outcome.outcome === "changed") {
      if (outcome.fields.includes("target")) {
        return { outcome: "targetChanged" };
      }
      return {
        outcome: "changed",
        fields: outcome.fields.filter((field) => platformSettingsProposalFields.includes(field as never)),
      };
    }
    await this.recordChannelAuditEvents({
      accountId: workspace.accountId,
      workspaceId: input.workspaceId,
      previousAgent: outcome.previous,
      anonymousChatEnabled: outcome.agent.surfaceSettings.anonymousChat.enabled,
      rotateAnonymousChatToken: false,
      websiteEmbedEnabled: outcome.agent.surfaceSettings.websiteEmbed.enabled,
      websiteEmbedAllowedOrigins: outcome.agent.surfaceSettings.websiteEmbed.allowedOrigins,
      websiteEmbedLauncherPosition: outcome.agent.surfaceSettings.websiteEmbed.launcherPosition,
      rotateWebsiteEmbedToken: false,
    });
    return { outcome: "applied" };
  }

  private async writeForWorkspace(
    workspaceId: string,
    patch: PlatformSettingsPatch,
    context: PlatformSettingsUpdateContext,
  ): Promise<{ agent: AgentRecord; workspace: WorkspaceRecord }> {
    const workspace = await this.dependencies.workspaceRepository.findById(workspaceId);

    if (!workspace) {
      throw notFound("Workspace not found");
    }

    let currentAgent = await this.dependencies.agentService.resolve(workspaceId);

    if (patch.assistant || patch.channels) {
      currentAgent = await this.updateAgentSections(workspaceId, currentAgent, workspace, patch, context);
    }

    return { agent: currentAgent, workspace };
  }

  private async updateAgentSections(
    workspaceId: string,
    agent: AgentRecord,
    _workspace: WorkspaceRecord,
    patch: PlatformSettingsPatch,
    context: PlatformSettingsUpdateContext,
  ): Promise<AgentRecord> {
    const channels = patch.channels ?? {};
    const assistant = patch.assistant ?? {};
    const anonymousChat = agent.surfaceSettings.anonymousChat;
    const websiteEmbed = agent.surfaceSettings.websiteEmbed;
    const anonymousChatEnabled = channels.anonymousChatEnabled ?? anonymousChat.enabled;
    const rotateAnonymousChatToken = channels.rotateAnonymousChatToken;
    const rotateWebsiteEmbedToken = channels.rotateWebsiteEmbedToken;

    let normalizedWebsiteEmbed;
    try {
      normalizedWebsiteEmbed = validateWebsiteEmbedSettings({
        websiteEmbedEnabled: channels.websiteEmbedEnabled ?? websiteEmbed.enabled,
        websiteEmbedToken: websiteEmbed.token,
        websiteEmbedAllowedOrigins: channels.websiteEmbedAllowedOrigins ?? websiteEmbed.allowedOrigins,
        websiteEmbedLauncherLabel: channels.websiteEmbedLauncherLabel ?? websiteEmbed.launcherLabel,
        websiteEmbedLauncherPosition: channels.websiteEmbedLauncherPosition ?? websiteEmbed.launcherPosition,
        websiteEmbedTheme: channels.websiteEmbedTheme ?? websiteEmbed.theme,
        websiteEmbedCopy: channels.websiteEmbedCopy ?? websiteEmbed.copy,
        websiteEmbedExpertOverrides: channels.websiteEmbedExpertOverrides ?? websiteEmbed.expertOverrides,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw badRequest(error.message);
      }
      throw error;
    }

    const updated = await this.dependencies.agentService.update(workspaceId, agent.id, this.dependencies.agentService.withRotatedTokens(agent, {
      surfaceSettings: {
        anonymousChat: {
          enabled: anonymousChatEnabled,
        },
        websiteEmbed: {
          enabled: normalizedWebsiteEmbed.websiteEmbedEnabled,
          allowedOrigins: normalizedWebsiteEmbed.websiteEmbedAllowedOrigins,
          launcherLabel: normalizedWebsiteEmbed.websiteEmbedLauncherLabel,
          launcherPosition: normalizedWebsiteEmbed.websiteEmbedLauncherPosition,
          theme: normalizedWebsiteEmbed.websiteEmbedTheme,
          copy: normalizedWebsiteEmbed.websiteEmbedCopy,
          expertOverrides: normalizedWebsiteEmbed.websiteEmbedExpertOverrides,
        },
      },
      rotateAnonymousChatToken,
      name: assistant.assistantName ?? agent.name,
      greetingInstruction: assistant.greetingInstruction ?? agent.greetingInstruction,
      assistantDefaultLocale:
        assistant.assistantDefaultLocale === undefined
          ? agent.assistantDefaultLocale
          : assistant.assistantDefaultLocale,
      proactiveGreetingEnabled: assistant.proactiveGreetingEnabled ?? agent.proactiveGreetingEnabled,
      suggestedQuestionsEnabled: assistant.suggestedQuestionsEnabled ?? agent.suggestedQuestionsEnabled,
      customInstruction: assistant.customInstruction ?? agent.customInstruction,
      rotateWebsiteEmbedToken,
    }), context.expectedUpdatedAt ? { expectedUpdatedAt: context.expectedUpdatedAt } : undefined);

    // After the agent write has committed. A failing audit sink must not report a change that is
    // already live as a failure - the same rule the ingestion settings service applies, and it
    // matters more here: a copilot proposal whose apply reports failure invites the operator to
    // draft it again.
    await this.recordChannelAuditEvents({
      accountId: context.accountId,
      workspaceId,
      previousAgent: agent,
      anonymousChatEnabled,
      rotateAnonymousChatToken: rotateAnonymousChatToken ?? false,
      websiteEmbedEnabled: normalizedWebsiteEmbed.websiteEmbedEnabled,
      websiteEmbedAllowedOrigins: normalizedWebsiteEmbed.websiteEmbedAllowedOrigins,
      websiteEmbedLauncherPosition: normalizedWebsiteEmbed.websiteEmbedLauncherPosition,
      rotateWebsiteEmbedToken: rotateWebsiteEmbedToken ?? false,
    });

    return updated;
  }

  private async recordChannelAuditEvents(input: {
    accountId?: string | null;
    workspaceId: string;
    previousAgent: AgentRecord;
    anonymousChatEnabled: boolean;
    rotateAnonymousChatToken: boolean;
    websiteEmbedEnabled: boolean;
    websiteEmbedAllowedOrigins: string[];
    websiteEmbedLauncherPosition: AgentRecord["surfaceSettings"]["websiteEmbed"]["launcherPosition"];
    rotateWebsiteEmbedToken: boolean;
  }): Promise<void> {
    const auditService = this.dependencies.auditService;
    if (!auditService) {
      return;
    }
    const record = async (event: Parameters<typeof auditService.record>[0]): Promise<void> => {
      try {
        await auditService.record(event);
      } catch (error) {
        // The change is already written; losing its audit line must not undo or misreport it. It
        // must not vanish either — this is the record of a public channel opening or closing, so
        // the loss is itself worth an operator's attention.
        this.dependencies.logger?.warn(
          { err: error, workspaceId: input.workspaceId, eventType: event.eventType },
          "Channel settings audit event was not recorded",
        );
      }
    };

    if (input.anonymousChatEnabled !== input.previousAgent.surfaceSettings.anonymousChat.enabled) {
      await record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: input.anonymousChatEnabled ? "anonymous_chat.enabled" : "anonymous_chat.disabled",
        eventStatus: "success",
        metadata: {},
      });
    }

    if (input.rotateAnonymousChatToken) {
      await record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "anonymous_chat.token_rotated",
        eventStatus: "success",
        metadata: { enabled: input.anonymousChatEnabled },
      });
    }

    if (input.websiteEmbedEnabled !== getWebsiteEmbedSurfaceSettings(input.previousAgent).enabled) {
      await record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: input.websiteEmbedEnabled ? "website_embed.enabled" : "website_embed.disabled",
        eventStatus: "success",
        metadata: {
          allowedOrigins: input.websiteEmbedAllowedOrigins,
          launcherPosition: input.websiteEmbedLauncherPosition,
        },
      });
    }

    if (input.rotateWebsiteEmbedToken) {
      await record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "website_embed.token_rotated",
        eventStatus: "success",
        metadata: {
          enabled: input.websiteEmbedEnabled,
          allowedOrigins: input.websiteEmbedAllowedOrigins,
        },
      });
    }
  }

  private buildAssistantSection(agent: AgentRecord, forwardedPrefix?: string | null) {
    return {
      assistantName: agent.name,
      greetingInstruction: agent.greetingInstruction,
      assistantDefaultLocale: agent.assistantDefaultLocale,
      proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
      assistantBootstrapActive: isAgentBootstrapActive(agent),
      suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
      customInstruction: agent.customInstruction,
      assistantLogoUrl: this.buildAssistantLogoUrl(agent, forwardedPrefix),
    };
  }

  private async buildChannelsSection(agent: AgentRecord, workspace: WorkspaceRecord): Promise<PlatformChannelsSettingsSection> {
    const anonymousChat = agent.surfaceSettings.anonymousChat;
    const websiteEmbed = agent.surfaceSettings.websiteEmbed;
    const [anonymousChatLifecycle, websiteEmbedLifecycle] = await Promise.all([
      resolvePublicLaunchLifecycle(anonymousChat.token, this.dependencies.accessGrantService),
      resolvePublicLaunchLifecycle(websiteEmbed.token, this.dependencies.accessGrantService),
    ]);
    return {
      anonymousChatEnabled: anonymousChat.enabled,
      anonymousChatUrl: this.buildAnonymousChatUrl(anonymousChat.token, anonymousChat.enabled),
      anonymousChatLastUsedAt: anonymousChatLifecycle.lastUsedAt,
      websiteEmbedEnabled: websiteEmbed.enabled,
      websiteEmbedToken: websiteEmbed.token,
      websiteEmbedLastUsedAt: websiteEmbedLifecycle.lastUsedAt,
      websiteEmbedAllowedOrigins: websiteEmbed.allowedOrigins,
      websiteEmbedLauncherLabel: websiteEmbed.launcherLabel,
      websiteEmbedLauncherPosition: websiteEmbed.launcherPosition,
      websiteEmbedTheme: websiteEmbed.theme,
      websiteEmbedCopy: websiteEmbed.copy,
      websiteEmbedExpertOverrides: websiteEmbed.expertOverrides,
      websiteEmbedScriptUrl: this.websiteEmbedIntegration.buildScriptUrl(),
      websiteEmbedSnippet: this.websiteEmbedIntegration.buildSnippet({
        name: workspace.name,
        assistantName: agent.name,
        websiteEmbedEnabled: websiteEmbed.enabled,
        websiteEmbedToken: websiteEmbed.token,
        websiteEmbedAllowedOrigins: websiteEmbed.allowedOrigins,
        websiteEmbedLauncherLabel: websiteEmbed.launcherLabel,
        websiteEmbedLauncherPosition: websiteEmbed.launcherPosition,
      }),
    };
  }

  private buildAssistantLogoUrl(agent: AgentRecord, forwardedPrefix?: string | null): string | null {
    return buildOperatorAssistantLogoUrl({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      hasLogo: Boolean(agent.logo),
      cacheKey: buildAssistantLogoCacheKey(agent.logo),
      forwardedPrefix,
    });
  }

  private buildAnonymousChatUrl(token: string | null, enabled: boolean): string | null {
    const baseUrl = this.dependencies.publicChatBaseUrl;
    if (!baseUrl || !enabled || !token) {
      return null;
    }
    return `${baseUrl}/${token}`;
  }

}
