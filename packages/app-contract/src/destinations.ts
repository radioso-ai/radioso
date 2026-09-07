import { z } from "zod";

import {
  connectionSlotIdSchema,
  declaredHeaderNameSchema,
  destinationIdSchema,
  fieldKeySchema,
  type FieldKey,
} from "./identifiers.js";

/**
 * Every network address an App may reach is declared here and nowhere else. A
 * host is either a fixed pattern the author knows at publish time or a field the
 * operator fills in, which is what makes one release usable against many sites.
 */
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/**
 * `http` is here because a self-hosted site reachable only over plain HTTP is a
 * real, currently-working installation. Admitting it narrowly — declared,
 * operator-visible on the grant screen, one destination at a time — is what lets
 * those installations move onto the runtime instead of being stranded by it.
 */
export const destinationProtocols = ["https", "http"] as const;
export const destinationProtocolSchema = z.enum(destinationProtocols);

/** What leaves the platform on this destination, shown to the operator on the grant screen. */
export const destinationDataClasses = [
  "document_content",
  "document_metadata",
  "installation_configuration",
  "credentials",
  "operational_metadata",
] as const;
export const destinationDataClassSchema = z.enum(destinationDataClasses);

/**
 * A `configuration` host names a `url` field, and that URL is an origin prefix:
 * the broker keeps its scheme, host, port, and path, and appends an
 * `egress.fetch` request's origin-relative `path` below it. A site installed at
 * `https://example.com/wordpress` therefore reaches
 * `https://example.com/wordpress/wp-json/wp/v2/posts`, and no request an App
 * makes can climb above the prefix the operator entered.
 */
export const destinationHostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pattern"), pattern: z.string().regex(HOST_PATTERN) }).strict(),
  z.object({ kind: z.literal("configuration"), field: fieldKeySchema }).strict(),
]);

/**
 * How the broker turns a bound connection slot into an authenticated request.
 * The App never holds the secret, so something has to say what to build out of
 * it — and it has to be a closed vocabulary, because a host that read the slot's
 * name to decide would be one App's convention wearing a generic contract.
 */
export const destinationCredentialApplicationSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("http_basic"),
      usernameField: fieldKeySchema,
      passwordField: fieldKeySchema,
    })
    .strict(),
  z.object({ mode: z.literal("bearer"), tokenField: fieldKeySchema }).strict(),
  z
    .object({ mode: z.literal("header"), header: declaredHeaderNameSchema, valueField: fieldKeySchema })
    .strict(),
]);

/**
 * `required: false` says the destination serves anonymous requests too: the
 * broker sends the request unauthenticated while the slot is unbound and
 * injects the credential once it is bound. That is what lets one release cover
 * an installation that reads public content and one that reads private content.
 */
export const destinationCredentialsSchema = z
  .object({
    slot: connectionSlotIdSchema,
    application: destinationCredentialApplicationSchema,
    required: z.boolean(),
  })
  .strict();

/**
 * Every connection field one application mode names, where it names it, and
 * whether that field carries the secret half of the credential. Admission uses
 * the last flag to insist the secret half is stored as one: a username the
 * dashboard may show again is not the same kind of value as the password beside
 * it. Validator plumbing, so it stays inside the package.
 */
interface CredentialFieldReference {
  path: string;
  field: FieldKey;
  secret: boolean;
}

export const credentialFieldReferences = (
  application: DestinationCredentialApplication,
): readonly CredentialFieldReference[] => {
  switch (application.mode) {
    case "http_basic":
      return [
        { path: "usernameField", field: application.usernameField, secret: false },
        { path: "passwordField", field: application.passwordField, secret: true },
      ];
    case "bearer":
      return [{ path: "tokenField", field: application.tokenField, secret: true }];
    case "header":
      return [{ path: "valueField", field: application.valueField, secret: true }];
  }
};

/**
 * What a protocol reaches when a destination declares no `ports`. Omitting the
 * field is not "any port": it is the default port of each declared protocol, so
 * a manifest that means 8443 has to say 8443 and an operator's grant screen
 * never widens by silence.
 */
export const DEFAULT_PROTOCOL_PORTS: Readonly<Record<DestinationProtocol, number>> = {
  https: 443,
  http: 80,
};

/** The ports one destination permits on one protocol: exactly what it declared, or that protocol's default. */
export const destinationPortsForProtocol = (
  destination: Destination,
  protocol: DestinationProtocol,
): readonly number[] => destination.ports ?? [DEFAULT_PROTOCOL_PORTS[protocol]];

/**
 * Every protocol and port pair one destination permits, spelled so two
 * destinations can be intersected. A destination is reachable only where a pair
 * survives that intersection: two views of one operator-typed address that agree
 * on a scheme but not on a port describe an installation no URL can satisfy.
 */
export const destinationEndpoints = (destination: Destination): readonly string[] =>
  destination.protocols.flatMap((protocol) =>
    destinationPortsForProtocol(destination, protocol).map((port) => `${protocol}:${port}`),
  );

export const destinationSchema = z.object({
  id: destinationIdSchema,
  host: destinationHostSchema,
  protocols: z.array(destinationProtocolSchema).min(1).max(destinationProtocols.length),
  ports: z.array(z.number().int().min(1).max(65535)).max(4).optional(),
  purpose: z.string().min(1).max(256),
  dataClasses: z.array(destinationDataClassSchema).min(1).max(destinationDataClasses.length),
  credentials: destinationCredentialsSchema.optional(),
}).strict();

export type DestinationProtocol = z.infer<typeof destinationProtocolSchema>;
export type DestinationDataClass = z.infer<typeof destinationDataClassSchema>;
export type DestinationHost = z.infer<typeof destinationHostSchema>;
export type DestinationCredentialApplication = z.infer<typeof destinationCredentialApplicationSchema>;
export type DestinationCredentials = z.infer<typeof destinationCredentialsSchema>;
export type Destination = z.infer<typeof destinationSchema>;
