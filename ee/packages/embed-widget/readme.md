# Enterprise Embed Widget

Commercial Radioso website embed package.

This package does not add routes to the frontend by itself. Generate the
Enterprise Edition frontend route files from the repository root before running
an EE frontend build:

```bash
node scripts/sync-ee-frontend-routes.mjs enable
RADIOSO_EDITION=enterprise npm run build --prefix frontend
```

It provides:

- `/radioso-embed.js` route implementation
- `/embed/:token` page implementation
- `/api/embed/session/:token` route implementation
- the embedded chat frame

The package does not run a separate server.
