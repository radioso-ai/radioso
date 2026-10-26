import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

/**
 * Adds `.openapi()` to Zod schemas. Zod 4 copies `ZodType.prototype` members onto each schema
 * as it is built rather than reading them through the prototype chain, so only schemas built
 * after this runs carry the method — and the OpenAPI document reaches route and domain schemas
 * defined at module scope everywhere. A process that builds the document therefore imports this
 * module ahead of every other import; `registry.register()` and each `.openapi()` call throw on a
 * schema built before it.
 */
extendZodWithOpenApi(z);

/**
 * A registered component, or null, documented as `anyOf: [{ $ref }, { type: "null" }]`. The
 * generator flattens a union nested in a union, so `z.union([registeredUnion, z.null()])` would
 * inline the component's members, and `.nullable()` on a registered schema keeps its component id
 * and drops the null. The lazy indirection is the one wrapper it neither flattens nor renames; it
 * parses exactly as the component does.
 */
export const nullableComponent = <T extends z.ZodType>(component: T) =>
  z.union([z.lazy(() => component), z.null()]);
