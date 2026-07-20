# Data Model: Enterprise Multi-Organization Creation

## Existing entities

### Organization (`accounts`)

The existing organization record remains the ownership boundary for memberships and workspaces. No columns change.

### User, membership, workspace, and session

Existing entities and relationships remain unchanged. Invitation acceptance creates or reuses a user and adds membership to the existing organization. Workspace creation remains scoped to an organization and does not consult organization-creation policy.

## OSS bootstrap state

No entity or schema change is introduced. Initialization is derived from an atomically committed existing organization graph while a PostgreSQL session advisory lock serializes the transition decision.

### Runtime transitions

```text
no accounts + lock free --reserve signup--> no accounts + lock held
lock held --begin core transaction--> account/user/owner/default-workspace writes uncommitted
core transaction --commit + unlock--> complete organization graph + lock free
core transaction --error/process loss--> all core writes rolled back
complete graph + lock free --post-commit effect failure--> compensating account deletion
compensating account deletion --success--> no organization graph + lock free
last account deleted --> no accounts + lock free
```

Additional OSS organization creation never enters this state machine; it is denied immediately. Enterprise replaces the policy and does not use this advisory-lock state machine.

## Invariants

- At most one OSS bootstrap workflow holds the namespaced database lock deployment-wide.
- Availability is false while the lock is held or an organization exists.
- Account, new user when applicable, owner membership, and default workspace commit together or roll back together.
- A crash after the core transaction commits may interrupt hooks, audit, or the HTTP response, but it leaves a complete usable organization graph rather than partial bootstrap rows.
- An orderly post-commit failure attempts the existing atomic account-delete compensation before releasing the policy reservation. The advisory lock has already been released with the completed core transaction; a compensation interruption leaves either the complete graph or no organization graph.
- A failed bootstrap releases its lock and leaves no partial core organization records.
- Workspace rows remain many-per-organization in both editions.
- Enterprise monthly counters remain per user and UTC month and apply only to additional organization creation.
