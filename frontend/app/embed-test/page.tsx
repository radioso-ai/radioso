'use client'

import { useEffect, useMemo, useState } from 'react'
import { Code2, ExternalLink, RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

type EmbedTestConfig = {
  appOrigin: string
  token: string
  scriptVersion: string
  labelOverride: boolean
  label: string
  icon: string
  position: string
  displayMode: string
  initialState: string
  copy: string
  theme: string
  pageContext: string
  launcherAttention: string
  launcherTeaserDelayMs: string
  proactiveGreetingTeaser: string
  proactiveGreeting: string
}

const STORAGE_KEY = 'radioso.embedTest.config'

const DEFAULT_CONFIG: EmbedTestConfig = {
  appOrigin: '',
  token: '',
  scriptVersion: '',
  labelOverride: false,
  label: '',
  icon: '',
  position: '',
  displayMode: '',
  initialState: '',
  copy: '',
  theme: '',
  pageContext: 'metadata',
  launcherAttention: '',
  launcherTeaserDelayMs: '',
  proactiveGreetingTeaser: '',
  proactiveGreeting: '',
}

const firstSearchValue = (params: URLSearchParams, key: keyof EmbedTestConfig) =>
  params.has(key) ? params.get(key) ?? '' : null

const normalizeOrigin = (value: string) => {
  try {
    return new URL(value).origin
  } catch {
    return value
  }
}

const readStoredConfig = (): Partial<EmbedTestConfig> => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const resolveInitialConfig = () => {
  const params = new URLSearchParams(window.location.search)
  const stored = readStoredConfig()
  const fallbackOrigin = window.location.origin

  return {
    ...DEFAULT_CONFIG,
    ...stored,
    appOrigin: firstSearchValue(params, 'appOrigin') ?? stored.appOrigin ?? fallbackOrigin,
    token: firstSearchValue(params, 'token') ?? stored.token ?? '',
    scriptVersion: firstSearchValue(params, 'scriptVersion') ?? stored.scriptVersion ?? '',
    labelOverride: params.has('label') ? true : Boolean(stored.labelOverride),
    label: firstSearchValue(params, 'label') ?? stored.label ?? DEFAULT_CONFIG.label,
    icon: firstSearchValue(params, 'icon') ?? stored.icon ?? DEFAULT_CONFIG.icon,
    position: firstSearchValue(params, 'position') ?? stored.position ?? DEFAULT_CONFIG.position,
    displayMode: firstSearchValue(params, 'displayMode') ?? stored.displayMode ?? '',
    initialState: firstSearchValue(params, 'initialState') ?? stored.initialState ?? '',
    copy: firstSearchValue(params, 'copy') ?? stored.copy ?? '',
    theme: firstSearchValue(params, 'theme') ?? stored.theme ?? '',
    pageContext: firstSearchValue(params, 'pageContext') ?? stored.pageContext ?? DEFAULT_CONFIG.pageContext,
    launcherAttention: firstSearchValue(params, 'launcherAttention') ?? stored.launcherAttention ?? '',
    launcherTeaserDelayMs: firstSearchValue(params, 'launcherTeaserDelayMs') ?? stored.launcherTeaserDelayMs ?? '',
    proactiveGreetingTeaser: firstSearchValue(params, 'proactiveGreetingTeaser') ?? stored.proactiveGreetingTeaser ?? '',
    proactiveGreeting: firstSearchValue(params, 'proactiveGreeting') ?? stored.proactiveGreeting ?? '',
  }
}

const buildExpertOverridesJson = (config: EmbedTestConfig): string => {
  const overrides: Record<string, string> = {}
  if (config.launcherAttention.trim()) overrides.launcherAttention = config.launcherAttention.trim()
  if (config.launcherTeaserDelayMs.trim()) overrides.launcherTeaserDelayMs = config.launcherTeaserDelayMs.trim()
  if (config.proactiveGreetingTeaser.trim()) overrides.proactiveGreetingTeaser = config.proactiveGreetingTeaser.trim()
  return Object.keys(overrides).length > 0 ? JSON.stringify(overrides) : ''
}

const buildScriptUrl = (config: EmbedTestConfig, cacheBust?: string) => {
  const scriptUrl = new URL('/radioso-embed.js', normalizeOrigin(config.appOrigin || window.location.origin))
  if (config.scriptVersion.trim()) {
    scriptUrl.searchParams.set('v', config.scriptVersion.trim())
  } else if (cacheBust) {
    scriptUrl.searchParams.set('v', cacheBust)
  }
  return scriptUrl.toString()
}

const buildSnippet = (config: EmbedTestConfig) => {
  const expertOverridesJson = buildExpertOverridesJson(config)
  return [
    '<script',
    '  async',
    `  src="${buildScriptUrl(config)}"`,
    `  data-radioso-token="${config.token}"`,
    config.labelOverride ? `  data-radioso-launcher-label="${config.label}"` : null,
    config.icon ? `  data-radioso-launcher-icon="${config.icon}"` : null,
    config.position ? `  data-radioso-launcher-position="${config.position}"` : null,
    config.displayMode ? `  data-radioso-display-mode="${config.displayMode}"` : null,
    config.initialState ? `  data-radioso-initial-state="${config.initialState}"` : null,
    config.copy ? `  data-radioso-copy='${config.copy}'` : null,
    config.theme ? `  data-radioso-theme='${config.theme}'` : null,
    config.pageContext === 'content' ? '  data-radioso-page-context="content"' : null,
    expertOverridesJson ? `  data-radioso-expert-overrides='${expertOverridesJson}'` : null,
    config.proactiveGreeting ? `  data-radioso-proactive-greeting="${config.proactiveGreeting}"` : null,
    `  data-radioso-allowed-origins="${window.location.origin}"`,
    '></script>',
  ].filter(Boolean).join('\n')
}

export default function EmbedTestPage() {
  const [isClientReady, setIsClientReady] = useState(false)
  const [config, setConfig] = useState<EmbedTestConfig>(DEFAULT_CONFIG)
  const [loadedScriptKey, setLoadedScriptKey] = useState<string | null>(null)
  const [failedScriptKey, setFailedScriptKey] = useState<string | null>(null)
  const scriptKey = useMemo(() => JSON.stringify(config), [config])
  const status = !isClientReady || !config.token.trim()
    ? 'Paste a token to mount'
    : failedScriptKey === scriptKey
      ? 'Failed to load launcher script'
      : loadedScriptKey === scriptKey
        ? 'Launcher mounted'
        : 'Loading launcher'

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Browser URL/localStorage config must load after hydration so SSR and first client render match.
    setConfig(resolveInitialConfig())
    setIsClientReady(true)
  }, [])

  useEffect(() => {
    const existing = document.querySelector('[data-radioso-test-script="true"]')
    existing?.remove()
    document.querySelectorAll('[data-radioso-token]').forEach((node) => {
      // Remove any previously mounted launcher host(s) so the new config takes effect.
      if (node instanceof HTMLElement && node.tagName !== 'SCRIPT') {
        node.remove()
      }
    })
    delete (window as typeof window & { __radiosoEmbedMounted?: boolean }).__radiosoEmbedMounted
    document.getElementById('radioso-embed-style')?.remove()

    if (!isClientReady || !config.token.trim()) {
      return
    }

    const script = document.createElement('script')
    script.async = true
    // Always cache-bust in the test page so launcher edits are picked up on every remount.
    script.src = buildScriptUrl(config, String(Date.now()))
    script.dataset.radiosoTestScript = 'true'
    script.dataset.radiosoToken = config.token.trim()
    script.dataset.radiosoAllowedOrigins = window.location.origin

    if (config.labelOverride) script.dataset.radiosoLauncherLabel = config.label
    if (config.icon) script.dataset.radiosoLauncherIcon = config.icon
    if (config.position) script.dataset.radiosoLauncherPosition = config.position
    if (config.displayMode) script.dataset.radiosoDisplayMode = config.displayMode
    if (config.initialState) script.dataset.radiosoInitialState = config.initialState
    if (config.copy.trim()) script.dataset.radiosoCopy = config.copy.trim()
    if (config.theme.trim()) script.dataset.radiosoTheme = config.theme.trim()
    if (config.pageContext === 'content') script.dataset.radiosoPageContext = 'content'

    const expertOverridesJson = buildExpertOverridesJson(config)
    if (expertOverridesJson) script.dataset.radiosoExpertOverrides = expertOverridesJson
    if (config.proactiveGreeting) script.dataset.radiosoProactiveGreeting = config.proactiveGreeting

    script.addEventListener('load', () => setLoadedScriptKey(scriptKey))
    script.addEventListener('error', () => setFailedScriptKey(scriptKey))
    document.body.appendChild(script)

    return () => {
      script.remove()
    }
  }, [config, isClientReady, scriptKey])

  const clearVisitorState = () => {
    const token = config.token.trim()
    if (!token) {
      return
    }
    try {
      window.sessionStorage.removeItem(`radioso:embed:opened:${token}`)
      window.sessionStorage.removeItem(`radioso:embed:teaserDismissed:${token}`)
    } catch {
      /* ignore */
    }
    window.location.reload()
  }

  const snippet = useMemo(() => {
    if (!isClientReady) {
      return ''
    }
    return config.token ? buildSnippet(config) : ''
  }, [config, isClientReady])

  const updateConfig = <K extends keyof EmbedTestConfig>(key: K, value: EmbedTestConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }))
  }

  const reloadWithConfig = () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
    const params = new URLSearchParams()
    params.set('appOrigin', config.appOrigin)
    params.set('token', config.token)
    params.set('scriptVersion', config.scriptVersion)
    if (config.labelOverride) params.set('label', config.label)
    if (config.icon) params.set('icon', config.icon)
    if (config.position) params.set('position', config.position)
    if (config.displayMode) params.set('displayMode', config.displayMode)
    if (config.initialState) params.set('initialState', config.initialState)
    if (config.copy) params.set('copy', config.copy)
    if (config.theme) params.set('theme', config.theme)
    if (config.pageContext !== DEFAULT_CONFIG.pageContext) params.set('pageContext', config.pageContext)
    if (config.launcherAttention) params.set('launcherAttention', config.launcherAttention)
    if (config.launcherTeaserDelayMs) params.set('launcherTeaserDelayMs', config.launcherTeaserDelayMs)
    if (config.proactiveGreetingTeaser) params.set('proactiveGreetingTeaser', config.proactiveGreetingTeaser)
    if (config.proactiveGreeting) params.set('proactiveGreeting', config.proactiveGreeting)
    window.location.search = params.toString()
  }

  const clearConfig = () => {
    window.localStorage.removeItem(STORAGE_KEY)
    window.location.search = ''
  }

  return (
    <main className="min-h-screen bg-background px-6 py-8 text-foreground">
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <section className="space-y-5">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Radioso embed demo</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal">Website widget test page</h1>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 className="text-lg font-medium">Launcher config</h2>
              <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">{status}</span>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 md:col-span-2">
                <Label htmlFor="app-origin">Radioso app origin</Label>
                <Input id="app-origin" value={config.appOrigin} onChange={(event) => updateConfig('appOrigin', event.target.value)} />
              </label>
              <label className="space-y-2 md:col-span-2">
                <Label htmlFor="token">Embed token</Label>
                <Input id="token" value={config.token} onChange={(event) => updateConfig('token', event.target.value)} autoComplete="off" />
              </label>
              <label className="space-y-2">
                <Label htmlFor="script-version">Script version</Label>
                <Input id="script-version" value={config.scriptVersion} onChange={(event) => updateConfig('scriptVersion', event.target.value)} />
              </label>
              <label className="space-y-2">
                <Label htmlFor="label">{config.displayMode === 'panel' ? 'Accessible name' : 'Launcher label'}</Label>
                <div className="flex items-center gap-2">
                  <input
                    id="label-override"
                    type="checkbox"
                    checked={config.labelOverride}
                    onChange={(event) => updateConfig('labelOverride', event.target.checked)}
                    className="size-4 rounded border-input"
                  />
                  <Label htmlFor="label-override" className="text-xs font-normal text-muted-foreground">
                    Override
                  </Label>
                </div>
                <Input
                  id="label"
                  value={config.label}
                  maxLength={80}
                  disabled={!config.labelOverride}
                  onChange={(event) => updateConfig('label', event.target.value)}
                  placeholder="server config"
                />
                <p className="text-xs text-muted-foreground">
                  Leave override off to test the saved launcher label from the server. Turn it on to test a script-tag label override, including an empty one.
                </p>
              </label>
              <label className="space-y-2">
                <Label htmlFor="icon">Icon</Label>
                <select id="icon" value={config.icon} onChange={(event) => updateConfig('icon', event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="">server config</option>
                  <option value="chat">chat</option>
                  <option value="sparkles">sparkles</option>
                  <option value="message">message</option>
                </select>
                <p className="text-xs text-muted-foreground">Use server config unless you need to test a script-tag override.</p>
              </label>
              <label className="space-y-2">
                <Label htmlFor="display-mode">Display mode</Label>
                <select id="display-mode" value={config.displayMode} onChange={(event) => updateConfig('displayMode', event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="">Bubble</option>
                  <option value="panel">Side panel</option>
                </select>
              </label>
              <label className="space-y-2">
                <Label htmlFor="position">{config.displayMode === 'panel' ? 'Panel side' : 'Position'}</Label>
                <select id="position" value={config.position} onChange={(event) => updateConfig('position', event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="">server config</option>
                  <option value="bottom-right">{config.displayMode === 'panel' ? 'Right edge' : 'Bottom right'}</option>
                  <option value="bottom-left">{config.displayMode === 'panel' ? 'Left edge' : 'Bottom left'}</option>
                </select>
                <p className="text-xs text-muted-foreground">Use server config unless you need to test a script-tag override.</p>
              </label>
              <label className="space-y-2">
                <Label htmlFor="initial-state">Initial state</Label>
                <select id="initial-state" value={config.initialState} onChange={(event) => updateConfig('initialState', event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="">workspace default</option>
                  <option value="collapsed">collapsed</option>
                  <option value="open">open</option>
                </select>
              </label>
              <label className="space-y-2 md:col-span-2">
                <Label htmlFor="copy-json">Copy JSON</Label>
                <Textarea id="copy-json" value={config.copy} onChange={(event) => updateConfig('copy', event.target.value)} className="min-h-[88px] font-mono text-xs" placeholder='{"publicChatEmptyTitle":"Ask anything"}' />
              </label>
              <label className="space-y-2 md:col-span-2">
                <Label htmlFor="theme-json">Theme JSON</Label>
                <Textarea id="theme-json" value={config.theme} onChange={(event) => updateConfig('theme', event.target.value)} className="min-h-[88px] font-mono text-xs" placeholder='{"accent":"#1d4ed8","panelBackground":"#ffffff"}' />
              </label>
            </div>

            <div className="mt-6 border-t border-border pt-4">
              <div className="mb-3 space-y-0.5">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Attention &amp; engagement</p>
                <p className="text-xs text-muted-foreground">
                  Test-only overrides — applied via <code>data-radioso-expert-overrides</code> on the script tag, so changes take effect immediately without saving to the agent.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2">
                  <Label htmlFor="launcher-attention">Attention animation</Label>
                  <select id="launcher-attention" value={config.launcherAttention} onChange={(event) => updateConfig('launcherAttention', event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <option value="">none</option>
                    <option value="breathe">breathe</option>
                    <option value="pulse">pulse</option>
                    <option value="nudge">nudge</option>
                    <option value="bounce-in">bounce-in</option>
                  </select>
                </label>
                <label className="space-y-2">
                  <Label htmlFor="proactive-greeting">Proactive greeting</Label>
                  <select id="proactive-greeting" value={config.proactiveGreeting} onChange={(event) => updateConfig('proactiveGreeting', event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <option value="">agent default</option>
                    <option value="true">force on</option>
                    <option value="false">force off</option>
                  </select>
                </label>
                <label className="space-y-2">
                  <Label htmlFor="teaser-delay">Teaser delay (ms)</Label>
                  <Input id="teaser-delay" value={config.launcherTeaserDelayMs} onChange={(event) => updateConfig('launcherTeaserDelayMs', event.target.value)} placeholder="4000" />
                </label>
                <label className="space-y-2">
                  <Label htmlFor="teaser-text">Teaser text</Label>
                  <Input id="teaser-text" value={config.proactiveGreetingTeaser} onChange={(event) => updateConfig('proactiveGreetingTeaser', event.target.value)} placeholder="Hi! How can I help?" />
                </label>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={clearVisitorState} disabled={!config.token.trim()}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Reset visitor state
              </Button>
              <Button variant="outline" onClick={clearConfig}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Clear
              </Button>
              <Button onClick={reloadWithConfig}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Reload with widget
              </Button>
            </div>
          </div>
        </section>

        <aside className="space-y-5">
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="mb-4 flex items-center gap-2">
              <Code2 className="h-4 w-4" />
              <h2 className="text-lg font-medium">Diagnostics</h2>
            </div>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Current page origin</dt>
                <dd className="break-all font-mono">{isClientReady ? window.location.origin : ''}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Expected allowlist entry</dt>
                <dd className="break-all font-mono">{isClientReady ? window.location.origin : ''}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Launcher script</dt>
                <dd className="break-all font-mono">{config.appOrigin ? buildScriptUrl(config) : ''}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-lg font-medium">Snippet preview</h2>
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-muted-foreground">{snippet || 'No token configured.'}</pre>
          </div>
        </aside>
      </div>
    </main>
  )
}
