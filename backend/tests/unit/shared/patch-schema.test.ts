import { describe, expect, it } from "vitest";
import { z } from "zod";

import { patchSchemaOf } from "../../../src/shared/domain/patchSchema.js";

const settings = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  tags: z.array(z.string()).optional().default([]).transform((values) => [...new Set(values)]),
  scope: z.enum(["all", "selected"]).default("all"),
  note: z.string().optional(),
}).strict();

describe("patchSchemaOf", () => {
  it("leaves a key the patch omits absent, even when the full schema defaults it", () => {
    expect(patchSchemaOf(settings).parse({ name: "Support" })).toEqual({ name: "Support" });
    expect(patchSchemaOf(settings).parse({})).toEqual({});
  });

  it("parses a key the patch carries exactly as the full schema does", () => {
    expect(patchSchemaOf(settings).parse({ enabled: false, tags: ["a", "a", "b"], scope: "selected" }))
      .toEqual({ enabled: false, tags: ["a", "b"], scope: "selected" });
    expect(patchSchemaOf(settings).safeParse({ name: "" }).success).toBe(false);
    expect(patchSchemaOf(settings).safeParse({ scope: "some" }).success).toBe(false);
  });

  it("keeps the full schema's unknown-key policy", () => {
    expect(patchSchemaOf(settings).safeParse({ unknown: true }).success).toBe(false);
  });

  it("leaves the full schema's own defaults in place", () => {
    patchSchemaOf(settings);
    expect(settings.parse({ name: "Support" })).toEqual({ name: "Support", enabled: true, tags: [], scope: "all" });
  });
});
