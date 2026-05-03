/** @type {import('next').NextConfig} */
const nextConfig = {
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
    config.module.rules.push({
      test: /\.md$/i,
      type: "asset/source",
    })

    return config
  },
}

export default nextConfig
