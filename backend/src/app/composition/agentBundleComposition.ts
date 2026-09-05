import {
  AgentBundleExportService,
  AgentBundleImportCleanupWorker,
  AgentBundleImportService,
  type AgentBundleAgentSkillRecord,
  type AgentBundleContextVariableRecord,
} from "../../modules/agentBundle/public.js";
import { projectInternalAgentExternalSkills } from "../../modules/agents/public.js";
import type { AgentInput, ConversationAgent } from "../../modules/agents/public.js";
import type { AgentService, AuthoredDirectiveService } from "../../modules/agents/public.js";
import type { AgentSkillsService } from "../../modules/agentSkills/public.js";
import type { ContextVariableService } from "../../modules/context-variables/public.js";
import type { RoutineDefinitionService } from "../../modules/routines/public.js";
import type { SkillCapabilityRegistry } from "../../modules/skills/public.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { AgentBundleImportRepositoryPort } from "../../modules/agentBundle/public.js";
import type { AuditService } from "../../modules/audit/contracts/index.js";

/**
 * Adapts the concrete services to the agentBundle module's narrow ports.
 *
 * The module states what it needs to read and write; this file is the only place
 * that knows which service answers each of those. Nothing here is product logic —
 * every decision about what travels lives in the module.
 */
/** The rows `projectInternalAgentExternalSkills` reads, named from its own signature. */
type ExternalSkillSources = Parameters<typeof projectInternalAgentExternalSkills>[0];

export interface AgentBundleCompositionDependencies {
  logger?: AppLogger;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  auditService: AuditService;
  imports: AgentBundleImportRepositoryPort;
  importOrphanAgeMs: number;
  agentService: AgentService;
  authoredDirectiveService: AuthoredDirectiveService;
  agentSkillsService: AgentSkillsService;
  contextVariableService: ContextVariableService;
  routineDefinitionService: RoutineDefinitionService;
  capabilityRegistry: SkillCapabilityRegistry;
  agentRepository: {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<ConversationAgent | null>;
  };
  mcpConnectionRepository: { listByAgent(agentId: string): Promise<ExternalSkillSources["connections"]> };
  externalSkillDefinitionRepository: { listByAgent(agentId: string): Promise<ExternalSkillSources["skills"]> };
}

