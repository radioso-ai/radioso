import type {
  RoutineApprovalOption,
  RoutineDefinition,
  RoutineGuardKind,
  RoutineStepKind,
} from "../../modules/routines/public.js";

// Readers for the json_agg child rows `routineDefinitionRepository` projects. A jsonb column
// arrives untyped, so each reader narrows one key and drops what is malformed rather than
// trusting the stored shape.

export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const readString = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? record[key] : "";

export const readNullableString = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === "string" ? record[key] : null;

export const readNumber = (record: Record<string, unknown>, key: string): number =>
  typeof record[key] === "number" ? record[key] : 0;

export const readBoolean = (record: Record<string, unknown>, key: string): boolean =>
  typeof record[key] === "boolean" ? record[key] : false;

export const readOperatorNotice = (
  terminal: Record<string, unknown>,
): NonNullable<RoutineDefinition["terminals"][number]["operatorNotice"]> => {
  const skillName = readNullableString(terminal, "operatorNoticeSkillName");
  const replyToSlot = readNullableString(terminal, "operatorNoticeReplyToSlot");
  const includeAiSummary = readBoolean(terminal, "operatorNoticeIncludeAiSummary");
  return {
    subject: readNullableString(terminal, "operatorNoticeSubject"),
    intro: readNullableString(terminal, "operatorNoticeIntro"),
    ...(skillName ? { skillName } : {}),
    ...(replyToSlot ? { replyToSlot } : {}),
    ...(includeAiSummary ? { includeAiSummary: true } : {}),
  };
};

export const readMetadata = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
  asRecord(record[key]);

// A field guard's comparison value is a string, number, or boolean (or absent). It rides
// in a jsonb column, so it arrives already typed — pass it through, drop anything else.
export const readFieldValue = (record: Record<string, unknown>, key: string): string | number | boolean | null => {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
};

export const readFieldValues = (record: Record<string, unknown>, key: string): (string | number | boolean)[] | null => {
  const value = record[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const primitives = value.filter((entry): entry is string | number | boolean =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
  );
  // An empty list is not a valid `in` guard (the domain enforces min(1)); surface it as
  // absent rather than a never-matching `values: []` the compiler would still spread.
  return primitives.length > 0 ? primitives : null;
};

export const asArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(asRecord) : [];

// An approval step's options ride in a jsonb column. Read back the {id,label,description?}
// shape the domain expects, dropping anything malformed. Absent for non-approval steps.
export const readApprovalOptions = (record: Record<string, unknown>, key: string): RoutineApprovalOption[] | null => {
  const value = record[key];
  if (!Array.isArray(value)) {
    return null;
  }
  const options = value
    .map(asRecord)
    .filter((option) => typeof option.id === "string" && typeof option.label === "string")
    .map((option) => ({
      id: option.id as string,
      label: option.label as string,
      description: typeof option.description === "string" ? option.description : null,
    }));
  return options.length > 0 ? options : null;
};

export const normalizeStepKind = (kind: string): RoutineStepKind =>
  kind === "fork" ? "chat" : kind as RoutineStepKind;

export const normalizeGuardKind = (kind: string): RoutineGuardKind =>
  kind === "always" || kind === "fallback" ? "default" : kind as RoutineGuardKind;
