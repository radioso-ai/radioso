(function () {
  const STORAGE_KEY = 'radioso.embedTest.config'
  const params = new URLSearchParams(window.location.search)

  const form = document.getElementById('config-form')
  const status = document.getElementById('mount-status')
  const snippet = document.getElementById('snippet-preview')
  const currentOrigin = document.getElementById('current-origin')
  const allowlistOrigin = document.getElementById('allowlist-origin')
  const approvedLink = document.getElementById('approved-link')
  const blockedLink = document.getElementById('blocked-link')
  const clearButton = document.getElementById('clear-config')

  const appOriginInput = document.getElementById('app-origin')
  const tokenInput = document.getElementById('token')
  const scriptVersionInput = document.getElementById('script-version')
  const labelInput = document.getElementById('label')
  const iconInput = document.getElementById('icon')
  const positionInput = document.getElementById('position')
  const displayModeInput = document.getElementById('display-mode')
  const initialStateInput = document.getElementById('initial-state')
  const avatarInput = document.getElementById('avatar-url')
  const copyInput = document.getElementById('copy-json')
  const themeInput = document.getElementById('theme-json')

  const readStoredConfig = () => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  const normalizeOrigin = (value) => {
    try {
      return new URL(value).origin
    } catch {
      return value
    }
  }

  const config = {
    appOrigin: params.get('appOrigin') || readStoredConfig().appOrigin || 'http://localhost:3000',
    token: params.get('token') || readStoredConfig().token || '',
    scriptVersion: params.get('scriptVersion') || readStoredConfig().scriptVersion || '',
    label: params.get('label') || readStoredConfig().label || 'Chat with us',
    icon: params.get('icon') || readStoredConfig().icon || 'sparkles',
    position: params.get('position') || readStoredConfig().position || 'bottom-right',
    displayMode: params.get('displayMode') || readStoredConfig().displayMode || '',
    initialState: params.get('initialState') || readStoredConfig().initialState || '',
    avatarUrl: params.get('avatarUrl') || readStoredConfig().avatarUrl || '',
    copyJson:
      params.get('copy') ||
      readStoredConfig().copyJson ||
      '',
    themeJson:
      params.get('theme') ||
      readStoredConfig().themeJson ||
      '',
  }

  appOriginInput.value = config.appOrigin
  tokenInput.value = config.token
  scriptVersionInput.value = config.scriptVersion
  labelInput.value = config.label
  iconInput.value = config.icon
  positionInput.value = config.position
  displayModeInput.value = config.displayMode
  initialStateInput.value = config.initialState
  avatarInput.value = config.avatarUrl
  copyInput.value = config.copyJson
  themeInput.value = config.themeJson

  currentOrigin.textContent = window.location.origin
  allowlistOrigin.textContent = window.location.origin
  approvedLink.href = `http://127.0.0.1:${window.location.port || '4321'}${window.location.pathname}`
  blockedLink.href = `http://localhost:${window.location.port || '4321'}${window.location.pathname}`

  const buildSnippet = (settings) => {
    const scriptOrigin = normalizeOrigin(settings.appOrigin)
    const scriptUrl = new URL('/radioso-embed.js', scriptOrigin)
    if (settings.scriptVersion) {
      scriptUrl.searchParams.set('v', settings.scriptVersion)
    }

    return [
      '<script',
      '  async',
      `  src="${scriptUrl.toString()}"`,
      `  data-radioso-token="${settings.token}"`,
      `  data-radioso-launcher-label="${settings.label}"`,
      `  data-radioso-launcher-icon="${settings.icon}"`,
      `  data-radioso-launcher-position="${settings.position}"`,
      settings.displayMode ? `  data-radioso-display-mode="${settings.displayMode}"` : null,
      settings.initialState ? `  data-radioso-initial-state="${settings.initialState}"` : null,
      settings.avatarUrl ? `  data-radioso-avatar-url="${settings.avatarUrl}"` : null,
      settings.copyJson ? `  data-radioso-copy='${settings.copyJson}'` : null,
      settings.themeJson ? `  data-radioso-theme='${settings.themeJson}'` : null,
      `  data-radioso-allowed-origins="${window.location.origin}"`,
      '></script>',
    ].filter(Boolean).join('\n')
  }

  const updatePreview = (settings) => {
    snippet.textContent = buildSnippet(settings)
  }

  const mountWidget = (settings) => {
    if (!settings.token) {
      status.textContent = 'Paste a token to mount'
      return
    }

    if (window.__radiosoEmbedMounted) {
      status.textContent = 'Widget already mounted'
      return
    }

    const script = document.createElement('script')
    script.async = true
    const scriptUrl = new URL('/radioso-embed.js', normalizeOrigin(settings.appOrigin))
    if (settings.scriptVersion) {
      scriptUrl.searchParams.set('v', settings.scriptVersion)
    }
    script.src = scriptUrl.toString()
    script.dataset.radiosoToken = settings.token
    script.dataset.radiosoLauncherLabel = settings.label
    script.dataset.radiosoLauncherIcon = settings.icon
    script.dataset.radiosoLauncherPosition = settings.position
    if (settings.displayMode) {
      script.dataset.radiosoDisplayMode = settings.displayMode
    }
    if (settings.initialState) {
      script.dataset.radiosoInitialState = settings.initialState
    }
    if (settings.avatarUrl) {
      script.dataset.radiosoAvatarUrl = settings.avatarUrl
    }
    if (settings.copyJson) {
      script.dataset.radiosoCopy = settings.copyJson
    }
    if (settings.themeJson) {
      script.dataset.radiosoTheme = settings.themeJson
    }
    script.dataset.radiosoAllowedOrigins = window.location.origin
    script.addEventListener('load', () => {
      status.textContent = 'Launcher mounted'
    })
    script.addEventListener('error', () => {
      status.textContent = 'Failed to load launcher script'
    })
    document.body.appendChild(script)
  }

  updatePreview(config)
  if (config.token) {
    mountWidget(config)
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()

    const nextConfig = {
      appOrigin: appOriginInput.value.trim(),
      token: tokenInput.value.trim(),
      scriptVersion: scriptVersionInput.value.trim(),
      label: labelInput.value.trim() || 'Chat with us',
      icon: iconInput.value,
      position: positionInput.value,
      displayMode: displayModeInput.value,
      initialState: initialStateInput.value,
      avatarUrl: avatarInput.value.trim(),
      copyJson: copyInput.value.trim(),
      themeJson: themeInput.value.trim(),
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextConfig))

    const nextParams = new URLSearchParams()
    nextParams.set('appOrigin', nextConfig.appOrigin)
    nextParams.set('token', nextConfig.token)
    nextParams.set('scriptVersion', nextConfig.scriptVersion)
    nextParams.set('label', nextConfig.label)
    nextParams.set('icon', nextConfig.icon)
    nextParams.set('position', nextConfig.position)
    if (nextConfig.displayMode) {
      nextParams.set('displayMode', nextConfig.displayMode)
    }
    if (nextConfig.initialState) {
      nextParams.set('initialState', nextConfig.initialState)
    }
    nextParams.set('avatarUrl', nextConfig.avatarUrl)
    if (nextConfig.copyJson) {
      nextParams.set('copy', nextConfig.copyJson)
    }
    if (nextConfig.themeJson) {
      nextParams.set('theme', nextConfig.themeJson)
    }
    window.location.search = nextParams.toString()
  })

  clearButton.addEventListener('click', () => {
    window.localStorage.removeItem(STORAGE_KEY)
    window.location.search = ''
  })
})()
