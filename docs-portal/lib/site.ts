// Defaults are the production values on purpose. The portal is a static export,
// so these are baked in at build time; a missing env var in CI must degrade to
// the real docs origin rather than poisoning canonical/OG tags with localhost.
export const site = {
  name: 'Radioso Docs',
  tagline: 'All your conversational agents. One platform.',
  description:
    'Conversational agents grounded in your own documents and steered by your rules — on the app, API, SDK, MCP, and website.',
  appUrl: process.env.RADIOSO_APP_URL ?? 'https://app.radioso.ai',
  docsUrl: process.env.DOCS_SITE_URL ?? 'https://docs.radioso.ai',
  embedToken: process.env.RADIOSO_EMBED_TOKEN ?? '6teSuTrkFZGiKOyPMWoJCA',
}

/**
 * Shared social card. Rendered at build time by `app/og-image.png/route.tsx`;
 * every route restates it because Next replaces, rather than merges, a parent
 * segment's `openGraph` when a child declares its own.
 */
export const ogImage = {
  url: '/og-image.png',
  width: 1200,
  height: 630,
  alt: 'Radioso Docs',
  type: 'image/png',
} as const

/** Absolute URL for a site-relative path, e.g. `/api/settings`. */
export function absoluteUrl(path: string): string {
  return new URL(path, site.docsUrl).toString()
}
