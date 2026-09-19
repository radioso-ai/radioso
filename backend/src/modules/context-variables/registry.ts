import type {
  ContextVariableSensitivity,
  ContextVariableSource,
  ContextVariableTrustTier,
  ContextVariableValueType,
} from "./domain.js";
import type { ContextVariableSurfacing } from "./contextResolutionService.js";

interface BuiltInContextVariableDescriptor {
  name: "page_context" | "visitor_identity" | "visitor_request";
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
  // FR-030/FR-033: request-derived visitor facts (country/region/city/language/referrer/
  // entry page). Like the two browser-sourced built-ins above, resolution is unconditional:
  // there is no per-agent `agent_context_variables` enablement row for `source: "request"`
  // — see `chatSessionPreparer.resolveVisitorRequestFacts`.
  {
    name: "visitor_request",
    source: "request",
    valueType: "json",
    surfacing: "always",
    trustTier: "unverified",
    sensitivity: "normal",
  },
] as const;
