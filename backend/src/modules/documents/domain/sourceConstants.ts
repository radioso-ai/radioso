import { z } from "zod";

export const MANUALLY_ADDED_DOCUMENTS_SOURCE_ID = "00000000-0000-0000-0000-000000000001";

/**
 * A document source id, as the API lists it and clients send it back. Lenient GUID shape, not
 * `z.uuid()`: the manually-added source's id above is not an RFC 9562 UUID (its version digit is
 * 0), and a strict check would turn a request naming it into a validation failure. Still
 * documented as `format: uuid`, the format's lenient reading, which the generators omit for a GUID.
 */
export const documentSourceIdSchema = z.guid().meta({ format: "uuid" });
