import type { SkillArgumentOrigin } from "@radioso/conversation-contract";

import { coerceSkillValue } from "../../shared/domain/skillDataContract/index.js";
import type { ApiRequestSkillConfig } from "./domain.js";

type ResolvedApiRequestParams =
  | { kind: "ready"; params: Record<string, unknown> }
  | { kind: "missing_input"; missingInputs: string[] }
  | { kind: "invalid_input"; invalidInputs: string[] }
  | { kind: "unverified"; unverifiedInputs: string[] };

/** A value counts as given when it is neither absent, null, nor blank text. */
const isGiven = (value: unknown): boolean =>
  value !== undefined && value !== null && !(typeof value === "string" && value.trim().length === 0);

/**
 * The request's params: the bound ones as the author wrote them, then each exposed one from what
 * the routine collected under its slot binding (or its own name). A `verifiedOnly` param takes a
 * value only from a context variable the host verified; any other origin, or no value at all when
 * the param is required, settles `unverified`. A required param with no value settles
 * `missing_input`, and a value that does not fit the param's type `invalid_input`. Any of them
 * sends nothing; `unverified` wins over `missing_input`, which wins over `invalid_input`.
 */
export const resolveApiRequestParams = (
  config: Pick<ApiRequestSkillConfig, "boundParams" | "exposedParams">,
  collected: Readonly<Record<string, unknown>>,
  origins: Readonly<Record<string, SkillArgumentOrigin>>,
): ResolvedApiRequestParams => {
  const params: Record<string, unknown> = { ...config.boundParams };
  const missingInputs: string[] = [];
  const unverifiedInputs: string[] = [];
  const invalidInputs: string[] = [];
  for (const [key, exposed] of Object.entries(config.exposedParams)) {
    const collectedKey = exposed.slotBinding ?? key;
    const value = Object.hasOwn(collected, collectedKey) ? collected[collectedKey] : undefined;
    if (!isGiven(value)) {
      if (exposed.required) (exposed.verifiedOnly ? unverifiedInputs : missingInputs).push(collectedKey);
      continue;
    }
    if (exposed.verifiedOnly && origins[collectedKey] !== "verified_context") {
      unverifiedInputs.push(collectedKey);
      continue;
    }
    const coerced = coerceSkillValue(exposed.type, value, "input");
    if (!coerced.ok) {
      invalidInputs.push(collectedKey);
      continue;
    }
    params[key] = coerced.value;
  }
  if (unverifiedInputs.length > 0) return { kind: "unverified", unverifiedInputs };
  if (missingInputs.length > 0) return { kind: "missing_input", missingInputs };
  if (invalidInputs.length > 0) return { kind: "invalid_input", invalidInputs };
  return { kind: "ready", params };
};
