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
| `src/requirements.ts` | What one installation must supply: `validateConfigurationValues` and `requiredConnectionSlotsFor` |
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

`tests/wordpressInterop.test.ts` runs the other half against recorded
deliveries in `tests/fixtures/wordpress-companion/`: five bodies plus their
signatures, verified over the recorded bytes and mapped onto the host capability
calls the contract accepts. The bodies are written by hand to reproduce what
`wp_json_encode()` emits — escaped slashes, escaped non-ASCII, PHP float
formatting, MySQL datetimes — because PHP is not available in this
repository's toolchain; the signature over each one is computed in Node from
those exact bytes. That fixture directory's `README.md` states the procedure and
the recompute command. A verifier that parses and re-serializes before checking
the HMAC fails these vectors, which is what they exist to catch.

Two digests in it are placeholders of 64 zeros: `artifact.digest` and the
`radioso-sync.zip` companion asset. Nothing in this package builds either
artifact, so nothing here can compute them; the digest shape is what the fixture
exercises.

## Docs

- [App Manifest Reference](../../docs/apps/app-manifest.md)
- [App Runtime Protocol](../../docs/apps/runtime-protocol.md)
- Feature artifacts: `specs/1118-hosted-app-runtime/`
