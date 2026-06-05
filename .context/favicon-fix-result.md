# Favicon Fix Result

## Summary

- Backend agent wizard favicon upload now tries the declared favicon first, then a deduped `${origin}/favicon.ico` fallback derived from the website URL.
- The favicon download path still validates every candidate and redirect hop with the public URL policy, keeps the raster-only allow-list unchanged, and never stores SVG.
- Playwright crawler navigation now waits for `domcontentloaded`, then performs a swallowed `networkidle` settle with an 8s timeout.

## Verification

- `cd backend && pnpm run build` - passed.
- `cd backend && pnpm exec vitest run tests/unit/agent-wizard-service.test.ts` - passed, 24 tests.
- `cd packages/crawler && pnpm run build && pnpm test` - passed, 6 test files / 52 tests.
