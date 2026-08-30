// Captures the dashboard screenshots used by the docs portal.
//
// Prerequisites:
//   1. A running local stack (./run-dev.sh) with a seeded demo workspace:
//      org "Aurora Coffee Roasters", workspace "Customer Support", agent
//      "Aurora Support" with four processed documents, one directive, one
//      published routine, one passing eval case, and one cited conversation.
//      Seed it through the normal REST API (document, agents, directives,
//      routines/portable, evals, and assistant/chat endpoints) with a
//      workspace token.
//   2. Playwright installed (the frontend workspace already depends on it):
//      pnpm --dir frontend exec playwright install chromium
//
// Usage (run from the frontend workspace so Playwright resolves):
//   cd frontend
//   RADIOSO_APP_URL=http://localhost:3000 \
//   RADIOSO_DEMO_EMAIL=demo@example.com \
//   RADIOSO_DEMO_PASSWORD=... \
//   RADIOSO_WORKSPACE_KEY=<workspace public route key> \
//   RADIOSO_DEMO_AGENT_ID=<agent uuid> \
//   RADIOSO_DEMO_ROUTINE_ID=<routine uuid> \
//   node ../docs-portal/scripts/capture-screenshots.mjs
//
// Output: docs-portal/public/screenshots/*.png at a 1440x900 viewport.
// Retake shots in the same change that alters the screens they show.

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const requireFromCwd = createRequire(join(process.cwd(), 'package.json'))
const playwright = await import(pathToFileURL(requireFromCwd.resolve('@playwright/test')))
const chromium = playwright.chromium ?? playwright.default.chromium

const env = (name, fallback) => process.env[name] ?? fallback
const APP = env('RADIOSO_APP_URL', 'http://localhost:3000')
const EMAIL = env('RADIOSO_DEMO_EMAIL')
const PASSWORD = env('RADIOSO_DEMO_PASSWORD')
const WS_KEY = env('RADIOSO_WORKSPACE_KEY')
const AGENT_ID = env('RADIOSO_DEMO_AGENT_ID')
const ROUTINE_ID = env('RADIOSO_DEMO_ROUTINE_ID')

for (const [name, value] of Object.entries({ RADIOSO_DEMO_EMAIL: EMAIL, RADIOSO_DEMO_PASSWORD: PASSWORD, RADIOSO_WORKSPACE_KEY: WS_KEY, RADIOSO_DEMO_AGENT_ID: AGENT_ID })) {
  if (!value) {
    console.error(`Missing required env var ${name}`)
    process.exit(1)
  }
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'screenshots')
mkdirSync(outDir, { recursive: true })

const ws = (path) => `${APP}/w/${WS_KEY}${path}`

// `action` runs after navigation and before the screenshot. Keep actions on
// visible-label selectors so routing internals can change without breaking
// the captures.
const askInWorkbench = async (page) => {
  const input = page.getByPlaceholder('Ask a question...')
  await input.fill('How long does shipping to Germany take, and is it free?')
  await input.press('Enter')
  // Wait for the streamed grounded answer (citations chip) to land.
  await page.getByText('Sources', { exact: false }).first().waitFor({ timeout: 90000 })
  await page.waitForTimeout(2000)
}

const openDirectives = async (page) => {
  await page.getByText('Directives', { exact: true }).first().click()
  await page.waitForTimeout(2000)
}

// A published routine is read-only and its Prose tab is disabled; open an
// editable revision first, then switch tabs. Safe to re-run: when a revision
// draft already exists the editor opens straight into it.
const openProseView = async (page) => {
  const editRevision = page.getByRole('button', { name: 'Edit revision' })
  if (await editRevision.isVisible().catch(() => false)) {
    await editRevision.click()
    await page.waitForTimeout(2500)
  }
  const proseTab = page.getByRole('tab', { name: 'Prose' })
  if (await proseTab.isVisible().catch(() => false)) {
    await proseTab.click()
    await page.waitForTimeout(2000)
  }
}

const shots = [
  { name: 'dashboard-agents-workbench.png', url: ws(`/agents/${AGENT_ID}?tab=chat`), settle: 3000, action: askInWorkbench },
  { name: 'dashboard-knowledge-documents.png', url: ws('/documents'), settle: 2000 },
  // The prior merged Identity & appearance and Behavior pages are now Profile;
  // the docs image describes Web chat, which lives under Channels.
  { name: 'dashboard-agent-behavior.png', url: ws(`/agents/${AGENT_ID}?tab=channels&anchor=web-chat`), settle: 2000 },
  { name: 'dashboard-agent-directives.png', url: ws(`/agents/${AGENT_ID}?tab=behavior&anchor=assistant-directives`), settle: 2000, action: openDirectives },
  ...(ROUTINE_ID ? [
    { name: 'dashboard-routine-editor.png', url: ws(`/agents/${AGENT_ID}/routines/${ROUTINE_ID}`), settle: 2500 },
    { name: 'dashboard-routine-prose.png', url: ws(`/agents/${AGENT_ID}/routines/${ROUTINE_ID}`), settle: 2500, action: openProseView },
  ] : []),
  { name: 'dashboard-settings.png', url: ws('/settings'), settle: 2000 },
  { name: 'dashboard-agent-channels.png', url: ws(`/agents/${AGENT_ID}?tab=channels&anchor=web-chat`), settle: 2000 },
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })

console.log('Signing in…')
await page.goto(APP, { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', EMAIL)
await page.fill('input[type="password"]', PASSWORD)
await page.click('button[type="submit"]')
await page.waitForURL('**/w/**', { timeout: 30000 })

for (const shot of shots) {
  console.log(`Capturing ${shot.name}`)
  await page.goto(shot.url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(shot.settle)
  if (shot.action) {
    await shot.action(page)
  }
  await page.screenshot({ path: join(outDir, shot.name) })
}

await browser.close()
console.log(`Done. Screenshots in ${outDir}`)
