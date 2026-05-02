# Enterprise Embed Widget

Commercial Radioso website embed package.

This package is imported by the OSS frontend when the frontend is built with:

```bash
RADIOSO_EE_FRONTEND=true
```

It provides:

- `/radioso-embed.js` route implementation
- `/embed/:token` page implementation
- `/api/embed/session/:token` route implementation
- shared client/UI code for the embedded chat surface

The package does not run a separate server.
