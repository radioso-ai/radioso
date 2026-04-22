import nextra from 'nextra'
import remarkGfm from 'remark-gfm'

const withNextra = nextra({
  contentDirBasePath: '/',
  defaultShowCopyCode: true,
  mdxOptions: {
    remarkPlugins: [remarkGfm],
  },
})

/** @type {import('next').NextConfig} */
const nextConfig = {
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
