# Enterprise Auth Frontend Manifest

Commercial Radioso auth frontend compatibility package.

This package does not add routes to the frontend by itself. Generate the
Enterprise Edition frontend route files from the repository root before running
an EE frontend build:

```bash
node scripts/sync-ee-frontend-routes.mjs enable
RADIOSO_EDITION=enterprise pnpm --dir frontend run build
```

Password reset and email verification routes are OSS frontend routes now, so
this package currently contributes no Enterprise auth pages.

The package does not run a separate server.
