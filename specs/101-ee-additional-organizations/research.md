# Research: Enterprise Multi-Organization Creation

## Decision: Use an intent-aware organization-creation policy

**Rationale**: Signup and signed-in creation have different rules. A discriminated request (`signup` or `additional` with a user ID) lets auth orchestration call one narrow port without teaching routes about editions. Enterprise can allow signup without charging its existing monthly counter and continue charging only additional creation.

**Alternatives considered**: Separate signup and additional guards would duplicate lifecycle behavior. Checking the edition in routes would make UI/transport code authoritative and allow bypasses from other provisioning paths.

## Decision: Serialize OSS bootstrap with a PostgreSQL session advisory lock and transact core provisioning

**Rationale**: A fixed namespaced session advisory lock acquired through one pinned Kysely connection serializes the first-run decision across requests and server processes without a schema change. The empty-state check and core provisioning transaction run on that same pinned connection, which avoids a second pool checkout and remains safe when the pool size is one. Serialization alone is insufficient because process loss after an autocommit account insert could leave an incomplete organization that permanently closes registration. A narrow PostgreSQL provisioner therefore commits the account, new user when applicable, owner membership, and default workspace in one transaction while the guard retains the session lock. PostgreSQL rolls back an interrupted transaction and releases the session lock if its connection dies. Registration availability pins one connection, uses `pg_try_advisory_lock`, checks organization existence when acquired, and immediately unlocks, so an in-flight bootstrap reports unavailable.

**Alternatives considered**: An in-process mutex is not multi-process safe. A transaction advisory lock or `LOCK TABLE accounts` couples the edition decision to the core write transaction and does not cover post-transaction orchestration. Autocommit writes plus compensating deletion are insufficient for process death. A durable singleton bootstrap-state table can recover interrupted work but adds schema and state reconciliation that the user rejected in favor of atomic core persistence. Threading transaction parameters through `AuthService` and unrelated consumers would leak infrastructure; a narrow provisioner/unit-of-work adapter keeps the dependency direction explicit. Hooks, sessions, and audit stay outside the core transaction because extension hooks may not be transactional and session/audit failures already use account deletion as compensation. If the process dies after core commit, a complete usable organization remains; if an orderly post-commit step fails, the existing atomic account deletion/cascade compensation is attempted before releasing the reservation.

## Decision: Keep post-transaction effects outside the core atomic boundary

**Rationale**: `onAccountCreated`, session creation, and audit recording are orchestration effects, not required rows in the minimum usable organization graph. Preserving their existing order avoids moving Enterprise extension behavior into OSS persistence. After core commit, failures continue through the existing account-deletion compensation path; that deletion is atomic and cascades account-owned rows. A crash before core commit leaves nothing, while a crash after core commit leaves a complete organization graph rather than a partial bootstrap. The organization is therefore considered durably created at core commit even if the request is interrupted before its response.

**Alternatives considered**: Running extension hooks inside the transaction would hand an open transaction across a composition boundary and still could not make external effects atomic. Treating post-commit effects as part of the crash-atomic graph would require an outbox/recovery workflow outside this feature's scope.

## Decision: Make registration availability policy-owned and read-only

**Rationale**: The auth page needs server initialization state, but the client must not infer it. The policy answers availability by trying the same advisory lock and checking existing organizations on that connection. Enterprise always reports available.

**Alternatives considered**: Returning account counts leaks unnecessary deployment detail. Build-time edition alone cannot represent empty versus initialized OSS state.

## Decision: Retry transient registration-availability failures without signup flash

**Rationale**: The frontend can start before the backend during first run. A bounded retry plus explicit retry affordance keeps registration hidden until the server answers, then recovers without a page reload.

**Alternatives considered**: Treating an error as available would weaken the server-guided experience and flash an action that may be rejected. A single silent request leaves first-run users stuck until manual reload.

## Decision: Guard all new-account provisioning paths

**Rationale**: Password registration and fresh federated login both create organizations. Applying the signup intent in `AuthService` prevents optional identity providers from bypassing the OSS boundary. Invitation acceptance does not create an organization and remains unguarded.

**Alternatives considered**: Guarding only `POST /auth/register` leaves federated provisioning and future transports as bypasses.

## Decision: Keep denial audit metadata fixed and sanitized

**Rationale**: Audit records use event type, actor user ID when authenticated, fixed reason, and safe rate-limit details. They omit organization name, email, password, cookies, tokens, and raw error content.

**Alternatives considered**: Reusing request bodies or exception messages would expose customer content and create unstable operator semantics.

## Decision: No queue, SDK, MCP, or connector work

**Rationale**: The feature changes auth/account HTTP authorization and adds a read-only auth endpoint. It does not alter document jobs, AMQP payloads, retries, shared worker contracts, SDK workflow contracts, MCP tools, or connector contracts.

**Alternatives considered**: None; queue changes would be unrelated scope.
