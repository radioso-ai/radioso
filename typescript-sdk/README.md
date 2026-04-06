# Radioso TypeScript SDK

In-repo SDK package for token-based Radioso integrations.

## Status

- v1 is token-first.
- Session-only and browser-admin workflows are out of scope.
- The SDK contract snapshot is synced from `../backend/openapi.json` and `../backend/openapi.yaml`.

## Development

```bash
npm install
npm run sync
npm run test
npm run build
```

## Public Surface

- `createRadiosoClient({ baseUrl, apiToken })`
- `client.settings.getRetrieval()`
- `client.settings.updateRetrieval(...)`
- `client.documents.list(...)`
- `client.documents.create(...)`
- `client.documents.get(...)`
- `client.documents.update(...)`
- `client.documents.delete(...)`
- `client.documents.search(...)`
- `client.chat.create(...)`
- `client.chat.stream(...)`

## Contract Refresh

1. Regenerate backend OpenAPI artifacts from the code-first registry.
2. Run `npm run sync` in `typescript-sdk/`.
3. Review the synced OpenAPI snapshot and generated SDK types.
4. Run SDK tests before release.