export const createAgentBundleServices = (deps: AgentBundleCompositionDependencies) => {
  const agents = {
    load: (workspaceId: string, agentId: string) =>
      deps.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId),
  };

  const externalSkills = {
    load: async (_workspaceId: string, agentId: string) => {
      const [connections, skills] = await Promise.all([
        deps.mcpConnectionRepository.listByAgent(agentId),
        deps.externalSkillDefinitionRepository.listByAgent(agentId),
      ]);
      return projectInternalAgentExternalSkills({ connections, skills });
    },
  };

  /**
   * The enablement rows point at ids; the bundle carries names. Resolving both
   * indexes once per export beats a lookup per row.
   */
  const contextVariableReader = {
    listByAgent: async (workspaceId: string, agentId: string): Promise<AgentBundleContextVariableRecord[]> => {
      const [enablements, definitions, skills] = await Promise.all([
        deps.contextVariableService.listByAgent(workspaceId, agentId),
        deps.contextVariableService.listByWorkspace(workspaceId),
        deps.agentSkillsService.list(workspaceId, agentId),
      ]);
      const variableNames = new Map(definitions.map((variable) => [variable.id, variable.name]));
      const skillNames = new Map(skills.map((skill) => [skill.id, skill.name]));

      return enablements
        // An enablement whose variable no longer resolves is a broken row, not a
        // portable one; exporting it by id would put a foreign uuid in the bundle.
        .filter((enablement) => variableNames.has(enablement.variableId))
        .map((enablement) => ({
          variableId: enablement.variableId,
          variableName: variableNames.get(enablement.variableId) as string,
          source: enablement.source,
          resolverSkillId: enablement.resolverSkillId,
          resolverSkillName: enablement.resolverSkillId
            ? skillNames.get(enablement.resolverSkillId) ?? null
            : null,
          maxAgeSeconds: enablement.maxAgeSeconds,
          resolverTimeoutMs: enablement.resolverTimeoutMs,
          surfacing: enablement.surfacing,
          enabled: enablement.enabled,
        }));
    },
  };

  const agentSkillReader = {
    listByAgent: async (workspaceId: string, agentId: string): Promise<AgentBundleAgentSkillRecord[]> => {
      const skills = await deps.agentSkillsService.list(workspaceId, agentId);
      return skills.map((skill) => ({
        name: skill.name,
        capability: skill.capability,
        invocationMode: skill.invocationMode,
        enabled: skill.enabled,
        config: skill.config,
        target: { kind: skill.target.kind, id: skill.target.id },
      }));
    },
  };

  const exportService = new AgentBundleExportService({
    agents,
    externalSkills,
    routines: {
      listByAgent: (workspaceId, agentId) => deps.routineDefinitionService.list(workspaceId, agentId),
    },
    contextVariables: contextVariableReader,
    agentSkills: agentSkillReader,
    skillConfigPortability: {
      portableFieldKeys: (capability) => deps.capabilityRegistry.portableSettingsFieldKeys(capability as never),
      settingsFieldKeys: (capability) => new Set(
        (deps.capabilityRegistry.get(capability as never)?.settingsFields ?? []).map((field) => field.key),
      ),
    },
  });

  const agentWriter = {
    create: async (workspaceId: string, input: AgentInput, agentId?: string) => {
      const agent = await deps.agentService.create(workspaceId, input, { agentId });
      return { agentId: agent.id };
    },
    delete: async (workspaceId: string, agentId: string) => {
      // Compensation, not an operator action: this agent was created moments ago by
      // the import that is now unwinding, so the last-agent rule does not apply.
      await deps.agentService.delete(workspaceId, agentId, { allowLastAgent: true });
    },
  };

  const importService = new AgentBundleImportService({
    logger: deps.logger,
    imports: deps.imports,
    agents: agentWriter,
    directives: {
      create: async (workspaceId, agentId, directive) => {
        await deps.authoredDirectiveService.create(workspaceId, agentId, directive as never);
      },
    },
    skills: {
      hasCapability: (capability) => Boolean(deps.capabilityRegistry.get(capability as never)),
      create: async (workspaceId, agentId, skill) => {
        const descriptor = deps.capabilityRegistry.get(skill.capability as never);
        await deps.agentSkillsService.create(workspaceId, agentId, {
          name: skill.name,
          capability: skill.capability,
          invocationMode: skill.invocationMode,
          enabled: skill.enabled,
          config: skill.config,
          // The stored target kind is nullable, the create contract's is not: fall
          // back to the capability's own declared kind rather than inventing one.
          target: { kind: skill.target.kind ?? descriptor?.targetKind ?? "unknown", id: null },
        } as never);
      },
    },
    contextVariables: {
      findVariableIdByName: async (workspaceId, name) => {
        const variables = await deps.contextVariableService.listByWorkspace(workspaceId);
        return variables.find((variable) => variable.name === name)?.id ?? null;
      },
      findSkillIdByName: async (workspaceId, agentId, name) => {
        const skills = await deps.agentSkillsService.list(workspaceId, agentId);
        return skills.find((skill) => skill.name === name)?.id ?? null;
      },
      enable: async (workspaceId, agentId, enablement) => {
        await deps.contextVariableService.upsertEnablement({ workspaceId, agentId, ...enablement });
      },
    },
    routines: {
      createDraft: async (workspaceId, agentId, definition) => {
        const saved = await deps.routineDefinitionService.createDraft(workspaceId, agentId, definition as never);
        return { routineId: saved.routine.id };
      },
      publish: async (workspaceId, agentId, routineId) => {
        const result = await deps.routineDefinitionService.publish(workspaceId, agentId, routineId);
        if ("rejected" in result) {
          return {
            published: false,
            reason: result.validation.diagnostics.map((diagnostic) => diagnostic.message).join("; ")
              || "the routine did not pass validation for serving",
          };
        }
        return { published: true };
      },
    },
  });

  const cleanupWorker = new AgentBundleImportCleanupWorker({
    imports: deps.imports,
    agents: agentWriter,
    audit: deps.auditService,
    logger: deps.logger ?? { info: () => undefined, error: () => undefined },
    metrics: deps.metrics,
    orphanAgeMs: deps.importOrphanAgeMs,
  });

  return { exportService, importService, cleanupWorker };
};
