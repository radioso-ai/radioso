import type { DashboardSection } from '@/lib/dashboard-routes'

/**
 * Client-side document titles for the dashboard catch-all route. The Next.js
 * `metadata.title.template` only applies to server-rendered `metadata`, so the
 * `'use client'` dashboard has to build the full title (including the brand
 * suffix) itself and keep it in sync with the active section.
 */

const SITE_NAME = 'Radioso'

const SECTION_TITLES: Record<DashboardSection, string> = {
  agents: 'Agents',
  knowledge: 'Knowledge Base',
  activity: 'Activity',
  quality: 'Quality',
  eval: 'Eval',
  settings: 'Settings',
  account: 'Account',
  copilot: 'Ray',
}

export const buildDashboardDocumentTitle = (section: DashboardSection): string =>
  `${SECTION_TITLES[section]} · ${SITE_NAME}`
