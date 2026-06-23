import { z, type SafeParseReturnType, type ZodType } from "zod";

import type { AgentSkillInvocationMode, AgentSkillKind } from "../agentSkills/domain.js";
import { retrieveCapability } from "./capabilities/retrieve.js";
import { mcpToolCapability } from "./capabilities/mcpTool.js";
import { emailCapability } from "./capabilities/email.js";
import { slackPostCapability } from "./capabilities/slackPost.js";
import { webhookCallCapability } from "./capabilities/webhookCall.js";
import { notifyCapability } from "./capabilities/notify.js";

export const skillCapabilityIds = ["retrieve", "mcp_tool", "email", "slack_post", "webhook_call", "notify"] as const;
export type SkillCapabilityId = (typeof skillCapabilityIds)[number];

export interface SkillCapabilityTarget {
  id: string;
  label: string;
  status?: string;
}

export interface SkillCapabilityTargetContext {
  workspaceId: string;
  agentId: string;
}

export type SkillCapabilityInputSchema =
  | { source: "static"; schema: Record<string, unknown> }
  | { source: "discovered" };

export interface SkillCapabilitySettingsFieldOption {
  value: string;
  label: string;
}

export interface SkillCapabilitySettingsField {
  key: string;
  label: string;
  type: "boolean" | "number" | "text" | "textarea" | "select" | "string_list" | "source_scope";
  help?: string;
  options?: SkillCapabilitySettingsFieldOption[];
  min?: number;
  max?: number;
  group?: string;
}

export interface SkillCapabilityDescriptor<
  Id extends string = SkillCapabilityId,
  StoredKind extends AgentSkillKind = AgentSkillKind,
> {
  id: Id;
  storedKind: StoredKind;
  targetKind: string;
  requiresTarget?: boolean;
  enumerateTargets(context: SkillCapabilityTargetContext): Promise<SkillCapabilityTarget[]>;
  inputSchema: SkillCapabilityInputSchema;
  settingsFields: readonly SkillCapabilitySettingsField[];
  outcomeVocabulary: readonly string[];
  supportedInvocationModes: readonly AgentSkillInvocationMode[];
  executorAdapter: string;
  configSchema: ZodType<unknown>;
  validateConfig(config: unknown): SafeParseReturnType<unknown, unknown>;
}

export const createSkillCapabilityDescriptor = <
  Id extends SkillCapabilityId,
  StoredKind extends AgentSkillKind,
>(
  descriptor: Omit<SkillCapabilityDescriptor<Id, StoredKind>, "validateConfig">,
): SkillCapabilityDescriptor<Id, StoredKind> => ({
  ...descriptor,
  requiresTarget: descriptor.requiresTarget ?? true,
  validateConfig(config: unknown) {
    return descriptor.configSchema.safeParse(config);
  },
});

export class SkillCapabilityRegistry {
  private readonly byId = new Map<SkillCapabilityId, SkillCapabilityDescriptor>();
  private readonly byStoredKind = new Map<AgentSkillKind, SkillCapabilityDescriptor>();

  constructor(descriptors: SkillCapabilityDescriptor[]) {
    for (const descriptor of descriptors) {
      if (this.byId.has(descriptor.id)) {
        throw new Error(`Duplicate skill capability id: ${descriptor.id}`);
      }
      if (this.byStoredKind.has(descriptor.storedKind)) {
        throw new Error(`Duplicate skill capability stored kind: ${descriptor.storedKind}`);
      }
      this.byId.set(descriptor.id, descriptor);
      this.byStoredKind.set(descriptor.storedKind, descriptor);
    }
  }

  list(): SkillCapabilityDescriptor[] {
    return [...this.byId.values()];
  }

  get(id: SkillCapabilityId): SkillCapabilityDescriptor | undefined {
    return this.byId.get(id);
  }

  getByStoredKind(kind: AgentSkillKind): SkillCapabilityDescriptor | undefined {
    return this.byStoredKind.get(kind);
  }

  supportsInvocationMode(id: SkillCapabilityId, mode: AgentSkillInvocationMode): boolean {
    return this.byId.get(id)?.supportedInvocationModes.includes(mode) ?? false;
  }
}

export const skillCapabilityIdSchema = z.enum(skillCapabilityIds);

export type SkillCapabilityTargetEnumerators = Partial<Record<
  SkillCapabilityId,
  SkillCapabilityDescriptor["enumerateTargets"]
>>;

const withEnumerators = (
  descriptors: SkillCapabilityDescriptor[],
  enumerators: SkillCapabilityTargetEnumerators = {},
): SkillCapabilityDescriptor[] =>
  descriptors.map((descriptor) => ({
    ...descriptor,
    requiresTarget: descriptor.requiresTarget ?? true,
    enumerateTargets: enumerators[descriptor.id] ?? descriptor.enumerateTargets,
  }));

export const createDefaultSkillCapabilityRegistry = (
  enumerators: SkillCapabilityTargetEnumerators = {},
): SkillCapabilityRegistry =>
  new SkillCapabilityRegistry([
    ...withEnumerators([
      retrieveCapability,
      mcpToolCapability,
      emailCapability,
      slackPostCapability,
      webhookCallCapability,
      notifyCapability,
    ], enumerators),
  ]);
