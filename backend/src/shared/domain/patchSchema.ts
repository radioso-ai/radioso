import { z } from "zod";

/** The field minus the `.default()` that fills an absent value, also where a transform follows it. */
const withoutDefault = (field: z.core.$ZodType): z.core.$ZodType => {
  const def = (field as z.core.$ZodTypes)._zod.def;
  if (def.type === "default" || def.type === "prefault") return def.innerType;
  if (def.type === "pipe") {
    const input = withoutDefault(def.in);
    return input === def.in ? field : z.pipe(input, def.out);
  }
  return field;
};

/**
 * The PATCH form of an object schema: every key optional, and a key the patch leaves out stays
 * out. `.partial()` alone no longer promises the second half — Zod 4 hands an absent key to the
 * field's `.default()`, so a patch omitting a defaulted field would carry the default and write
 * it over the stored value. A key the patch carries parses exactly as the full schema parses it,
 * and the full schema's unknown-key policy holds.
 */
export const patchSchemaOf = <Shape extends z.core.$ZodShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>,
): z.ZodObject<{ -readonly [Key in keyof Shape]: z.ZodOptional<Shape[Key]> }, Config> => {
  const undefaulted = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [key, withoutDefault(field)]),
  );
  // Same keys, same output types: only the absent-value default is gone from each field.
  return schema.extend(undefaulted).partial() as unknown as z.ZodObject<
    { -readonly [Key in keyof Shape]: z.ZodOptional<Shape[Key]> },
    Config
  >;
};
