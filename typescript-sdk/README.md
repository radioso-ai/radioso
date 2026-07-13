# Radioso TypeScript SDK

In-repo SDK package for token-based Radioso integrations.

## Status

- v1 is token-first.
- Session-only and browser-admin workflows are out of scope.
- Session-authenticated workspace CRUD is not part of the public v1 SDK.
- The SDK contract snapshot is synced from `../backend/openapi.json` and `../backend/openapi.yaml`.

## Development

```bash
pnpm install --filter @radioso/typescript-sdk...
pnpm run sync
pnpm run test
pnpm run build
```

## Public Surface

- `createRadiosoClient({ baseUrl, apiToken })`
- `client.settings.getIngestion()`
- `client.settings.updateIngestion(...)`
- `client.settings.reprocessIngestion(...)`
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
- `client.documents.reprocessSource(...)`
- `client.chat.create(...)`
- `client.chat.listHistory(...)`
- `client.chat.getHistoryConversation(...)`
- `client.chat.stream(...)`

## Contract Refresh

1. Regenerate backend OpenAPI artifacts from the code-first registry.
2. Run `pnpm run sync` in `typescript-sdk/`.
3. Review the synced OpenAPI snapshot and generated SDK types.
4. Run SDK tests before release.
