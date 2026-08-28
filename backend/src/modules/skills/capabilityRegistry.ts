import { z, type SafeParseReturnType, type ZodType } from "zod";

import type { AgentSkillInvocationMode, AgentSkillKind } from "../agentSkills/public.js";
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
  type: "boolean" | "number" | "text" | "textarea" | "select" | "string_list" | "source_scope" | "metadata_rules";
  help?: string;
  dependsOnKey?: string;
  options?: SkillCapabilitySettingsFieldOption[];
  min?: number;
  max?: number;
  group?: string;
  advanced?: boolean;
  // Effective value when the agent leaves the field unset (the system-layer
  // default). Editors use it to render the real behavior instead of showing an
  // unset toggle as "off" when the behavior is actually on.
  defaultValue?: string | number | boolean;
  // Opt-in only: the operator copilot reader (agent_skills) includes this field's *value* in what
  // it hands to the model only when this is exactly `true`. Every field is always named to the
  // copilot regardless of this flag (key, label, type, help) - this only gates the value. Default
  // is hidden, on purpose: a capability author adding a field must not silently widen what the
  // model reads. Set it only for settings that are genuinely safe operator-tunable configuration,
  // never for anything that can carry a credential, token, or personal data (for example notify's
  // delivery.webhook.url or delivery.recipientEmails).
  showValueToCopilot?: boolean;
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
  defaultInvocationMode?: AgentSkillInvocationMode;
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
