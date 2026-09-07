import { z } from "zod";

/**
 * Every identifier in a manifest is structural: the host matches shape only and
 * never reads meaning out of a name. Author-chosen keys share one lower-case
 * snake shape so a contribution id, a collection id, a slot id, a destination
 * id, and a configuration key are all addressable the same way.
 */
const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u;
const LOCAL_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
/**
 * An indexed-field key is the one key space an App does not own: it comes from
 * the system being synced — a WooCommerce `ISBN`, a CRM `AccountTier` — and a
 * metadata rule addresses it by splitting on ".". So it is case-capable while
 * every author-chosen identifier stays lower-case snake.
 */
const INDEXED_FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
/**
 * An HTTP field name, in the one shape every side of the boundary uses: a
 * webhook signature header, an egress header, and a credential header are the
 * same kind of name, so they share one rule rather than three copies of it.
 */
const HTTP_HEADER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const COMPARATOR = String.raw`(?:[<>]=?|=|\^|~)?(?:\*|\d+(?:\.(?:\d+|[xX]|\*)){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)`;
const CONJUNCTION = `${COMPARATOR}(?: +${COMPARATOR})*`;
const SEMANTIC_VERSION_RANGE_PATTERN = new RegExp(`^${CONJUNCTION}(?: *\\|\\| *${CONJUNCTION})*$`, "u");

const localKey = (label: string): z.ZodString =>
  z.string().regex(LOCAL_KEY_PATTERN, `${label} must be lower-case snake case, 1 to 64 characters`);

export const appIdSchema = z
  .string()
  .regex(APP_ID_PATTERN, "App id must be a lower-case reverse-DNS name such as ai.radioso.wordpress");

export const contributionIdSchema = localKey("Contribution id");
export const collectionIdSchema = localKey("Collection id");
export const connectionSlotIdSchema = localKey("Connection slot id");
export const destinationIdSchema = localKey("Destination id");
export const indexIdSchema = localKey("Index id");
export const fieldKeySchema = localKey("Field key");
export const indexedFieldKeySchema = z
  .string()
  .regex(
    INDEXED_FIELD_KEY_PATTERN,
    "Indexed field key must start with a letter and hold letters, digits, and underscores, 1 to 64 characters",
  );
export const fixtureIdSchema = localKey("Fixture id");
export const httpHeaderNameSchema = z
  .string()
  .regex(
    HTTP_HEADER_NAME_PATTERN,
    "Header name must start with a letter or digit and hold letters, digits, and hyphens, 1 to 64 characters",
  );
export const assetIdSchema = localKey("Asset id");

export const digestSchema = z
  .string()
  .regex(DIGEST_PATTERN, "Digest must be sha256: followed by 64 lower-case hex characters");

export const semanticVersionSchema = z.string().regex(SEMANTIC_VERSION_PATTERN, "Version must be semantic");

export const semanticVersionRangeSchema = z
  .string()
  .regex(SEMANTIC_VERSION_RANGE_PATTERN, "Compatibility must be a semantic version range");

/**
 * A contribution's input and output shapes version independently of the App's
 * release, so a queued job says which shape it was written against and a host
 * refuses one it cannot read rather than half-reading it.
 */
export const schemaVersionSchema = z.number().int().min(1).max(1_000_000);

/** Short human-readable label shown to an operator. */
export const displayNameSchema = z.string().min(1).max(120);
/** One or two sentences shown beside a label. */
export const descriptionSchema = z.string().min(1).max(500);
/** An RFC 3339 instant carried across the wire as a string. */
export const timestampSchema = z.string().datetime({ offset: true });

export type AppId = z.infer<typeof appIdSchema>;
export type ContributionId = z.infer<typeof contributionIdSchema>;
export type CollectionId = z.infer<typeof collectionIdSchema>;
export type ConnectionSlotId = z.infer<typeof connectionSlotIdSchema>;
export type DestinationId = z.infer<typeof destinationIdSchema>;
export type FieldKey = z.infer<typeof fieldKeySchema>;
export type IndexedFieldKey = z.infer<typeof indexedFieldKeySchema>;
export type Digest = z.infer<typeof digestSchema>;
export type SemanticVersion = z.infer<typeof semanticVersionSchema>;
export type SemanticVersionRange = z.infer<typeof semanticVersionRangeSchema>;
