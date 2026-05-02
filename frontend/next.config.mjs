import path from "node:path"

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
    if (process.env.RADIOSO_ENTERPRISE_FRONTEND !== "true") {
      config.resolve.alias["@radioso/enterprise-embed-widget"] = path.resolve(
        process.cwd(),
        "lib/enterprise-embed-widget-stub",
      )
    }

    config.module.rules.push({
      test: /\.md$/i,
      type: "asset/source",
    })

    return config
  },
}

export default nextConfig
