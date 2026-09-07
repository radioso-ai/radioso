import { z } from "zod";

import { connectionSlotIdSchema, descriptionSchema, displayNameSchema, fieldKeySchema } from "./identifiers.js";

/**
 * Installation configuration an operator fills in. The vocabulary is closed and
 * holds no secret type: a value an operator must keep private is bound through a
 * connection slot, which stores it outside the manifest's value space.
 */
export const configurationFieldTypes = [
  "text",
  "number",
  "boolean",
  "select",
  "url",
  "connection_slot",
] as const;

export const configurationFieldTypeSchema = z.enum(configurationFieldTypes);

export const configurationSelectOptionSchema = z
  .object({
    value: z.string().min(1).max(128),
    label: displayNameSchema,
  })
  .strict();

const fieldHeader = {
  key: fieldKeySchema,
  label: displayNameSchema,
  description: descriptionSchema.optional(),
  required: z.boolean(),
  placeholder: z.string().max(200).optional(),
};

/**
 * Each type carries only what that type can mean. A number field cannot default
 * to a word, and a connection_slot field carries no default at all — which is
 * what keeps credential-looking material out of the manifest's value space, out
 * of the installation plan, and out of the dashboard.
 */
const textField = z
  .object({ ...fieldHeader, type: z.literal("text"), default: z.string().max(1024).optional() })
  .strict();

const urlField = z
  .object({ ...fieldHeader, type: z.literal("url"), default: z.string().max(1024).optional() })
  .strict();

const numberField = z
  .object({
    ...fieldHeader,
    type: z.literal("number"),
    default: z.number().finite().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict();

const booleanField = z
  .object({ ...fieldHeader, type: z.literal("boolean"), default: z.boolean().optional() })
  .strict();

const selectField = z
  .object({
    ...fieldHeader,
    type: z.literal("select"),
    options: z.array(configurationSelectOptionSchema).min(1).max(64),
    default: z.string().max(128).optional(),
  })
  .strict();

const connectionSlotField = z
  .object({
    ...fieldHeader,
    type: z.literal("connection_slot"),
    connectionSlot: connectionSlotIdSchema,
  })
  .strict();

export const configurationFieldSchema = z
  .discriminatedUnion("type", [
    textField,
    urlField,
    numberField,
    booleanField,
    selectField,
    connectionSlotField,
  ])
  .superRefine((field, context) => {
    if (field.type === "number" && field.min !== undefined && field.max !== undefined && field.max < field.min) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max"],
        message: "A number field's ceiling must be at least its floor",
      });
    }
    if (
      field.type === "select" &&
      field.default !== undefined &&
      !field.options.some((option) => option.value === field.default)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: "A select field's default must be one of its options",
      });
    }
  });

export const appConfigurationSchema = z
  .object({
    fields: z.array(configurationFieldSchema).max(64).default([]),
  })
  .strict();

export type ConfigurationFieldType = z.infer<typeof configurationFieldTypeSchema>;
export type ConfigurationField = z.infer<typeof configurationFieldSchema>;
export type AppConfiguration = z.infer<typeof appConfigurationSchema>;
