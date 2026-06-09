import { z } from "zod";

import type { JsonRecord, ToolDefinition } from "../types.js";

export const metadataRecordSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export type MetadataRecord = JsonRecord;
export type GenericToolDefinition<TArgs = Record<string, unknown>> = ToolDefinition<TArgs>;
