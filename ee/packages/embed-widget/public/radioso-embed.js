(function () {
  const SCRIPT_PATH = '/radioso-embed.js'
  const DEFAULT_LABEL = 'Chat with us'
  const DEFAULT_POSITION = 'bottom-right'
  const DEFAULT_ICON = 'chat'
  const DEFAULT_DISPLAY_MODE = 'bubble'
  const DEFAULT_INITIAL_STATE = 'collapsed'
  const READY_MESSAGE = 'radioso:embed:ready'
  const SESSION_MESSAGE = 'radioso:embed:session'
  const ERROR_MESSAGE = 'radioso:embed:error'
  const COLLAPSE_MESSAGE = 'radioso:embed:collapse'
  const PANEL_HANDLE_WIDTH = 56
  const DESKTOP_PANEL_CONTENT_WIDTH = 560
  const NARROW_VIEWPORT_MAX_WIDTH = 640
  const MAX_PAGE_CONTEXT_CONTENT_CHARS = 6000
  const defaultCopy = {
    launcherDefaultLabel: 'Chat with us',
    iframeTitle: 'Radioso embedded chat',
  }

  const defaultTheme = {
    launcherBackground: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
    launcherForeground: '#f8fafc',
    launcherBorder: 'rgba(15, 23, 42, 0.16)',
    launcherShadow: '0 18px 40px rgba(15, 23, 42, 0.24)',
    panelBackground: '#ffffff',
    panelForeground: '#0f172a',
    panelBorder: 'rgba(148, 163, 184, 0.35)',
    panelShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
    accent: '#0f172a',
    accentForeground: '#f8fafc',
    mutedBackground: '#f8fafc',
    mutedForeground: '#64748b',
    inputBackground: '#ffffff',
    inputForeground: '#0f172a',
    inputBorder: '#cbd5e1',
    inputPlaceholder: '#94a3b8',
    assistantBubbleBackground: '#ffffff',
    assistantBubbleForeground: '#0f172a',
    userBubbleBackground: '#0f172a',
    userBubbleForeground: '#f8fafc',
  }

  const deriveTheme = (themeModel, expertOverrides) => {
    const brand = typeof themeModel?.brand === 'string' && themeModel.brand.trim() ? themeModel.brand.trim() : '#0f172a'
    const brandText =
      typeof themeModel?.brandText === 'string' && themeModel.brandText.trim() ? themeModel.brandText.trim() : '#f8fafc'
    const surface =
      typeof themeModel?.surface === 'string' && themeModel.surface.trim() ? themeModel.surface.trim() : '#ffffff'
    const text = typeof themeModel?.text === 'string' && themeModel.text.trim() ? themeModel.text.trim() : '#0f172a'

    return {
      ...defaultTheme,
      launcherBackground: brand,
      launcherForeground: brandText,
      launcherBorder: 'rgba(15, 23, 42, 0.16)',
      launcherShadow: '0 18px 40px rgba(15, 23, 42, 0.24)',
      panelBackground: surface,
      panelForeground: text,
      panelBorder: 'rgba(148, 163, 184, 0.35)',
      panelShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
      accent: brand,
      accentForeground: brandText,
      mutedBackground: 'rgba(148, 163, 184, 0.12)',
      mutedForeground: 'rgba(71, 85, 105, 0.92)',
      inputBackground: surface,
      inputForeground: text,
      inputBorder: 'rgba(148, 163, 184, 0.55)',
      inputPlaceholder: 'rgba(100, 116, 139, 0.9)',
      assistantBubbleBackground: surface,
      assistantBubbleForeground: text,
      userBubbleBackground: brand,
      userBubbleForeground: brandText,
      ...expertOverrides,
    }
  }

  const copyOverrideKeys = [
    'launcherDefaultLabel',
    'embeddedChatTitle',
    'embeddedChatUnavailableTitle',
    'embeddedChatUnavailableMessage',
    'embeddedChatLauncherRequiredMessage',
    'embeddedChatStartingMessage',
    'publicChatSubtitle',
    'publicChatEmptyTitle',
    'publicChatEmptyMessage',
    'startPrompt',
    'publicChatUnavailableTitle',
    'publicChatUnavailableMessage',
    'publicChatLoadOlderMessages',
    'publicChatSendMessageLabel',
    'publicChatNewChatLabel',
    'publicChatCollapseLabel',
    'publicChatDisclaimerTemplate',
    'publicChatRateLimitRetryTemplate',
  ]

  const themeOverrideKeys = [
    'launcherBackground',
    'launcherForeground',
    'launcherBorder',
    'launcherShadow',
    'panelBackground',
    'panelForeground',
    'panelBorder',
    'panelShadow',
    'accent',
    'accentForeground',
    'mutedBackground',
    'mutedForeground',
    'inputBackground',
    'inputForeground',
    'inputBorder',
    'inputPlaceholder',
    'assistantBubbleBackground',
    'assistantBubbleForeground',
    'userBubbleBackground',
    'userBubbleForeground',
  ]

  const iconMarkup = {
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 5.5A3.5 3.5 0 0 1 7.5 2h9A3.5 3.5 0 0 1 20 5.5v7A3.5 3.5 0 0 1 16.5 16H10l-4.5 4v-4.2A3.5 3.5 0 0 1 4 12.5z"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.5 2.5 15 7l4.5 1.5L15 10l-1.5 4.5L12 10 7.5 8.5 12 7zM5 13l1.2 3.8L10 18l-3.8 1.2L5 23l-1.2-3.8L0 18l3.8-1.2zM17 13l1.3 4.2L22.5 18l-4.2 1.3L17 23l-1.3-3.7L11.5 18l4.2-1.3z"/></svg>',
    message: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4.5A2.5 2.5 0 0 1 6.5 2h11A2.5 2.5 0 0 1 20 4.5v9A2.5 2.5 0 0 1 17.5 16H9l-5 4v-4.1A2.5 2.5 0 0 1 4 13.5z"/></svg>',
  }

  const getScriptElement = () => {
    const current = document.currentScript
    if (current && current.tagName === 'SCRIPT') {
      return current
    }

    return Array.from(document.scripts).find((script) => script.dataset && script.dataset.radiosoToken) ?? null
  }

  const getScriptUrl = (script) => {
    try {
      return new URL(script?.src || SCRIPT_PATH, window.location.href)
    } catch {
      return new URL(SCRIPT_PATH, window.location.href)
    }
  }

  const normalizeInitialState = (value) => {
    if (!value) {
      return null
    }

    const normalized = value.trim().toLowerCase()
    return normalized === 'open' || normalized === 'collapsed' ? normalized : null
  }

  const normalizeDisplayMode = (value) => {
    if (!value) {
      return null
    }

    const normalized = value.trim().toLowerCase()
    return normalized === 'bubble' || normalized === 'panel' ? normalized : null
  }

  const normalizeLocale = (value) =>
    typeof value === 'string' ? value.trim().toLowerCase().replace('_', '-') : ''

  const resolveLocaleCopy = (copyPacks) => {
    if (!copyPacks || typeof copyPacks !== 'object') {
      return {}
    }

    const languages = []
    if (Array.isArray(window.navigator?.languages)) {
      languages.push(...window.navigator.languages)
    }
    if (window.navigator?.language) {
      languages.push(window.navigator.language)
    }
    languages.push('default', 'en')

    for (const language of languages) {
      const normalized = normalizeLocale(language)
      const base = normalized.split('-')[0]
      const exact = copyPacks[normalized] || copyPacks[language]
      const fallback = base ? copyPacks[base] : null
      const resolved = exact || fallback
      if (resolved && typeof resolved === 'object') {
        return sanitizeOverrides(resolved, copyOverrideKeys, 280)
      }
    }

    return {}
  }

  const fetchEmbedConfig = async (scriptUrl, token) => {
    try {
      const response = await fetch(new URL(`/api/embed/config/${encodeURIComponent(token)}`, scriptUrl).toString(), {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store',
      })
      if (!response.ok) {
        return {}
      }
      return (await response.json().catch(() => ({}))) || {}
    } catch {
      return {}
    }
  }

  const resolveAvatarUrl = (value, baseUrl) => {
    if (!value) {
      return null
    }

    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    try {
      const url = new URL(trimmed, baseUrl || window.location.href)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
    } catch {
      return null
    }
  }

  const parseJsonOverrides = (value) => {
    if (!value || typeof value !== 'string') {
      return null
    }

    try {
      return JSON.parse(value.trim())
    } catch {
      return null
    }
  }

  const sanitizeOverrides = (input, keys, maxLength) => {
    if (!input || typeof input !== 'object') {
      return {}
    }

    const next = {}
    for (const key of keys) {
      const value = input[key]
      if (typeof value !== 'string') {
        continue
      }
      const trimmed = value.trim()
      if (!trimmed || trimmed.length > maxLength) {
        continue
      }
      next[key] = trimmed
    }
    return next
  }

  const normalizeWhitespace = (value) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''

  const stripUrlQueryAndHash = (value) => {
    try {
      const url = new URL(value, window.location.href)
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return null
    }
  }

  const normalizePageContextMode = (value) =>
    typeof value === 'string' && value.trim().toLowerCase() === 'content' ? 'content' : 'metadata'

  const collectPageContext = (mode) => {
    const pageUrl = stripUrlQueryAndHash(window.location.href)
    const pageTitle = normalizeWhitespace(document.title).slice(0, 180) || null
    const pageLocale = normalizeWhitespace(document.documentElement?.lang).slice(0, 35) || null
    const browserLocale = normalizeWhitespace(window.navigator?.languages?.[0] || window.navigator?.language).slice(0, 35) || null
    const pageContext = {
      pageUrl,
      pageTitle,
      pageLocale,
      browserLocale,
    }

    if (mode === 'content') {
      const bodyText = normalizeWhitespace(document.body?.innerText || document.body?.textContent)
      if (bodyText) {
        pageContext.content = bodyText.slice(0, MAX_PAGE_CONTEXT_CONTENT_CHARS)
      }
    }

    return pageContext
  }

  const getCopy = (overrides) => {
    const next = { ...defaultCopy }
    if (overrides && typeof overrides === 'object') {
      if (overrides.launcherDefaultLabel) {
        next.launcherDefaultLabel = overrides.launcherDefaultLabel
      }
      if (overrides.embeddedChatTitle) {
        next.iframeTitle = overrides.embeddedChatTitle
      }
    }
    return next
  }

  const setIconMarkup = (container, icon) => {
    container.innerHTML = iconMarkup[icon] ?? iconMarkup[DEFAULT_ICON]
    const svg = container.querySelector('svg')
    if (svg) {
      svg.setAttribute('width', '18')
      svg.setAttribute('height', '18')
    }
  }

  const styleLauncherAvatarContainer = (container, theme) => {
    container.setAttribute('aria-hidden', 'true')
    container.dataset.radiosoLauncherAvatar = 'true'
    container.style.display = 'inline-flex'
    container.style.alignItems = 'center'
    container.style.justifyContent = 'center'
    container.style.width = '2rem'
    container.style.height = '2rem'
    container.style.overflow = 'hidden'
    container.style.borderRadius = '0.65rem'
    container.style.flexShrink = '0'
    container.style.background = theme.mutedBackground
    container.style.color = theme.accent
  }

  const setLauncherAvatarMarkup = (container, icon, avatarUrl) => {
    container.innerHTML = ''
    if (avatarUrl) {
      const image = document.createElement('img')
      image.alt = ''
      image.src = avatarUrl
      image.referrerPolicy = 'no-referrer'
      image.style.width = '100%'
      image.style.height = '100%'
      image.style.objectFit = 'cover'
      image.style.display = 'block'
      image.addEventListener(
        'error',
        () => {
          container.innerHTML = ''
          setIconMarkup(container, icon)
        },
        { once: true },
      )
      container.appendChild(image)
    } else {
      setIconMarkup(container, icon)
    }
  }

  const getViewportFrame = () => {
    const viewport = window.visualViewport
    return {
      width: viewport?.width || window.innerWidth || document.documentElement.clientWidth,
      height: viewport?.height || window.innerHeight || document.documentElement.clientHeight,
      offsetLeft: viewport?.offsetLeft || 0,
      offsetTop: viewport?.offsetTop || 0,
    }
  }

  const createPanel = (theme, displayMode, position) => {
    const panel = document.createElement('div')
    panel.setAttribute('aria-hidden', displayMode === 'bubble' ? 'true' : 'false')
    panel.style.overflow = 'hidden'
    panel.style.boxShadow = theme.panelShadow
    panel.style.background = theme.panelBackground
    panel.style.border = `1px solid ${theme.panelBorder}`
    panel.style.pointerEvents = 'auto'

    if (displayMode === 'panel') {
      panel.style.position = 'absolute'
      panel.style.top = '0'
      panel.style.bottom = '0'
      panel.style.width = `calc(100% - ${PANEL_HANDLE_WIDTH}px)`
      panel.style.height = '100%'
      panel.style.maxHeight = '100%'
      panel.style.display = 'block'
      panel.style.borderRadius = '0'
      if (position === 'bottom-left') {
        panel.style.left = '0'
        panel.style.borderLeft = '0'
      } else {
        panel.style.right = '0'
        panel.style.borderRight = '0'
      }
      return panel
    }

    panel.style.width = `min(${DESKTOP_PANEL_CONTENT_WIDTH}px, calc(100vw - 2rem))`
    panel.style.height = '100%'
    panel.style.maxHeight = 'calc(100vh - 2rem)'
    panel.style.borderRadius = '28px'
    panel.style.display = 'none'
    return panel
  }

  const createPanelHandle = (label, icon, avatarUrl, theme, position) => {
    const button = document.createElement('button')
    button.type = 'button'
    const accessibleLabel = label || defaultCopy.launcherDefaultLabel
    button.setAttribute('aria-label', accessibleLabel)
    button.setAttribute('title', accessibleLabel)

    const iconContainer = document.createElement('span')
    styleLauncherAvatarContainer(iconContainer, theme)
    setLauncherAvatarMarkup(iconContainer, icon, avatarUrl)

    button.appendChild(iconContainer)
    button.style.all = 'unset'
    button.style.boxSizing = 'border-box'
    button.style.position = 'absolute'
    button.style.top = '50%'
    button.style.transform = 'translateY(-50%)'
    button.style.width = `${PANEL_HANDLE_WIDTH}px`
    button.style.height = '96px'
    button.style.display = 'inline-flex'
    button.style.alignItems = 'center'
    button.style.justifyContent = 'center'
    button.style.cursor = 'pointer'
    button.style.background = theme.launcherBackground
    button.style.color = theme.launcherForeground
    button.style.border = `1px solid ${theme.launcherBorder}`
    button.style.boxShadow = theme.launcherShadow
    button.style.pointerEvents = 'auto'
    button.style.transition = 'opacity 180ms ease'
    if (position === 'bottom-left') {
      button.style.right = '0'
      button.style.borderRadius = '0 18px 18px 0'
      button.style.borderLeft = '0'
    } else {
      button.style.left = '0'
      button.style.borderRadius = '18px 0 0 18px'
      button.style.borderRight = '0'
    }
    return button
  }

  const createIframe = (scriptUrl, token, options) => {
    const iframe = document.createElement('iframe')
    iframe.title = options.copy.iframeTitle
    iframe.loading = 'lazy'
    iframe.referrerPolicy = 'no-referrer-when-downgrade'
    iframe.allow = 'clipboard-read; clipboard-write'
    iframe.style.border = '0'
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    iframe.style.background = options.theme.panelBackground

    const iframeUrl = new URL(`/embed/${encodeURIComponent(token)}`, scriptUrl)
    if (options.displayMode && options.displayMode !== DEFAULT_DISPLAY_MODE) {
      iframeUrl.searchParams.set('displayMode', options.displayMode)
    }
    if (Object.keys(options.copyOverrides).length > 0) {
      iframeUrl.searchParams.set('copy', JSON.stringify(options.copyOverrides))
    }
    if (Object.keys(options.themeOverrides).length > 0) {
      iframeUrl.searchParams.set('theme', JSON.stringify(options.themeOverrides))
    }

    iframe.src = iframeUrl.toString()
    return iframe
  }

  const bootstrapEmbeddedSession = async (scriptUrl, token, options) => {
    const body =
      options && typeof options.resumeAnonymousSessionId === 'string'
        ? JSON.stringify({ anonymousSessionId: options.resumeAnonymousSessionId })
        : undefined
    const response = await fetch(new URL(`/api/embed/session/${encodeURIComponent(token)}`, scriptUrl).toString(), {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.publicChatToken || !payload?.publicSessionToken || !payload?.publicSessionId) {
      throw new Error(payload?.error?.message || 'Embedded chat could not be started from this website.')
    }

    return payload
  }

  const createButton = (label, icon, avatarUrl, theme) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', label || defaultCopy.launcherDefaultLabel)

    const iconContainer = document.createElement('span')
    styleLauncherAvatarContainer(iconContainer, theme)
    setLauncherAvatarMarkup(iconContainer, icon, avatarUrl)

    button.appendChild(iconContainer)
    if (label) {
      const labelNode = document.createElement('span')
      labelNode.textContent = label
      button.appendChild(labelNode)
    }
    button.style.all = 'unset'
    button.style.boxSizing = 'border-box'
    button.style.display = 'inline-flex'
    button.style.alignItems = 'center'
    button.style.gap = '0.75rem'
    button.style.padding = '0.875rem 1rem'
    button.style.borderRadius = '18px'
    button.style.cursor = 'pointer'
    button.style.background = theme.launcherBackground
    button.style.color = theme.launcherForeground
    button.style.border = `1px solid ${theme.launcherBorder}`
    button.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif'
    button.style.fontSize = '14px'
    button.style.fontWeight = '600'
    button.style.lineHeight = '1'
    button.style.boxShadow = theme.launcherShadow
    button.style.transition = 'transform 140ms ease, opacity 140ms ease'
    button.style.userSelect = 'none'
    button.style.pointerEvents = 'auto'
    button.addEventListener('mouseenter', () => {
      button.style.transform = 'translateY(-1px)'
    })
    button.addEventListener('mouseleave', () => {
      button.style.transform = 'translateY(0)'
    })
    return button
  }

  const init = async () => {
    const script = getScriptElement()
    if (!script) {
      return
    }

    const token = script.dataset.radiosoToken
    if (!token || window.__radiosoEmbedMounted) {
      return
    }
    window.__radiosoEmbedMounted = true

    const scriptUrl = getScriptUrl(script)
    const config = await fetchEmbedConfig(scriptUrl, token)
    const expertOverrides = config && typeof config.expertOverrides === 'object' ? config.expertOverrides : {}
    const copyOverrides = {
      ...resolveLocaleCopy(config.copy),
      ...sanitizeOverrides(expertOverrides, copyOverrideKeys, 280),
    }
    const themeOverrides = sanitizeOverrides(expertOverrides, themeOverrideKeys, 160)
    const copy = getCopy(copyOverrides)
    const theme = deriveTheme(config.theme, themeOverrides)
    const rawLabel = typeof config.launcherLabel === 'string' ? config.launcherLabel : null
    const normalizedLabel = rawLabel === null ? null : rawLabel.trim().replace(/\s+/g, ' ')
    const label =
      normalizedLabel === null || normalizedLabel === DEFAULT_LABEL ? copy.launcherDefaultLabel : normalizedLabel
    const icon = DEFAULT_ICON
    const position = config.launcherPosition === 'bottom-left' ? 'bottom-left' : DEFAULT_POSITION
    const displayMode = normalizeDisplayMode(expertOverrides.displayMode) || DEFAULT_DISPLAY_MODE
    const initialState = normalizeInitialState(expertOverrides.initialState) || DEFAULT_INITIAL_STATE
    const pageContextMode = normalizePageContextMode(expertOverrides.pageContext)
    const pageContext = collectPageContext(pageContextMode)
    const avatarUrl = resolveAvatarUrl(config.assistantLogoUrl, scriptUrl) || new URL('/radioso-logo.png', scriptUrl).toString()

    const host = document.createElement('div')
    host.style.position = 'fixed'
    host.style.zIndex = '2147483647'
    host.style.right = displayMode === 'panel' ? '0' : '16px'
    host.style.left = 'auto'
    host.style.pointerEvents = 'none'
    host.style.overflow = 'visible'

    if (displayMode === 'panel') {
      host.style.top = '0'
      host.style.bottom = '0'
      host.style.width = `min(${DESKTOP_PANEL_CONTENT_WIDTH + PANEL_HANDLE_WIDTH}px, 100vw)`
      host.style.maxWidth = '100vw'
    } else {
      host.style.top = '16px'
      host.style.bottom = '16px'
      host.style.display = 'flex'
      host.style.flexDirection = 'column'
      host.style.alignItems = 'flex-end'
      host.style.justifyContent = 'flex-end'
      host.style.gap = '12px'
      host.style.maxWidth = 'calc(100vw - 2rem)'
    }

    if (position === 'bottom-left') {
      host.style.left = displayMode === 'panel' ? '0' : '16px'
      host.style.right = 'auto'
      if (displayMode !== 'panel') {
        host.style.alignItems = 'flex-start'
      }
    }

    const panel = createPanel(theme, displayMode, position)
    const button =
      displayMode === 'panel'
        ? createPanelHandle(label, icon, avatarUrl, theme, position)
        : createButton(label, icon, avatarUrl, theme)
    const shell = displayMode === 'panel' ? document.createElement('div') : null
    if (shell) {
      shell.style.position = 'absolute'
      shell.style.top = '0'
      shell.style.bottom = '0'
      shell.style.left = '0'
      shell.style.right = '0'
      shell.style.transition = 'transform 220ms ease'
      shell.style.willChange = 'transform'
      shell.style.pointerEvents = 'none'
    }

    let isOpen = initialState === 'open'
    let isFullscreenOpen = false
    let bootstrapPromise = null
    let iframe = null

    const applyResponsiveLayout = () => {
      const viewport = getViewportFrame()
      isFullscreenOpen = isOpen && viewport.width <= NARROW_VIEWPORT_MAX_WIDTH

      if (isFullscreenOpen) {
        host.style.top = `${viewport.offsetTop}px`
        host.style.left = `${viewport.offsetLeft}px`
        host.style.right = 'auto'
        host.style.bottom = 'auto'
        host.style.width = `${viewport.width}px`
        host.style.height = `${viewport.height}px`
        host.style.maxWidth = 'none'
        host.style.display = 'block'
        host.style.overflow = 'hidden'
        host.style.alignItems = ''
        host.style.justifyContent = ''
        host.style.gap = ''

        panel.style.width = '100%'
        panel.style.height = '100%'
        panel.style.maxHeight = 'none'
        panel.style.border = '0'
        panel.style.borderRadius = '0'
        panel.style.boxShadow = 'none'
        panel.style.left = '0'
        panel.style.right = '0'

        if (shell) {
          shell.style.top = '0'
          shell.style.bottom = '0'
          shell.style.left = '0'
          shell.style.right = '0'
        }
        return
      }

      host.style.height = ''
      host.style.overflow = 'visible'

      panel.style.border = `1px solid ${theme.panelBorder}`
      panel.style.boxShadow = theme.panelShadow

      if (displayMode === 'panel') {
        host.style.top = '0'
        host.style.bottom = '0'
        host.style.width = `min(${DESKTOP_PANEL_CONTENT_WIDTH + PANEL_HANDLE_WIDTH}px, 100vw)`
        host.style.maxWidth = '100vw'
        host.style.display = 'block'

        if (position === 'bottom-left') {
          host.style.left = '0'
          host.style.right = 'auto'
        } else {
          host.style.left = 'auto'
          host.style.right = '0'
        }

        panel.style.width = `calc(100% - ${PANEL_HANDLE_WIDTH}px)`
        panel.style.height = '100%'
        panel.style.maxHeight = '100%'
        panel.style.borderRadius = '0'
        if (position === 'bottom-left') {
          panel.style.left = '0'
          panel.style.right = 'auto'
          panel.style.borderLeft = '0'
          panel.style.borderRight = ''
        } else {
          panel.style.left = 'auto'
          panel.style.right = '0'
          panel.style.borderLeft = ''
          panel.style.borderRight = '0'
        }
        return
      }

      host.style.top = '16px'
      host.style.bottom = '16px'
      host.style.width = ''
      host.style.maxWidth = 'calc(100vw - 2rem)'
      host.style.display = 'flex'
      host.style.flexDirection = 'column'
      host.style.alignItems = position === 'bottom-left' ? 'flex-start' : 'flex-end'
      host.style.justifyContent = 'flex-end'
      host.style.gap = '12px'
      if (position === 'bottom-left') {
        host.style.left = '16px'
        host.style.right = 'auto'
      } else {
        host.style.left = 'auto'
        host.style.right = '16px'
      }

      panel.style.width = `min(${DESKTOP_PANEL_CONTENT_WIDTH}px, calc(100vw - 2rem))`
      panel.style.height = '100%'
      panel.style.maxHeight = 'calc(100vh - 2rem)'
      panel.style.borderRadius = '28px'
      panel.style.left = ''
      panel.style.right = ''
      panel.style.borderLeft = ''
      panel.style.borderRight = ''
    }

    const ensureIframe = () => {
      if (iframe) {
        return iframe
      }

      iframe = createIframe(scriptUrl, token, {
        displayMode,
        copy,
        copyOverrides,
        theme,
        themeOverrides,
      })
      panel.appendChild(iframe)
      return iframe
    }

    const handleIframeMessage = (event) => {
      if (event.source !== (iframe && iframe.contentWindow)) {
        return
      }

      if (!event.data || typeof event.data !== 'object') {
        return
      }

      if (event.data.type === COLLAPSE_MESSAGE) {
        isOpen = false
        updatePanelVisibility()
        return
      }

      if (event.data.type !== READY_MESSAGE) {
        return
      }

      const resumeAnonymousSessionId =
        typeof event.data.resumeAnonymousSessionId === 'string' ? event.data.resumeAnonymousSessionId : null

      if (!bootstrapPromise) {
        const activeIframe = iframe
        const activeContentWindow = activeIframe && activeIframe.contentWindow

        bootstrapPromise = bootstrapEmbeddedSession(scriptUrl, token, { resumeAnonymousSessionId })
          .then((session) => {
            if (!activeContentWindow || iframe !== activeIframe) {
              return
            }

            const sessionAvatarUrl = resolveAvatarUrl(session.assistantAvatarUrl, scriptUrl)
            const iconContainer = button.querySelector('[data-radioso-launcher-avatar="true"]')
            if (sessionAvatarUrl && iconContainer) {
              setLauncherAvatarMarkup(iconContainer, icon, sessionAvatarUrl)
            }
            activeContentWindow.postMessage({ type: SESSION_MESSAGE, session, pageContext }, scriptUrl.origin)
          })
          .catch((error) => {
            if (!activeContentWindow || iframe !== activeIframe) {
              return
            }

            activeContentWindow.postMessage(
              {
                type: ERROR_MESSAGE,
                message: error instanceof Error ? error.message : 'Embedded chat could not be started from this website.',
              },
              scriptUrl.origin,
            )
          })
          .finally(() => {
            if (iframe === activeIframe) {
              bootstrapPromise = null
            }
          })
      }
    }

    const updatePanelVisibility = () => {
      applyResponsiveLayout()
      if (displayMode === 'panel' && shell) {
        shell.style.transform =
          isOpen || isFullscreenOpen
            ? 'translateX(0)'
            : position === 'bottom-left'
              ? `translateX(calc(-100% + ${PANEL_HANDLE_WIDTH}px))`
              : `translateX(calc(100% - ${PANEL_HANDLE_WIDTH}px))`
        shell.style.pointerEvents = 'none'
        button.style.display = isFullscreenOpen ? 'none' : 'inline-flex'
        button.style.opacity = isOpen ? '0' : '1'
        button.style.pointerEvents = isOpen ? 'none' : 'auto'
        panel.style.pointerEvents = isOpen ? 'auto' : 'none'
      } else {
        panel.style.display = isOpen ? 'block' : 'none'
        button.style.display = isFullscreenOpen ? 'none' : 'inline-flex'
        button.style.opacity = isOpen ? '0.94' : '1'
        button.style.pointerEvents = isFullscreenOpen ? 'none' : 'auto'
      }
      panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true')
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
    }

    button.addEventListener('click', () => {
      isOpen = !isOpen
      if (isOpen) {
        ensureIframe()
      }
      updatePanelVisibility()
    })

    if (isOpen) {
      ensureIframe()
    }

    if (shell) {
      shell.appendChild(panel)
      shell.appendChild(button)
      host.appendChild(shell)
    } else {
      host.appendChild(panel)
      host.appendChild(button)
    }
    window.addEventListener('message', handleIframeMessage)
    window.addEventListener('resize', updatePanelVisibility)
    window.visualViewport?.addEventListener('resize', updatePanelVisibility)
    window.visualViewport?.addEventListener('scroll', updatePanelVisibility)
    updatePanelVisibility()
    document.body.appendChild(host)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }
})()
