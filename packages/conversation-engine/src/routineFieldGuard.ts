// Deterministic field guards: a routine branching on a tool output or a captured slot in code,
// never by a model.
import type { RoutineGuard, RoutineSkillResult } from "@radioso/conversation-contract";

type RoutineFieldGuard = Extract<RoutineGuard, { kind: "field" }>;

/**
 * Resolve a field guard's `ref` to a concrete value: the last skill result's typed
 * `outputs` take precedence (the tool computed it), then captured slot variables.
 * Returns `undefined` when nothing provides the reference.
 */
const resolveFieldValue = (
  ref: string,
  variables: Record<string, unknown>,
  skillResult?: RoutineSkillResult,
): unknown => {
  const readPath = (source: Record<string, unknown>, path: string[]): unknown => {
    let value: unknown = source;
    for (const segment of path) {
      if (typeof value !== "object" || value === null || !Object.prototype.hasOwnProperty.call(value, segment)) {
        return undefined;
      }
      value = (value as Record<string, unknown>)[segment];
    }
    return value;
  };
  const path = ref.split(".");
  const outputs = skillResult?.outputs;
  if (outputs && Object.prototype.hasOwnProperty.call(outputs, ref)) {
    return outputs[ref];
  }
  if (outputs && path.length > 1) {
    const nested = readPath(outputs, path);
    if (nested !== undefined) {
      return nested;
    }
  }
  if (Object.prototype.hasOwnProperty.call(variables, ref)) {
    return variables[ref];
  }
  if (path.length > 1) {
    return readPath(variables, path);
  }
  return undefined;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

// `now` minus (amount × unit), using calendar arithmetic so "6 months" respects month
// boundaries (the date math the model gets wrong — done once, in code).
const subtractDuration = (now: Date, amount: number, unit: NonNullable<RoutineFieldGuard["unit"]>): Date => {
  const result = new Date(now.getTime());
  switch (unit) {
    case "days":
      result.setDate(result.getDate() - amount);
      break;
    case "weeks":
      result.setDate(result.getDate() - amount * 7);
      break;
    case "months":
      result.setMonth(result.getMonth() - amount);
      break;
    case "years":
      result.setFullYear(result.getFullYear() - amount);
      break;
  }
  return result;
};

/**
 * Evaluate a deterministic field guard in code — no model call. This is the branch
 * that lets a routine decide on tool-computed facts (e.g. `is_final_sale === true`,
 * `status in {…}`, `order_date older_than 6 months`) with the same certainty every time.
 */
export const evaluateFieldGuard = (
  guard: RoutineFieldGuard,
  variables: Record<string, unknown>,
  skillResult: RoutineSkillResult | undefined,
  now: Date,
): boolean => {
  const actual = resolveFieldValue(guard.ref, variables, skillResult);
  switch (guard.op) {
    case "is_true":
      return actual === true;
    case "is_false":
      return actual === false;
    case "is_present":
      return actual !== undefined && actual !== null;
    case "is_absent":
      return actual === undefined || actual === null;
    case "equals":
      return actual === guard.value;
    case "not_equals":
      return actual !== guard.value;
    case "in":
      return Array.isArray(guard.values) && guard.values.some((candidate) => candidate === actual);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = toNumber(actual);
      const right = toNumber(guard.value);
      if (left === null || right === null) return false;
      if (guard.op === "gt") return left > right;
      if (guard.op === "gte") return left >= right;
      if (guard.op === "lt") return left < right;
      return left <= right;
    }
    case "older_than":
    case "within": {
      const date = toDate(actual);
      const amount = toNumber(guard.value);
      if (date === null || amount === null || !guard.unit) return false;
      const threshold = subtractDuration(now, amount, guard.unit);
      return guard.op === "older_than" ? date.getTime() < threshold.getTime() : date.getTime() >= threshold.getTime();
    }
    default:
      return false;
  }
};
