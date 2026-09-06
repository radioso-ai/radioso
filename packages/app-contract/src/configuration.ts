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

export const configurationSelectOptionSchema = z.object({
  value: z.string().min(1).max(128),
  label: displayNameSchema,
});

export const configurationFieldSchema = z
  .object({
    key: fieldKeySchema,
    type: configurationFieldTypeSchema,
    label: displayNameSchema,
    description: descriptionSchema.optional(),
    required: z.boolean(),
    default: z.union([z.string().max(1024), z.number().finite(), z.boolean()]).optional(),
    placeholder: z.string().max(200).optional(),
    options: z.array(configurationSelectOptionSchema).min(1).max(64).optional(),
    connectionSlot: connectionSlotIdSchema.optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .superRefine((field, context) => {
    if (field.type === "select" && !field.options) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "A select field must declare its options",
      });
    }
    if (field.type === "connection_slot" && !field.connectionSlot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connectionSlot"],
        message: "A connection_slot field must name the slot it binds",
      });
    }
  });

export const appConfigurationSchema = z.object({
  fields: z.array(configurationFieldSchema).max(64).default([]),
});

export type ConfigurationFieldType = z.infer<typeof configurationFieldTypeSchema>;
export type ConfigurationField = z.infer<typeof configurationFieldSchema>;
export type AppConfiguration = z.infer<typeof appConfigurationSchema>;
