import { site } from '@/lib/site'

/**
 * Outbound destinations shared by the docs header, drawer and footer. These are
 * marketing/repo URLs rather than deploy-time configuration, so they live with
 * the chrome that renders them instead of in `lib/site.ts`.
 */
export const externalLinks = {
  marketing: 'https://radioso.ai',
  app: site.appUrl,
  github: 'https://github.com/radioso-ai/radioso',
  blog: 'https://radioso.ai/blog',
  slack: 'https://radioso.ai/slack',
  platform: 'https://radioso.ai/#platform',
  licensing: 'https://radioso.ai/#licensing',
  faq: 'https://radioso.ai/#faq',
  contact: 'mailto:hello@radioso.ai',
  privacy: 'https://radioso.ai/legal/privacy-policy',
  terms: 'https://radioso.ai/legal/terms-of-service',
} as const
