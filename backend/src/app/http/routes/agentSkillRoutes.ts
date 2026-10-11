import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { agentSkillCreateSchema, agentSkillUpdateSchema } from "../../../modules/agentSkills/public.js";
import { builtInAnswerSkillDefinitions } from "../../../modules/chat/public.js";
import { resolveRetrievalSkillSettings } from "../../../modules/retrieval/public.js";
import type { SkillCapabilityDescriptor } from "../../../modules/skills/public.js";
import { badRequest, forbidden } from "../../../shared/domain/errors.js";
import {
  recipientEmailChangeMetadata,
  recipientEmailsFromDeliveryConfig,
} from "../../../shared/domain/recipientEmailAudit.js";
import { holdsWorkspacePermission, requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";

type AgentSkillRouteDependencies = Pick<
  AppDependencies,
  | "env"
  | "authService"
  | "accountAccessService"
  | "workspaceSessionService"
  | "logger"
  | "agentService"
  | "agentSkillsService"
  | "skillCapabilityRegistry"
  | "retrievalDefaultsProvider"
  | "operatorNoticeDestinations"
>;

const uuidSchema = z.string().uuid();

const parseUuid = (raw: unknown, field: string): string => {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`Invalid ${field}`);
  }
  return parsed.data;
};

const explicitlyChangesRecipients = (config: unknown): boolean => {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const delivery = (config as Record<string, unknown>).delivery;
  return Boolean(delivery && typeof delivery === "object" && !Array.isArray(delivery)
    && Object.hasOwn(delivery, "recipientEmails"));
};

const requireRecipientManagement = async (
  dependencies: AgentSkillRouteDependencies,
  res: Response,
): Promise<void> => {
  if (!await holdsWorkspacePermission(dependencies, res, "workspace.notification_recipients.manage")) {
    throw forbidden("Only workspace owners and admins can change notification recipients");
  }
};

const withEffectiveRetrievalDefaults = (
  descriptor: SkillCapabilityDescriptor,
  effectiveSettings: object,
): SkillCapabilityDescriptor["settingsFields"] => {
  if (descriptor.id !== "retrieve") {
    return descriptor.settingsFields;
  }
  return descriptor.settingsFields.map((field) => {
    if (field.defaultValue === undefined) {
      return field;
    }
    const effectiveDefault = (effectiveSettings as Record<string, unknown>)[field.key];
    return typeof effectiveDefault === "string" || typeof effectiveDefault === "number" || typeof effectiveDefault === "boolean"
      ? { ...field, defaultValue: effectiveDefault }
      : field;
  });
};

export const createAgentSkillRoutes = (dependencies: AgentSkillRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentRead = requireWorkspacePermission(dependencies, "workspace.agents.read");
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");

  const resolveAgent = async (req: Request, res: Response) => {
    const { workspaceId } = res.locals as { workspaceId: string };
    const agentId = parseUuid(req.params.agentId, "agentId");
    const agent = await dependencies.agentService.get(workspaceId, agentId);
    return { workspaceId, agentId, agent };
  };

  router.get("/:agentId/skill-capabilities", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, agentId, agent } = await resolveAgent(req, res);
      const effectiveRetrievalSettings = resolveRetrievalSkillSettings(
        dependencies.retrievalDefaultsProvider.getDefaults(workspaceId),
        agent.skillSettings["retrieval.answer"],
      );
      const capabilities = await Promise.all(dependencies.skillCapabilityRegistry.list().map(async (descriptor) => {
        const targets = await descriptor.enumerateTargets({ workspaceId, agentId });
        const requiresTarget = descriptor.requiresTarget ?? true;
        const available = requiresTarget ? targets.length > 0 : true;
        return {
          id: descriptor.id,
          storedKind: descriptor.storedKind,
          targetKind: descriptor.targetKind,
          requiresTarget,
          inputSchema: descriptor.inputSchema,
          settingsFields: withEffectiveRetrievalDefaults(descriptor, effectiveRetrievalSettings),
          outcomeVocabulary: descriptor.outcomeVocabulary,
          supportedInvocationModes: descriptor.supportedInvocationModes,
          defaultInvocationMode: descriptor.defaultInvocationMode ?? descriptor.supportedInvocationModes[0],
          executorAdapter: descriptor.executorAdapter,
          targets,
          available,
          unavailableReason: available ? null : "no_connection",
        };
      }));
      dependencies.logger.info({
        event: "agent_skill_capabilities_resolved",
        workspaceId,
        agentId,
        capabilityCount: capabilities.length,
        availableCount: capabilities.filter((capability) => capability.available).length,
      });
      res.status(200).json({ capabilities });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId/skills", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      const skills = await dependencies.agentSkillsService.list(workspaceId, agentId);
      const platformSkills = builtInAnswerSkillDefinitions.map((skill) => ({
        owner: "platform" as const,
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
      }));
      res.status(200).json({ skills, platformSkills });
    } catch (error) {
      next(error);
    }
  });

  // Where a routine ending's "Notify the team" notice goes, per notify skill an ending may name.
  router.get("/:agentId/operator-notice-destinations", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      res.status(200).json(await dependencies.operatorNoticeDestinations.read({ workspaceId, agentId }));
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:agentId/skills",
    workspaceSession,
    agentManage,
    validateBody(agentSkillCreateSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId } = await resolveAgent(req, res);
        if (req.body.capability === "notify"
          && explicitlyChangesRecipients(req.body.config)
          && recipientEmailsFromDeliveryConfig(req.body.config).length > 0) {
          await requireRecipientManagement(dependencies, res);
        }
        const skill = await dependencies.agentSkillsService.create(workspaceId, agentId, req.body);
        res.status(201).json({ skill });
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/:agentId/skills/:skillId",
    workspaceSession,
    agentManage,
    validateBody(agentSkillUpdateSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId } = await resolveAgent(req, res);
        const skillId = parseUuid(req.params.skillId, "skillId");
        const existing = (await dependencies.agentSkillsService.list(workspaceId, agentId))
          .find((skill) => skill.id === skillId);
        const proposedRecipients = explicitlyChangesRecipients(req.body.config)
          ? recipientEmailsFromDeliveryConfig(req.body.config)
          : req.body.replaceConfig !== undefined
            ? recipientEmailsFromDeliveryConfig(req.body.replaceConfig)
            : null;
        if (existing?.capability === "notify"
          && proposedRecipients
          && recipientEmailChangeMetadata(
            recipientEmailsFromDeliveryConfig(existing.config),
            proposedRecipients,
          )) {
          await requireRecipientManagement(dependencies, res);
        }
        const skill = await dependencies.agentSkillsService.update(
          workspaceId,
          agentId,
          skillId,
          req.body,
        );
        res.status(200).json({ skill });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/:agentId/skills/:skillId", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId, agentId } = await resolveAgent(req, res);
      const skillId = parseUuid(req.params.skillId, "skillId");
      if ((await dependencies.agentSkillsService.list(workspaceId, agentId))
        .some((skill) => skill.id === skillId
          && skill.capability === "notify"
          && recipientEmailsFromDeliveryConfig(skill.config).length > 0)) {
        await requireRecipientManagement(dependencies, res);
      }
      await dependencies.agentSkillsService.remove(workspaceId, agentId, skillId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
