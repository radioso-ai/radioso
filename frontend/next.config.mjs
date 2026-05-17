import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STANDALONE_MCP_URL = process.env.NODE_ENV === "production" ? "" : "http://localhost:8787/mcp";
const backendProxyMcpUrl = (mountPath) => `/backend${mountPath.startsWith("/") ? mountPath : `/${mountPath}`}`;

const cspDirectives = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' http: https: ws: wss:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "worker-src 'self' blob:",
].join("; ");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: cspDirectives,
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

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

const resolveGitValue = (args) => {
  try {
    return execFileSync("git", args, {
      cwd: frontendRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

const resolveDevBuildContext = () => {
  if (process.env.NODE_ENV !== "development") {
    return {
      branch: "",
      buildId: "",
      commit: "",
      label: "",
      worktree: "",
    };
  }

  const buildId = process.env.NEXT_PUBLIC_RADIOSO_DEV_BUILD_ID ?? Date.now().toString(36);
  const branch = process.env.NEXT_PUBLIC_RADIOSO_DEV_BRANCH ?? resolveGitValue(["branch", "--show-current"]);
  const worktree = process.env.NEXT_PUBLIC_RADIOSO_DEV_WORKTREE ?? path.basename(resolveGitValue(["rev-parse", "--show-toplevel"]));
  const commit = process.env.NEXT_PUBLIC_RADIOSO_DEV_COMMIT ?? resolveGitValue(["rev-parse", "--short", "HEAD"]);

  const label = [
    "dev",
    worktree,
    branch,
    commit,
    buildId,
  ].filter(Boolean).join(" ");

  return {
    branch,
    buildId,
    commit,
    label,
    worktree,
  };
};

const devBuildContext = resolveDevBuildContext();

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: frontendRoot,
  transpilePackages: ['@radioso/ui'],
  env: {
    NEXT_PUBLIC_RADIOSO_EDITION:
      process.env.NEXT_PUBLIC_RADIOSO_EDITION ??
      process.env.RADIOSO_EDITION ??
      "oss",
    NEXT_PUBLIC_DOCS_URL:
      process.env.NEXT_PUBLIC_DOCS_URL ??
      process.env.DOCS_SITE_URL ??
      "http://localhost:3001",
    NEXT_PUBLIC_RADIOSO_DEV_BRANCH:
      devBuildContext.branch,
    NEXT_PUBLIC_RADIOSO_DEV_BUILD_ID:
      devBuildContext.buildId,
    NEXT_PUBLIC_RADIOSO_DEV_BUILD_LABEL:
      devBuildContext.label,
    NEXT_PUBLIC_RADIOSO_DEV_COMMIT:
      devBuildContext.commit,
    NEXT_PUBLIC_RADIOSO_DEV_WORKTREE:
      devBuildContext.worktree,
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
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
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
