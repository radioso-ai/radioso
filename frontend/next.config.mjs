import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STANDALONE_MCP_URL = process.env.NODE_ENV === "production" ? "" : "http://localhost:8787/mcp";
const backendProxyMcpUrl = (mountPath) => `/backend${mountPath.startsWith("/") ? mountPath : `/${mountPath}`}`;

const resolvePublicMcpUrl = () => {
  if (process.env.NEXT_PUBLIC_MCP_URL) {
    return process.env.NEXT_PUBLIC_MCP_URL;
  }
  if (process.env.RADIOSO_MCP_URL) {
    return process.env.RADIOSO_MCP_URL;
  }
  if (process.env.RADIOSO_MCP_ENABLED === "false") {
    return "";
  }
  if (process.env.RADIOSO_MCP_ENABLED === "true" && process.env.RADIOSO_MCP_STANDALONE !== "true") {
    return backendProxyMcpUrl(process.env.RADIOSO_MCP_MOUNT_PATH ?? "/mcp");
  }

  return DEFAULT_STANDALONE_MCP_URL;
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: frontendRoot,
  env: {
    NEXT_PUBLIC_RADIOSO_EDITION:
      process.env.NEXT_PUBLIC_RADIOSO_EDITION ??
      process.env.RADIOSO_EDITION ??
      "oss",
    NEXT_PUBLIC_DOCS_URL:
      process.env.NEXT_PUBLIC_DOCS_URL ??
      process.env.DOCS_SITE_URL ??
      "http://localhost:3001",
    NEXT_PUBLIC_MCP_URL: resolvePublicMcpUrl(),
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
