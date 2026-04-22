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
  const avatarInput = document.getElementById('avatar-url')

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
    scriptVersion: params.get('scriptVersion') || readStoredConfig().scriptVersion || 'embed-session-fix-3',
    label: params.get('label') || readStoredConfig().label || 'Chat with us',
    icon: params.get('icon') || readStoredConfig().icon || 'sparkles',
    position: params.get('position') || readStoredConfig().position || 'bottom-right',
    avatarUrl: params.get('avatarUrl') || readStoredConfig().avatarUrl || '',
  }

  appOriginInput.value = config.appOrigin
  tokenInput.value = config.token
  scriptVersionInput.value = config.scriptVersion
  labelInput.value = config.label
  iconInput.value = config.icon
  positionInput.value = config.position
  avatarInput.value = config.avatarUrl

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
      settings.avatarUrl ? `  data-radioso-avatar-url="${settings.avatarUrl}"` : null,
      '  data-radioso-copy=\'{"publicChatSubtitle":"Embedded support chat","startPrompt":"Ask about pricing, docs, or setup..."}\'',
      '  data-radioso-theme=\'{"accent":"#1d4ed8","panelBackground":"#ffffff","userBubbleBackground":"#1d4ed8","launcherBackground":"linear-gradient(135deg, #1d4ed8 0%, #1e3a8a 100%)"}\'',
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
    if (settings.avatarUrl) {
      script.dataset.radiosoAvatarUrl = settings.avatarUrl
    }
    script.dataset.radiosoCopy = JSON.stringify({
      publicChatSubtitle: 'Embedded support chat',
      startPrompt: 'Ask about pricing, docs, or setup...',
    })
    script.dataset.radiosoTheme = JSON.stringify({
      accent: '#1d4ed8',
      panelBackground: '#ffffff',
      userBubbleBackground: '#1d4ed8',
      launcherBackground: 'linear-gradient(135deg, #1d4ed8 0%, #1e3a8a 100%)',
    })
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
      avatarUrl: avatarInput.value.trim(),
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextConfig))

    const nextParams = new URLSearchParams()
    nextParams.set('appOrigin', nextConfig.appOrigin)
    nextParams.set('token', nextConfig.token)
    nextParams.set('scriptVersion', nextConfig.scriptVersion)
    nextParams.set('label', nextConfig.label)
    nextParams.set('icon', nextConfig.icon)
    nextParams.set('position', nextConfig.position)
    nextParams.set('avatarUrl', nextConfig.avatarUrl)
    window.location.search = nextParams.toString()
  })

  clearButton.addEventListener('click', () => {
    window.localStorage.removeItem(STORAGE_KEY)
    window.location.search = ''
  })
})()
