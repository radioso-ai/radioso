import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STANDALONE_MCP_URL = process.env.NODE_ENV === "production" ? "" : "http://localhost:8787/mcp";

const buildCspDirectives = ({ frameAncestors }) => [
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
  frameAncestors,
  "worker-src 'self' blob:",
].filter(Boolean).join("; ");

const cspDirectives = buildCspDirectives({ frameAncestors: "frame-ancestors 'self'" });
const embedCspDirectives = buildCspDirectives({ frameAncestors: "" });

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

const embedSecurityHeaders = securityHeaders.map((header) => (
  header.key === "Content-Security-Policy"
    ? { ...header, value: embedCspDirectives }
    : header
));

const resolvePublicMcpUrl = () => {
  if (process.env.NEXT_PUBLIC_MCP_URL) {
    return process.env.NEXT_PUBLIC_MCP_URL;
  }
  return DEFAULT_STANDALONE_MCP_URL;
};

const edition = process.env.NEXT_PUBLIC_RADIOSO_EDITION ?? process.env.RADIOSO_EDITION ?? "oss";
const agentCreationContributionsModule = path.join(frontendRoot, "lib/agent-creation-contributions-oss.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: frontendRoot,
  transpilePackages: ['@radioso/ui'],
  env: {
    NEXT_PUBLIC_RADIOSO_EDITION: edition,
    NEXT_PUBLIC_DOCS_URL:
      process.env.NEXT_PUBLIC_DOCS_URL ??
      process.env.DOCS_SITE_URL ??
      "https://docs.radioso.ai",
    NEXT_PUBLIC_MCP_URL: resolvePublicMcpUrl(),
  },
  experimental: {
    externalDir: true,
  },
  allowedDevOrigins: ["127.0.0.1"],
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "platform.radioso.dev" }],
        destination: "https://app.radioso.ai/:path*",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        source: "/embed/:path*",
        headers: embedSecurityHeaders,
      },
      {
        source: "/embed-frame",
        headers: embedSecurityHeaders,
      },
      {
        source: "/oauth/operator-mcp/consent",
        headers: [
          { key: "Content-Security-Policy", value: buildCspDirectives({ frameAncestors: "frame-ancestors 'none'" }) },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': frontendRoot,
      '@/components': path.join(frontendRoot, 'components'),
      '@/lib': path.join(frontendRoot, 'lib'),
      '@radioso/agent-creation-contributions': agentCreationContributionsModule,
      // Enterprise frontend page packages are resolved by edition-gated alias,
      // not as frontend dependencies, to keep the OSS build free of EE packages.
      ...(edition === 'enterprise'
        ? {
            '@radioso/enterprise-operator-console': path.join(
              frontendRoot,
              '..',
              'ee',
              'packages',
              'operator-console',
            ),
          }
        : {}),
    }
    config.module.rules.push({
      test: /\.md$/i,
      type: "asset/source",
    })

    return config
  },
}

export default nextConfig
