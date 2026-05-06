import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: frontendRoot,
  env: {
    NEXT_PUBLIC_RADIOSO_EDITION:
      process.env.NEXT_PUBLIC_RADIOSO_EDITION ??
      process.env.RADIOSO_EDITION ??
      "oss",
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    externalDir: true,
  },
  allowedDevOrigins: ["127.0.0.1"],
  images: {
    unoptimized: true,
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': frontendRoot,
      '@/components': path.join(frontendRoot, 'components'),
      '@/lib': path.join(frontendRoot, 'lib'),
    }
    config.module.rules.push({
      test: /\.md$/i,
      type: "asset/source",
    })

    return config
  },
}

export default nextConfig
