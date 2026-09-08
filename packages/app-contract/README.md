# @radioso/app-contract

The vocabulary shared by everything that touches a Radioso App: what a manifest
may declare, what an invocation looks like on the wire, and what a host admits.
Zod schemas and pure functions, nothing else.

Knowing only that keeps the package usable from every side of the boundary — the
API process, a worker, an App running as its own program, and the conformance
harness all validate the same bytes with the same rules. That is also why the
only dependency is `zod`: imports from `backend/`, `frontend/`, or another
Radioso package would tie the contract to one side of it.

## Layout

| File | Owns |
|---|---|
| `src/identifiers.ts` | Structural shapes: app ids, local keys, indexed-field keys, digests, semantic versions and ranges |
| `src/bounds.ts` | Size, depth, and encoding bounds for every free-form value the protocol carries |
| `src/configuration.ts` | The bounded configuration field vocabulary |
| `src/connections.ts` | Connection slot declarations |
| `src/destinations.ts` | Declared network destinations and their data classes |
| `src/storage.ts` | Collection declarations and the scoped storage operations |
| `src/contributions.ts` | The closed contribution catalog, host permissions, execution classes |
| `src/setup.ts` | Setup guide and companion asset declarations |
| `src/manifest.ts` | The `AppManifest` schema |
| `src/runtime.ts` | Invocation and host capability envelopes, including the installation context every invocation carries |
| `src/jobs.ts` | The App Job wake-up envelope |
| `src/validate.ts` | `validateManifest`: schema pass, cross-reference pass, policy pass |
| `src/requirements.ts` | What one installation supplies and what that turns on: `resolveInstallation` |
| `src/index.ts` | The public surface; re-exports only |

## Tests

```bash
pnpm --filter @radioso/app-contract test
pnpm --filter @radioso/app-contract build
```

## The reference fixture

`fixtures/reference/wordpress.manifest.json` is the conformance vector: a
manifest for the WordPress App, validated by `tests/wordpressFixture.test.ts`
against `releaseAValidationPolicy`. It exercises every section a real App uses —
a configuration-bound destination, both connection slot kinds, a storage
collection with an index, and all three Release A contribution kinds.

`tests/wordpressInterop.test.ts` runs the other half against synthetic
companion-shaped vectors in `tests/fixtures/wordpress-companion/`: five bodies
plus their signatures, verified over those exact bytes and mapped onto the host
capability calls the contract accepts. PHP is not part of this repository's
toolchain, so the bodies are written by hand to reproduce what `wp_json_encode()`
emits under WordPress's default flags — escaped slashes, `\uXXXX`-escaped
non-ASCII, a zero-fraction float as an integer literal, MySQL datetimes — and the
signature over each one is computed in Node from those bytes. That fixture
directory's `README.md` lists the rules reproduced and the recompute command. A
verifier that parses and re-serializes before checking the HMAC fails these
vectors, which is what they exist to catch.

Two digests in it are placeholders of 64 zeros: `artifact.digest` and the
`radioso-sync.zip` companion asset. Nothing in this package builds either
artifact, so nothing here can compute them; the digest shape is what the fixture
exercises.

## Installation shape

An installation's stored configuration is sparse: the host keeps what the
operator typed, and the manifest owns the rest. `resolveInstallation(manifest,
storedValues)` is the one door that closes that gap. It bounds the stored map,
copies it, materializes every declared default, and validates the map that
results, then answers which contributions run and which connection slots the
operator has to bind:

```ts
const admitted = validateManifest(manifest, releaseAValidationPolicy);
if (admitted.ok) {
  const resolved = resolveInstallation(admitted.manifest, storedValues);
  if (resolved.ok) {
    resolved.configuration; // context.configuration, exactly
    resolved.readiness; // active and inactive contributions, required slots
  }
}
```

`resolveInstallation` takes only the `AdmittedManifest` that `validateManifest`
returns, not any manifest that merely parses, so admission is one boundary
rather than a partial second copy of it inside resolution. A schedule bound to
a field that is not a required or defaulted number, or a destination host bound
to a field that is not a `url` field, can never reach `resolveInstallation` in
the first place. A host that stores a manifest re-runs `validateManifest` on
load to regain the admitted value.

`AdmittedManifest` is deeply frozen and typed transitively `readonly` down to
every nested array and object, not only at the top level, so a call like
`admitted.contributions[0].requiredConnectionSlots.push(...)` is a type error
and throws if a cast forces it through. A spread of an admitted manifest
(`{ ...admitted }`) is a plain, unfrozen copy that still types as admitted —
TypeScript carries the phantom brand through a spread — but `resolveInstallation`
checks runtime admission identity, not only the type, and rejects a copy with
an `unadmitted_manifest` issue rather than trusting it. Pass the admitted value
itself to `resolveInstallation`, never a spread of it; `isAdmittedManifest`
exposes that same identity check for any other caller that needs it.

The configuration holds every required value field, every field that declares a
default, and every optional field the operator supplied. A `connection_slot`
field never appears: its value lives in the slot. The map is frozen and its type
carries a brand this package does not export, so a stored map cannot be spelled
as a resolved one and a resolved one cannot be edited after the fact. Resolution
and readiness come back together because they are one answer — a caller holding
them apart could resolve against one manifest and ask readiness about another.

Readiness takes no caller-supplied contribution list: a `required` contribution
is always active, and the only thing that turns one off is a schedule the
operator disabled by storing the schedule's own `disabledValue`.

A schedule read from configuration declares a closed interval range, so its
field's value space is exactly two things: the sentinel, or a whole number of
seconds between `minSeconds` and `maxSeconds`. Admission holds the field's
default to that same rule and refuses a schedule bound to a field an installation
could leave empty, so readiness never meets an absent value or one it would have
to interpret.

## Destination ports

A destination that declares no `ports` reaches the default port of each protocol
it declares: 443 on `https`, 80 on `http`. One that declares `ports` reaches
exactly those, and declares at least one. Resolution holds a destination-bound
URL to it, admission holds the field's `default` to it through the same check, and
admission proves that the destinations sharing one field have a protocol and a
port in common — the operator types one address, and it has one scheme and one
port.

## Egress paths

An `egress.fetch` `path` is origin-relative and canonically encoded: every `%`
introduces two hex digits, and no escape spells a separator, a percent, or a
control character. What is left decodes exactly once, as UTF-8 and no other way,
and no segment of the result is `.` or `..`, so `/../wp-admin`,
`/%2e%2e%2fwp-admin`, `/%252e%252e/wp-admin`, and the overlong
`/%C0%AE%C0%AE/wp-admin` are one refusal rather than four spellings that climb
above the operator's prefix at whichever hop decodes first. Invalid UTF-8 and
unpaired surrogates are refused for the same reason.

## Bounded maps

Every map the protocol carries — headers, query, metadata, indexed fields, and an
installation's stored configuration — is read by descriptor: an own accessor and
an inherited enumerable key are both refused before any value is read, so a
validation call never runs a caller's getter and never walks a key an object does
not carry. What passes is copied into a null-prototype map before anything
downstream sees it.

## Docs

- [App Manifest Reference](../../docs/apps/app-manifest.md)
- [App Runtime Protocol](../../docs/apps/runtime-protocol.md)
- Feature artifacts: `specs/1118-hosted-app-runtime/`
