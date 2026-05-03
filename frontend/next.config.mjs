/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_RADIOSO_EE_FRONTEND:
      process.env.NEXT_PUBLIC_RADIOSO_EE_FRONTEND ??
      process.env.RADIOSO_EE_FRONTEND ??
      process.env.RADIOSO_ENTERPRISE_FRONTEND ??
      "false",
    NEXT_PUBLIC_RADIOSO_ENTERPRISE_FRONTEND:
      process.env.NEXT_PUBLIC_RADIOSO_ENTERPRISE_FRONTEND ??
      process.env.RADIOSO_ENTERPRISE_FRONTEND ??
      "false",
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
