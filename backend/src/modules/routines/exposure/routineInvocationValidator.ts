import type { AgentToolDescriptor, AgentToolInputProperty } from "./agentToolDescriptor.js";

export type RoutineInvocationInputValue = string | number | boolean;

/**
 * A tool call resolved against its descriptor: the routine it names and the
 * declared slots it prefills, already typed. This is what the chat turn carries
 * to the routines module; nothing about the transport that produced it rides
 * along. The tool name is the routine's identity within a release (frozen per
 * lineage), so the lineage id stays on the descriptor the call validated against.
 */
export interface RoutineInvocation {
  toolName: string;
  input: Record<string, RoutineInvocationInputValue>;
}

type RoutineInvocationErrorCode = "required" | "type" | "format" | "unknown_field";

/** One field-level problem with a tool call's input, named by slot key. */
interface RoutineInvocationError {
  path: string;
  code: RoutineInvocationErrorCode;
}

type RoutineInvocationValidation =
  | { ok: true; invocation: RoutineInvocation }
  | { ok: false; errors: RoutineInvocationError[] };

// Structural format checks mirroring the engine's slot-correction gate
// (`conversation-engine/src/slotCorrection.ts`): protocol syntax, not vocabulary.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

const isIsoCalendarDate = (value: string): boolean => {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExpectedType = (property: AgentToolInputProperty, value: unknown): value is RoutineInvocationInputValue => {
  switch (property.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
};

const hasExpectedFormat = (property: AgentToolInputProperty, value: string): boolean => {
  switch (property.format) {
    case "email":
      return EMAIL_PATTERN.test(value);
    case "date":
      return isIsoCalendarDate(value);
    case undefined:
      return true;
  }
};

/**
 * Validates a tool call's input against the descriptor's schema before any
 * turn state exists. Every problem is reported at once so a calling agent can
 * fix the whole call in one retry; values are never echoed back.
 */
export const validateRoutineInvocation = (descriptor: AgentToolDescriptor, rawInput: unknown): RoutineInvocationValidation => {
  const input = isRecord(rawInput) ? rawInput : {};
  const errors: RoutineInvocationError[] = [];
  const typed: Record<string, RoutineInvocationInputValue> = {};
  const { properties, required } = descriptor.inputSchema;

  for (const key of required) {
    if (!(key in input) || input[key] === undefined || input[key] === null) {
      errors.push({ path: key, code: "required" });
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property) {
      errors.push({ path: key, code: "unknown_field" });
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    if (!hasExpectedType(property, value)) {
      errors.push({ path: key, code: "type" });
      continue;
    }
    if (typeof value === "string" && !hasExpectedFormat(property, value)) {
      errors.push({ path: key, code: "format" });
      continue;
    }
    typed[key] = value;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    invocation: {
      toolName: descriptor.toolName,
      input: typed,
    },
  };
};
