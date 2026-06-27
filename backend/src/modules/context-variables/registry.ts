import type {
  ContextVariableSensitivity,
  ContextVariableSource,
  ContextVariableTrustTier,
  ContextVariableValueType,
} from "./domain.js";
import type { ContextVariableSurfacing } from "./contextResolutionService.js";

export interface BuiltInContextVariableDescriptor {
  name: "page_context" | "visitor_identity";
  source: ContextVariableSource;
  valueType: ContextVariableValueType;
  surfacing: ContextVariableSurfacing;
  trustTier: ContextVariableTrustTier;
  sensitivity: ContextVariableSensitivity;
}

export const BUILT_IN_CONTEXT_VARIABLES: readonly BuiltInContextVariableDescriptor[] = [
  {
    name: "page_context",
    source: "browser",
    valueType: "json",
    surfacing: "always",
    trustTier: "unverified",
    sensitivity: "normal",
  },
  {
    name: "visitor_identity",
    source: "browser",
    valueType: "json",
    surfacing: "on_reference",
    trustTier: "signed",
    sensitivity: "sensitive",
  },
] as const;

export const BUILT_IN_CONTEXT_VARIABLE_BY_NAME = new Map(
  BUILT_IN_CONTEXT_VARIABLES.map((variable) => [variable.name, variable]),
);
