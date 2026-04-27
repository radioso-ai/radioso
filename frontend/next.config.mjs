/** @type {import('next').NextConfig} */
const nextConfig = {
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
