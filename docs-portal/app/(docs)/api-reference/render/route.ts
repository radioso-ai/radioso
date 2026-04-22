import { ApiReference } from '@scalar/nextjs-api-reference'

export const GET = ApiReference({
  url: '/openapi.json',
  theme: 'deepSpace',
  layout: 'modern',
  defaultHttpClient: {
    targetKey: 'node',
    clientKey: 'fetch',
  },
  pageTitle: 'Radioso API Reference',
})
