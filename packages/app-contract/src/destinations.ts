import { z } from "zod";

import {
  connectionSlotIdSchema,
  declaredHeaderNameSchema,
  destinationIdSchema,
  fieldKeySchema,
  type FieldKey,
} from "./identifiers.js";
import type { DeepReadonly } from "./readonly.js";

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
const DEFAULT_PROTOCOL_PORTS: Readonly<Record<DestinationProtocol, number>> = {
  https: 443,
  http: 80,
};

/** The ports one destination permits on one protocol: exactly what it declared, or that protocol's default. */
const destinationPortsForProtocol = (
  destination: DeepReadonly<Destination>,
  protocol: DestinationProtocol,
): readonly number[] => destination.ports ?? [DEFAULT_PROTOCOL_PORTS[protocol]];

/**
 * Every protocol and port pair one destination permits, spelled so two
 * destinations can be intersected. A destination is reachable only where a pair
 * survives that intersection: two views of one operator-typed address that agree
 * on a scheme but not on a port describe an installation no URL can satisfy.
 */
export const destinationEndpoints = (destination: DeepReadonly<Destination>): readonly string[] =>
  destination.protocols.flatMap((protocol) =>
    destinationPortsForProtocol(destination, protocol).map((port) => `${protocol}:${port}`),
  );

export const destinationSchema = z.object({
  id: destinationIdSchema,
  host: destinationHostSchema,
  protocols: z.array(destinationProtocolSchema).min(1).max(destinationProtocols.length),
  // Present and empty is not "no restriction": it is a destination no address
  // can satisfy, which admits at release and then denies every request.
  ports: z.array(z.number().int().min(1).max(65535)).min(1).max(4).optional(),
  purpose: z.string().min(1).max(256),
  dataClasses: z.array(destinationDataClassSchema).min(1).max(destinationDataClasses.length),
  credentials: destinationCredentialsSchema.optional(),
}).strict();

/**
 * Why one address cannot serve one destination. A reason is a stable token
 * rather than a sentence, because two callers report it in two places: admission
 * reads it against a `url` field's declared default, and resolution reads it
 * against the value an operator stored. One check, so the two cannot drift into
 * a manifest that is admitted and an installation that can never resolve.
 */
type DestinationUrlRejection =
  | { reason: "url_carries_query_or_fragment" }
  | { reason: "url_carries_userinfo" }
  | { reason: "url_protocol_not_declared"; destination: string; protocols: readonly string[] }
  | { reason: "url_port_not_declared"; destination: string; protocol: string; ports: readonly number[] };

const parsedUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * Which port an address actually reaches. `URL` drops a port that is its
 * scheme's default, so an address that names none reaches the default the
 * destination is measured against — and `https://example.com:8443` reaches 8443,
 * which a destination has to have declared.
 */
const effectivePort = (url: URL): number | null => {
  if (url.port !== "") return Number(url.port);
  const scheme = url.protocol.replace(":", "");
  if (scheme === "https" || scheme === "http") return DEFAULT_PROTOCOL_PORTS[scheme];
  return null;
};

/**
 * A URL a destination's host is built from carries more than a URL: it decides
 * the scheme the broker speaks, the port it reaches, and — through userinfo —
 * could hand the App's own requests a credential the manifest never declared.
 * None of that belongs in a value space an author or an operator types into
 * freely. A value that is not a URL at all is not this function's answer; the
 * field's own type reports that first.
 */
export const checkDestinationBoundUrl = (
  value: string,
  destinations: readonly DeepReadonly<Destination>[],
): readonly DestinationUrlRejection[] => {
  if (destinations.length === 0) return [];
  const url = parsedUrl(value);
  if (!url) return [];
  const rejections: DestinationUrlRejection[] = [];
  if (url.search !== "" || url.hash !== "") rejections.push({ reason: "url_carries_query_or_fragment" });
  if (url.username !== "" || url.password !== "") rejections.push({ reason: "url_carries_userinfo" });
  const scheme = url.protocol.replace(":", "");
  const port = effectivePort(url);
  for (const destination of destinations) {
    const protocol = destination.protocols.find((candidate) => candidate === scheme);
    if (protocol === undefined) {
      rejections.push({
        reason: "url_protocol_not_declared",
        destination: destination.id,
        protocols: destination.protocols,
      });
      continue;
    }
    const ports = destinationPortsForProtocol(destination, protocol);
    if (port !== null && ports.includes(port)) continue;
    rejections.push({ reason: "url_port_not_declared", destination: destination.id, protocol, ports });
  }
  return rejections;
};

/**
 * The destinations one configuration field is the host of. Admission and
 * resolution both need it, and both need the same answer: every destination
 * bound to a field is a view of the one address that field holds.
 */
export const destinationsByHostField = (
  destinations: readonly DeepReadonly<Destination>[],
): ReadonlyMap<string, DeepReadonly<Destination>[]> => {
  const bound = new Map<string, DeepReadonly<Destination>[]>();
  for (const destination of destinations) {
    if (destination.host.kind !== "configuration") continue;
    const existing = bound.get(destination.host.field);
    if (existing) existing.push(destination);
    else bound.set(destination.host.field, [destination]);
  }
  return bound;
};

/** One sentence per rejection, written once so both callers say the same thing. */
export const destinationUrlRejectionMessage = (rejection: DestinationUrlRejection): string => {
  switch (rejection.reason) {
    case "url_carries_query_or_fragment":
      return "A destination address is an origin prefix; a request's own path and query are supplied per call";
    case "url_carries_userinfo":
      return "A destination address holds no user name or password; credentials belong in a connection slot";
    case "url_protocol_not_declared":
      return `Destination ${rejection.destination} reaches ${rejection.protocols.join(" and ")} addresses only`;
    case "url_port_not_declared":
      return `Destination ${rejection.destination} reaches ${rejection.protocol} port ${rejection.ports.join(" and ")} only`;
  }
};

export type DestinationProtocol = z.infer<typeof destinationProtocolSchema>;
export type DestinationDataClass = z.infer<typeof destinationDataClassSchema>;
export type DestinationHost = z.infer<typeof destinationHostSchema>;
export type DestinationCredentialApplication = z.infer<typeof destinationCredentialApplicationSchema>;
export type DestinationCredentials = z.infer<typeof destinationCredentialsSchema>;
export type Destination = z.infer<typeof destinationSchema>;
