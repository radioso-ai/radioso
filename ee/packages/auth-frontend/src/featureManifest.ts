export const enterpriseAuthFrontendFeatureManifest = {
  id: "enterprise-auth-frontend",
  name: "Enterprise Auth Frontend",
  edition: "enterprise",
  frontendRoutes: [
    {
      relativePath: "app/reset-password/page.tsx",
      packageName: "@radioso/enterprise-auth-frontend",
      exportPath: "reset-password-page",
      exports: ["default"],
    },
    {
      relativePath: "app/verify-email/page.tsx",
      packageName: "@radioso/enterprise-auth-frontend",
      exportPath: "verify-email-page",
      exports: ["default"],
    },
  ],
  docs: ["ee/readme.md"],
} as const;
