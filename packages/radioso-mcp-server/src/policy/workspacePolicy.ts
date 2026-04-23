import { readFileSync } from "node:fs";

import { z } from "zod";

import type { CapabilityPolicyConfig, CapabilityPolicyRegistry } from "./capabilityPolicy.js";
import { createCapabilityPolicyRegistry } from "./capabilityPolicy.js";

const workspacePolicyOverrideSchema = z.object({
  allowedReadTools: z.array(z.string().trim().min(1)).optional(),
  allowedWriteTools: z.array(z.string().trim().min(1)).optional(),
  approvalRequiredWriteTools: z.array(z.string().trim().min(1)).optional(),
});

const workspacePolicyFileSchema = z.object({
  workspaces: z.record(z.string().uuid(), workspacePolicyOverrideSchema).default({}),
});

export interface WorkspacePolicyResolution {
  policy: CapabilityPolicyRegistry;
  source: "global" | "workspace";
  workspaceId?: string;
}

export interface WorkspacePolicyResolver {
  resolve(workspaceId?: string): WorkspacePolicyResolution;
}

type WorkspacePolicyOverride = z.infer<typeof workspacePolicyOverrideSchema>;

const mergePolicyConfig = (
  baseConfig: CapabilityPolicyConfig,
  override: WorkspacePolicyOverride | undefined,
): CapabilityPolicyConfig => ({
  allowedReadTools: override?.allowedReadTools ?? baseConfig.allowedReadTools,
  allowedWriteTools: override?.allowedWriteTools ?? baseConfig.allowedWriteTools,
  approvalRequiredWriteTools: override?.approvalRequiredWriteTools ?? baseConfig.approvalRequiredWriteTools,
});

export const loadWorkspacePolicyOverrides = (
  workspacePoliciesPath?: string,
): Record<string, WorkspacePolicyOverride> => {
  if (!workspacePoliciesPath) {
    return {};
  }

  const raw = readFileSync(workspacePoliciesPath, "utf8");
  return workspacePolicyFileSchema.parse(JSON.parse(raw)).workspaces;
};

export const createWorkspacePolicyResolver = (
  baseConfig: CapabilityPolicyConfig,
  workspaceOverrides: Record<string, WorkspacePolicyOverride> = {},
): WorkspacePolicyResolver => {
  const globalPolicy = createCapabilityPolicyRegistry(baseConfig);
  const workspacePolicies = new Map<string, CapabilityPolicyRegistry>();

  return {
    resolve(workspaceId) {
      if (!workspaceId) {
        return {
          policy: globalPolicy,
          source: "global",
        };
      }

      const override = workspaceOverrides[workspaceId];
      if (!override) {
        return {
          policy: globalPolicy,
          source: "global",
          workspaceId,
        };
      }

      let policy = workspacePolicies.get(workspaceId);
      if (!policy) {
        policy = createCapabilityPolicyRegistry(mergePolicyConfig(baseConfig, override));
        workspacePolicies.set(workspaceId, policy);
      }

      return {
        policy,
        source: "workspace",
        workspaceId,
      };
    },
  };
};
