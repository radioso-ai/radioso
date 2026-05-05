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
  label: string
  icon: string
  position: string
  displayMode: string
  initialState: string
  avatarUrl: string
  copy: string
  theme: string
  pageContext: string
}

const STORAGE_KEY = 'radioso.embedTest.config'

const DEFAULT_CONFIG: EmbedTestConfig = {
  appOrigin: '',
  token: '',
  scriptVersion: '',
  label: 'Chat with us',
  icon: 'chat',
  position: 'bottom-right',
  displayMode: '',
  initialState: '',
  avatarUrl: '',
  copy: '',
  theme: '',
  pageContext: 'metadata',
}

const firstSearchValue = (params: URLSearchParams, key: keyof EmbedTestConfig) => params.get(key) ?? ''

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
    appOrigin: firstSearchValue(params, 'appOrigin') || stored.appOrigin || fallbackOrigin,
    token: firstSearchValue(params, 'token') || stored.token || '',
    scriptVersion: firstSearchValue(params, 'scriptVersion') || stored.scriptVersion || '',
    label: firstSearchValue(params, 'label') || stored.label || DEFAULT_CONFIG.label,
    icon: firstSearchValue(params, 'icon') || stored.icon || DEFAULT_CONFIG.icon,
    position: firstSearchValue(params, 'position') || stored.position || DEFAULT_CONFIG.position,
    displayMode: firstSearchValue(params, 'displayMode') || stored.displayMode || '',
    initialState: firstSearchValue(params, 'initialState') || stored.initialState || '',
    avatarUrl: firstSearchValue(params, 'avatarUrl') || stored.avatarUrl || '',
    copy: firstSearchValue(params, 'copy') || stored.copy || '',
    theme: firstSearchValue(params, 'theme') || stored.theme || '',
    pageContext: firstSearchValue(params, 'pageContext') || stored.pageContext || DEFAULT_CONFIG.pageContext,
  }
}

const buildScriptUrl = (config: EmbedTestConfig) => {
  const scriptUrl = new URL('/radioso-embed.js', normalizeOrigin(config.appOrigin || window.location.origin))
  if (config.scriptVersion.trim()) {
    scriptUrl.searchParams.set('v', config.scriptVersion.trim())
  }
  return scriptUrl.toString()
}

const buildSnippet = (config: EmbedTestConfig) =>
  [
    '<script',
    '  async',
    `  src="${buildScriptUrl(config)}"`,
    `  data-radioso-token="${config.token}"`,
    `  data-radioso-launcher-label="${config.label}"`,
    `  data-radioso-launcher-icon="${config.icon}"`,
    `  data-radioso-launcher-position="${config.position}"`,
    config.displayMode ? `  data-radioso-display-mode="${config.displayMode}"` : null,
    config.initialState ? `  data-radioso-initial-state="${config.initialState}"` : null,
    config.avatarUrl ? `  data-radioso-avatar-url="${config.avatarUrl}"` : null,
    config.copy ? `  data-radioso-copy='${config.copy}'` : null,
    config.theme ? `  data-radioso-theme='${config.theme}'` : null,
    config.pageContext === 'content' ? '  data-radioso-page-context="content"' : null,
    `  data-radioso-allowed-origins="${window.location.origin}"`,
    '></script>',
  ].filter(Boolean).join('\n')

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
    delete (window as typeof window & { __radiosoEmbedMounted?: boolean }).__radiosoEmbedMounted

    if (!isClientReady || !config.token.trim()) {
      return
    }

    const script = document.createElement('script')
    script.async = true
    script.src = buildScriptUrl(config)
    script.dataset.radiosoTestScript = 'true'
    script.dataset.radiosoToken = config.token.trim()
    script.dataset.radiosoLauncherLabel = config.label.trim() || DEFAULT_CONFIG.label
    script.dataset.radiosoLauncherIcon = config.icon || DEFAULT_CONFIG.icon
    script.dataset.radiosoLauncherPosition = config.position || DEFAULT_CONFIG.position
    script.dataset.radiosoAllowedOrigins = window.location.origin

    if (config.displayMode) script.dataset.radiosoDisplayMode = config.displayMode
    if (config.initialState) script.dataset.radiosoInitialState = config.initialState
    if (config.avatarUrl.trim()) script.dataset.radiosoAvatarUrl = config.avatarUrl.trim()
    if (config.copy.trim()) script.dataset.radiosoCopy = config.copy.trim()
    if (config.theme.trim()) script.dataset.radiosoTheme = config.theme.trim()
    if (config.pageContext === 'content') script.dataset.radiosoPageContext = 'content'

    script.addEventListener('load', () => setLoadedScriptKey(scriptKey))
    script.addEventListener('error', () => setFailedScriptKey(scriptKey))
    document.body.appendChild(script)

    return () => {
      script.remove()
    }
  }, [config, isClientReady, scriptKey])

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
    params.set('label', config.label)
    params.set('icon', config.icon)
    params.set('position', config.position)
    if (config.displayMode) params.set('displayMode', config.displayMode)
    if (config.initialState) params.set('initialState', config.initialState)
    if (config.avatarUrl) params.set('avatarUrl', config.avatarUrl)
    if (config.copy) params.set('copy', config.copy)
    if (config.theme) params.set('theme', config.theme)
    if (config.pageContext !== DEFAULT_CONFIG.pageContext) params.set('pageContext', config.pageContext)
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
                <Label htmlFor="label">Launcher label</Label>
                <Input id="label" value={config.label} maxLength={80} onChange={(event) => updateConfig('label', event.target.value)} />
              </label>
              <label className="space-y-2">
                <Label htmlFor="icon">Icon</Label>
                <select id="icon" value={config.icon} onChange={(event) => updateConfig('icon', event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="chat">chat</option>
                  <option value="sparkles">sparkles</option>
                  <option value="message">message</option>
                </select>
              </label>
              <label className="space-y-2">
                <Label htmlFor="position">Position</Label>
                <select id="position" value={config.position} onChange={(event) => updateConfig('position', event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="bottom-right">bottom-right</option>
                  <option value="bottom-left">bottom-left</option>
                </select>
              </label>
              <label className="space-y-2">
                <Label htmlFor="display-mode">Display mode</Label>
                <select id="display-mode" value={config.displayMode} onChange={(event) => updateConfig('displayMode', event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="">bubble</option>
                  <option value="panel">retractable side panel</option>
                </select>
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
                <Label htmlFor="avatar-url">Avatar URL</Label>
                <Input id="avatar-url" value={config.avatarUrl} onChange={(event) => updateConfig('avatarUrl', event.target.value)} placeholder="https://cdn.example.com/avatar.gif" />
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

            <div className="mt-5 flex flex-wrap justify-end gap-2">
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
