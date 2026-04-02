/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    externalDir: true,
  },
  turbopack: {
    rules: {
      '*.md': {
        loaders: ['raw-loader'],
        as: '*.js',
      },
    },
  },
  allowedDevOrigins: ["127.0.0.1"],
  images: {
    unoptimized: true,
  },
  async rewrites() {
    const backendUrl = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:8080"
    return [
      {
        source: "/backend/:path*",
        destination: `${backendUrl}/:path*`,
      },
    ]
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
