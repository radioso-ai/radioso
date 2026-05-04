# Radioso Enterprise Edition

This directory contains Radioso Enterprise Edition code. It is commercial
source-available software governed by [LICENSE](./LICENSE), not by the
open-source license that may apply to the rest of this repository.

Enterprise Edition packages live under `ee/packages` so they can keep package
boundaries without requiring a second repository.

## Local development

From the repository root:

```bash
./run-ee-dev.sh
```

This generates the Enterprise Edition frontend route files locally before
starting Next.js. The generated route files are ignored by git and are removed
again by the normal `./run-dev.sh` bootstrap path.

From this directory:

```bash
npm run build
npm test
```

## Usage limit profiles

The Enterprise backend module adds hosted usage limit profiles. Accounts without
an assigned profile remain unlimited. The seeded `starter_250` profile allows
250 customer-facing answer calls per UTC month and 250 stored documents across
all workspaces in the account.

Set `EE_USAGE_ADMIN_TOKEN` to enable the operator API:

```bash
EE_USAGE_ADMIN_TOKEN=change-me
```

Operator requests use `Authorization: Bearer <token>` against:

```text
/api/v1/ee/usage-limits
```

The API can list or upsert profiles, assign or clear an account profile, and
inspect an account's current usage for a UTC month.
