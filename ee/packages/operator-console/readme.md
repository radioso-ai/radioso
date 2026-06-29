# Enterprise Operator Console

Enterprise-only frontend package for the staff Operator Console.

Routes are contributed through `feature-manifest.mjs` and synced into the
Next.js app with:

```bash
node scripts/sync-ee-frontend-routes.mjs enable
```

The console talks only to `/api/v1/ee/operator-console/*` with the staff session
cookie. It does not share customer dashboard authentication.
