import { z } from "zod";

import { normalizeVectorMetadataFilter } from "../../../modules/retrieval/public.js";

const MAX_METADATA_FILTER_BYTES = 16384;

export const metadataFilterSchema = z.record(z.unknown()).optional().superRefine((value, ctx) => {
  if (!value) {
    return;
  }

  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_METADATA_FILTER_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Metadata filter must be 16 KB or less",
    });
    return;
  }

  try {
    normalizeVectorMetadataFilter(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Metadata filter contains unsupported values",
    });
  }
});
