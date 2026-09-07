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
| `src/requirements.ts` | What one installation supplies and what that turns on: `resolveConfiguration` and `installationReadiness` |
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
operator typed, and the manifest owns the rest. `resolveConfiguration(manifest,
storedValues)` is the one operation that closes that gap. It bounds the stored
map, copies it, materializes every declared default, and validates the map that
results, so what it returns is the effective configuration — the exact map an
invocation carries as `context.configuration`.

It returns an `EffectiveConfiguration`, a branded type nothing else produces.
`installationReadiness(manifest, effectiveConfiguration)` takes that type and
only that type, and answers which contributions run and which connection slots
the operator has to bind. Neither answer takes a caller-supplied contribution
list: a `required` contribution is always active, and the only thing that turns
one off is a schedule the operator disabled by storing the schedule's own
`disabledValue`.

A schedule read from configuration declares a closed interval range, so its
field's value space is exactly two things: the sentinel, or a whole number of
seconds between `minSeconds` and `maxSeconds`. Resolution holds a stored value to
that, which is why readiness never meets a value it would have to interpret.

## Docs

- [App Manifest Reference](../../docs/apps/app-manifest.md)
- [App Runtime Protocol](../../docs/apps/runtime-protocol.md)
- Feature artifacts: `specs/1118-hosted-app-runtime/`
