import { z } from "zod";

import type { SkillOutputContract, SkillOutputContractEntry } from "@radioso/conversation-contract";

import { isPrototypeKey, skillSlotBindingPattern } from "../skillPayloadKey.js";
import { coerceSkillValue, skillDataValueTypes } from "./values.js";

export const SKILL_OUTPUT_LIMITS = {
  outputs: 50,
  listFields: 20,
  pathSegments: 10,
  pathLength: 300,
  defaultMaxItems: 10,
  maxItems: 20,
} as const;

export const skillOutputFieldRoles = ["key", "title", "subtitle", "image", "link"] as const;

const pathSegmentPattern = /^[^.\s]+$/u;

const isValidPath = (path: string): boolean => {
  const segments = path.split(".");
  return segments.length <= SKILL_OUTPUT_LIMITS.pathSegments
    && segments.every((segment) => pathSegmentPattern.test(segment) && !isPrototypeKey(segment));
};

/** A dot path into JSON: numeric segments index arrays; a key containing `.` cannot be named. */
const outputPathSchema = z.string().trim().min(1).max(SKILL_OUTPUT_LIMITS.pathLength)
  .refine(isValidPath, `path takes up to ${SKILL_OUTPUT_LIMITS.pathSegments} dot segments, none empty or reaching a prototype`);
const outputNameSchema = z.string().trim().min(1).max(120).regex(skillSlotBindingPattern, "name must be a variable name");
const descriptionSchema = z.string().trim().min(1).max(1000);

const scalarOutputSchema = z.object({
  path: outputPathSchema,
  type: z.enum(skillDataValueTypes),
  description: descriptionSchema.optional(),
  required: z.boolean().default(false),
}).strict();

const listFieldSchema = scalarOutputSchema.extend({
  role: z.enum(skillOutputFieldRoles).optional(),
}).strict().refine(
  (field) => (field.role !== "image" && field.role !== "link") || field.type === "text",
  "an image or link field must be text",
);

const listOutputSchema = z.object({
  path: outputPathSchema,
  type: z.literal("list"),
  description: descriptionSchema.optional(),
  required: z.boolean().default(false),
  maxItems: z.number().int().min(1).max(SKILL_OUTPUT_LIMITS.maxItems).default(SKILL_OUTPUT_LIMITS.defaultMaxItems),
  fields: z.record(outputNameSchema, listFieldSchema),
}).strict().superRefine((list, ctx) => {
  const fields = Object.values(list.fields);
  if (fields.length > SKILL_OUTPUT_LIMITS.listFields) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields"], message: `at most ${SKILL_OUTPUT_LIMITS.listFields} fields` });
  }
  for (const role of skillOutputFieldRoles) {
    if (fields.filter((field) => field.role === role).length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields"], message: `role "${role}" is set on more than one field` });
    }
  }
});

const skillOutputSchema = z.discriminatedUnion("type", [listOutputSchema, scalarOutputSchema]);

/** The outputs a skill declares, by name: each a scalar at a path, or a list of records with typed fields. */
export const skillOutputsSchema = z.record(outputNameSchema, skillOutputSchema).refine(
  (outputs) => Object.keys(outputs).length <= SKILL_OUTPUT_LIMITS.outputs,
  `at most ${SKILL_OUTPUT_LIMITS.outputs} outputs`,
);

export type SkillScalarOutput = z.infer<typeof scalarOutputSchema>;
export type SkillListOutput = z.infer<typeof listOutputSchema>;
export type SkillOutputDeclarations = Record<string, SkillScalarOutput | SkillListOutput>;

const numericSegment = /^(0|[1-9][0-9]*)$/u;

/** Reads one dot path: an object's own key per segment, a numeric segment indexing an array. */
export const readJsonPath = (body: unknown, path: string): { found: true; value: unknown } | { found: false } => {
  let current: unknown = body;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      if (!numericSegment.test(segment) || Number(segment) >= current.length) return { found: false };
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
};

const projectScalar = (source: unknown, output: SkillScalarOutput): { present: boolean; value?: unknown } => {
  const read = readJsonPath(source, output.path);
  if (!read.found) return { present: false };
  const coerced = coerceSkillValue(output.type, read.value, "output");
  return coerced.ok ? { present: true, value: coerced.value } : { present: false };
};

const projectList = (source: unknown, output: SkillListOutput): { present: boolean; value?: unknown } => {
  const read = readJsonPath(source, output.path);
  if (!read.found || !Array.isArray(read.value) || read.value.length === 0) return { present: false };
  const items = read.value.slice(0, output.maxItems).map((item) => {
    const record: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(output.fields)) {
      const projected = projectScalar(item, field);
      if (projected.present) record[name] = projected.value;
    }
    return record;
  });
  return { present: true, value: items };
};

export type SkillOutputCheck =
  | { kind: "checked"; outputs: Record<string, unknown> }
  /** A required output came back absent: the response does not follow the declared contract. */
  | { kind: "mismatch"; missing: string[] }
  | { kind: "too_large" };

/**
 * Projects a parsed response onto the declared outputs and checks it against them: each scalar
 * coerced to its type or left out, each list cut to `maxItems` with exactly its declared fields
 * (an empty list is left out, so "is set" means "found any"), nothing undeclared kept. A required
 * output left out is a mismatch; outputs over `maxBytes` serialized are too large.
 */
export const checkSkillOutputs = (
  body: unknown,
  outputs: Readonly<SkillOutputDeclarations>,
  maxBytes: number,
): SkillOutputCheck => {
  const projected: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [name, output] of Object.entries(outputs)) {
    const result = output.type === "list" ? projectList(body, output) : projectScalar(body, output);
    if (result.present) projected[name] = result.value;
    else if (output.required) missing.push(name);
  }
  if (missing.length > 0) return { kind: "mismatch", missing };
  return Buffer.byteLength(JSON.stringify(projected), "utf8") > maxBytes
    ? { kind: "too_large" }
    : { kind: "checked", outputs: projected };
};

const describedAs = (description: string | undefined) => (description ? { description } : {});

/** The model-facing contract for declared outputs: types, descriptions and list fields, no paths. */
export const skillOutputContractFor = (outputs: Readonly<SkillOutputDeclarations>): SkillOutputContract =>
  Object.fromEntries(Object.entries(outputs).map(([name, output]): [string, SkillOutputContractEntry] => [
    name,
    output.type === "list"
      ? {
          type: "list",
          ...describedAs(output.description),
          fields: Object.fromEntries(Object.entries(output.fields).map(([fieldName, field]) => [
            fieldName,
            { type: field.type, ...describedAs(field.description), ...(field.role ? { role: field.role } : {}) },
          ])),
        }
      : { type: output.type, ...describedAs(output.description) },
  ]));
