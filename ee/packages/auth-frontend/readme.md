# Enterprise Auth Frontend

Commercial Radioso auth UI package.

This package does not add routes to the frontend by itself. Generate the
Enterprise Edition frontend route files from the repository root before running
an EE frontend build:

```bash
node scripts/sync-ee-frontend-routes.mjs enable
RADIOSO_EDITION=enterprise npm run build --prefix frontend
```

It provides:

- `/reset-password` page implementation
- `/verify-email` page implementation

The package does not run a separate server.
