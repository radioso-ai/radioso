import nextra from 'nextra'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import remarkGfm from 'remark-gfm'

const docsPortalRoot = path.dirname(fileURLToPath(import.meta.url))

const withNextra = nextra({
  contentDirBasePath: '/',
  defaultShowCopyCode: true,
  mdxOptions: {
    remarkPlugins: [remarkGfm],
  },
})

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: docsPortalRoot,
  transpilePackages: ['@radioso/ui'],
  turbopack: {
    resolveAlias: {
      'next-mdx-import-source-file': './mdx-components.tsx',
    },
  },
  images: {
    unoptimized: true,
  },
}

export default withNextra(nextConfig)
