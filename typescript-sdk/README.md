# Radioso TypeScript SDK

In-repo SDK package for token-based Radioso integrations.

## Status

- v1 is token-first.
- Session-only and browser-admin workflows are out of scope.
- Session-authenticated workspace CRUD is not part of the public v1 SDK.
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
- `client.settings.getIngestion()`
- `client.settings.updateIngestion(...)`
- `client.settings.reprocessIngestion()`
- `client.settings.getGeneral()`
- `client.settings.updateGeneral(...)`
- `client.documents.list(...)`
- `client.documents.create(...)`
- `client.documents.importFile(...)`
- `client.documents.get(...)`
- `client.documents.update(...)`
- `client.documents.delete(...)`
- `client.documents.search(...)`
- `client.documents.listHistory(...)`
- `client.documents.getHistory(...)`
- `client.documents.reprocess(...)`
- `client.chat.create(...)`
- `client.chat.listHistory(...)`
- `client.chat.getHistoryConversation(...)`
- `client.chat.stream(...)`

## Contract Refresh

1. Regenerate backend OpenAPI artifacts from the code-first registry.
2. Run `npm run sync` in `typescript-sdk/`.
3. Review the synced OpenAPI snapshot and generated SDK types.
4. Run SDK tests before release.
