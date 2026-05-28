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
  const FULLSCREEN_MESSAGE = 'radioso:embed:fullscreen'
  const RESET_SESSION_MESSAGE = 'radioso:embed:reset-session'
  const TYPING_MESSAGE = 'radioso:embed:typing'
  const STYLE_ELEMENT_ID = 'radioso-embed-style'
  const ATTENTION_PRESETS = new Set(['none', 'breathe', 'pulse', 'nudge', 'bounce-in'])
  const DEFAULT_TEASER_DELAY_MS = 4000
  const TEASER_AUTO_HIDE_MS = 25000
  const PANEL_HANDLE_WIDTH = 56
  const DESKTOP_PANEL_CONTENT_WIDTH = 560
  const DESKTOP_BUBBLE_MAX_HEIGHT = 720
  const NARROW_VIEWPORT_MAX_WIDTH = 640
  // Phones in landscape have width > 640 but very short height (~320-430px),
  // so a width-only check leaves the chat as a tiny bubble that's barely
  // usable. Treat short viewports as fullscreen too; tablets in landscape
  // are typically ≥768px tall so they keep the bubble.
  const NARROW_VIEWPORT_MAX_HEIGHT = 500
  const MAX_PAGE_CONTEXT_CONTENT_CHARS = 6000
  const defaultCopy = {
    launcherDefaultLabel: 'Chat with us',
    iframeTitle: 'Radioso embedded chat',
    proactiveGreetingTeaser: 'Hi! How can I help?',
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
    'proactiveGreetingTeaser',
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
    'publicChatOpenFullScreenLabel',
    'publicChatOpenNewTabLabel',
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

  // Session-scoped so visitors get a fresh attention nudge / greeting teaser on
  // every new tab session — friendlier for testing and matches the way most
  // chat widgets behave. Closing the tab clears the flags; reloads keep them.
  const safeStorage = {
    get(key) {
      try {
        return window.sessionStorage.getItem(key)
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        window.sessionStorage.setItem(key, value)
      } catch {
        /* storage may be blocked (privacy mode, sandboxed iframe) — fail silently */
      }
    },
    remove(key) {
      try {
        window.sessionStorage.removeItem(key)
      } catch {
        /* storage may be blocked (privacy mode, sandboxed iframe) — fail silently */
      }
    },
  }

  const prefersReducedMotion = () => {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch {
      return false
    }
  }

  const normalizeAttention = (value) => {
    if (typeof value !== 'string') {
      return 'none'
    }
    const normalized = value.trim().toLowerCase()
    return ATTENTION_PRESETS.has(normalized) ? normalized : 'none'
  }

  const parsePositiveInt = (value, fallback) => {
    if (typeof value !== 'string') {
      return fallback
    }
    const parsed = parseInt(value.trim(), 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }

  const ensureStylesInjected = () => {
    if (document.getElementById(STYLE_ELEMENT_ID)) {
      return
    }
    const style = document.createElement('style')
    style.id = STYLE_ELEMENT_ID
    style.textContent = [
      '@keyframes radioso-breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.04); } }',
      '@keyframes radioso-nudge { 0%,90%,100% { transform: rotate(0deg); } 92% { transform: rotate(-6deg); } 94% { transform: rotate(5deg); } 96% { transform: rotate(-4deg); } 98% { transform: rotate(2deg); } }',
      '@keyframes radioso-pulse-ring { 0% { transform: scale(0.85); opacity: 0.6; } 100% { transform: scale(1.6); opacity: 0; } }',
      '@keyframes radioso-bounce-in { 0% { transform: scale(0.6); opacity: 0; } 60% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }',
      '@keyframes radioso-typing-ring { 0% { box-shadow: 0 0 0 0 var(--radioso-accent, rgba(15,23,42,0.55)); } 70% { box-shadow: 0 0 0 8px rgba(15,23,42,0); } 100% { box-shadow: 0 0 0 0 rgba(15,23,42,0); } }',
      '@keyframes radioso-teaser-in { 0% { transform: translateY(8px) scale(0.96); opacity: 0; } 100% { transform: translateY(0) scale(1); opacity: 1; } }',
      '.radioso-launcher { position: relative; }',
      // !important needed because the launcher button uses inline `all: unset`,
      // which sets `animation: none` inline. Stylesheet rules normally lose to
      // inline styles unless they declare !important. (The `pulse` variant
      // below animates a ::before pseudo-element, which isn\'t affected by the
      // button\'s inline styles, so it doesn\'t need !important.)
      '.radioso-launcher[data-radioso-attention="breathe"] { animation: radioso-breathe 3.4s ease-in-out infinite !important; }',
      '.radioso-launcher[data-radioso-attention="nudge"] { animation: radioso-nudge 8s ease-in-out infinite !important; transform-origin: 50% 80%; }',
      '.radioso-launcher[data-radioso-attention="bounce-in"] { animation: radioso-bounce-in 700ms cubic-bezier(0.34, 1.56, 0.64, 1) 1 !important; }',
      '.radioso-launcher[data-radioso-attention="pulse"]::before { content: ""; position: absolute; inset: 0; border-radius: inherit; background: var(--radioso-pulse-color, rgba(15,23,42,0.45)); z-index: -1; animation: radioso-pulse-ring 2.2s ease-out infinite; pointer-events: none; }',
      '.radioso-launcher[data-radioso-typing="true"] .radioso-launcher-avatar { animation: radioso-typing-ring 1.4s ease-out infinite; }',
      '.radioso-launcher-dot { position: absolute; top: 4px; right: 6px; width: 10px; height: 10px; border-radius: 9999px; background: var(--radioso-dot-color, #ef4444); border: 2px solid var(--radioso-dot-border, #ffffff); opacity: 0; transform: scale(0.6); transition: opacity 180ms ease, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1); pointer-events: none; }',
      '.radioso-launcher-dot[data-visible="true"] { opacity: 1; transform: scale(1); }',
      '.radioso-teaser { position: relative; max-width: 280px; padding: 12px 14px; border-radius: 16px; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; line-height: 1.4; cursor: pointer; pointer-events: auto; opacity: 0; transform: translateY(8px) scale(0.96); transform-origin: bottom right; animation: radioso-teaser-in 280ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }',
      '.radioso-teaser[data-position="bottom-left"] { transform-origin: bottom left; }',
      '.radioso-teaser-close { position: absolute; top: 4px; right: 6px; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 9999px; background: transparent; color: inherit; opacity: 0.55; cursor: pointer; font: inherit; font-size: 14px; line-height: 1; padding: 0; }',
      '.radioso-teaser-close:hover { opacity: 1; }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .radioso-launcher[data-radioso-attention] { animation: none !important; }',
      '  .radioso-launcher[data-radioso-attention="pulse"]::before { animation: none !important; opacity: 0 !important; }',
      '  .radioso-launcher[data-radioso-typing="true"] .radioso-launcher-avatar { animation: none !important; }',
      '  .radioso-teaser { animation: none !important; opacity: 1; transform: none; }',
      '}',
    ].join('\n')
    document.head.appendChild(style)
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

  const normalizeIcon = (value) => {
    if (!value) {
      return null
    }

    const normalized = value.trim().toLowerCase()
    return Object.prototype.hasOwnProperty.call(iconMarkup, normalized) ? normalized : null
  }

  const normalizeLocale = (value) =>
    typeof value === 'string' ? value.trim().toLowerCase().replace('_', '-') : ''

  const getVisitorLanguageList = () => {
    const languages = []
    if (Array.isArray(window.navigator?.languages)) {
      languages.push(...window.navigator.languages)
    }
    if (window.navigator?.language) {
      languages.push(window.navigator.language)
    }
    languages.push('default', 'en')
    return languages
  }

  const pickLocalePack = (copyPacks, languages) => {
    for (const language of languages) {
      const normalized = normalizeLocale(language)
      const base = normalized.split('-')[0]
      const exact = copyPacks[normalized] || copyPacks[language]
      const fallback = base ? copyPacks[base] : null
      const resolved = exact || fallback
      if (resolved && typeof resolved === 'object') {
        return resolved
      }
    }
    return null
  }

  const resolveLocaleCopy = (copyPacks) => {
    if (!copyPacks || typeof copyPacks !== 'object') {
      return {}
    }
    const resolved = pickLocalePack(copyPacks, getVisitorLanguageList())
    return resolved ? sanitizeOverrides(resolved, copyOverrideKeys, 280) : {}
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

  const readDatasetValue = (dataset, key) =>
    dataset && Object.prototype.hasOwnProperty.call(dataset, key) && typeof dataset[key] === 'string'
      ? dataset[key]
      : null

  const mergeDatasetStringOverride = (target, dataset, datasetKey, overrideKey) => {
    const value = readDatasetValue(dataset, datasetKey)
    if (value === null) {
      return
    }
    const trimmed = value.trim()
    if (trimmed) {
      target[overrideKey] = trimmed
    }
  }

  const readScriptExpertOverrides = (script) => {
    const dataset = script?.dataset || {}
    const scriptOverrideJson = parseJsonOverrides(dataset.radiosoExpertOverrides)
    const overrides =
      scriptOverrideJson && typeof scriptOverrideJson === 'object' && !Array.isArray(scriptOverrideJson)
        ? { ...scriptOverrideJson }
        : {}

    mergeDatasetStringOverride(overrides, dataset, 'radiosoDisplayMode', 'displayMode')
    mergeDatasetStringOverride(overrides, dataset, 'radiosoInitialState', 'initialState')
    mergeDatasetStringOverride(overrides, dataset, 'radiosoPageContext', 'pageContext')
    mergeDatasetStringOverride(overrides, dataset, 'radiosoLauncherAttention', 'launcherAttention')
    mergeDatasetStringOverride(overrides, dataset, 'radiosoLauncherTeaserDelayMs', 'launcherTeaserDelayMs')
    mergeDatasetStringOverride(overrides, dataset, 'radiosoProactiveGreetingTeaser', 'proactiveGreetingTeaser')

    return overrides
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
      svg.style.width = '70%'
      svg.style.height = '70%'
    }
  }

  const styleLauncherAvatarContainer = (container, theme, size = 'compact') => {
    const isLarge = size === 'large'
    container.setAttribute('aria-hidden', 'true')
    container.dataset.radiosoLauncherAvatar = 'true'
    container.className = 'radioso-launcher-avatar'
    container.style.display = 'inline-flex'
    container.style.alignItems = 'center'
    container.style.justifyContent = 'center'
    container.style.width = isLarge ? '3rem' : '2rem'
    container.style.height = isLarge ? '3rem' : '2rem'
    container.style.overflow = 'hidden'
    container.style.borderRadius = isLarge ? '0.85rem' : '0.65rem'
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
    panel.style.maxHeight = `min(${DESKTOP_BUBBLE_MAX_HEIGHT}px, calc(100vh - 2rem))`
    panel.style.borderRadius = '28px'
    panel.style.display = 'none'
    return panel
  }

  const createPanelHandle = (label, icon, avatarUrl, theme, position) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'radioso-launcher'
    const accessibleLabel = label || defaultCopy.launcherDefaultLabel
    button.setAttribute('aria-label', accessibleLabel)
    button.setAttribute('title', accessibleLabel)

    const iconContainer = document.createElement('span')
    styleLauncherAvatarContainer(iconContainer, theme, 'large')
    setLauncherAvatarMarkup(iconContainer, icon, avatarUrl)

    const dot = document.createElement('span')
    dot.className = 'radioso-launcher-dot'
    dot.setAttribute('aria-hidden', 'true')

    button.appendChild(iconContainer)
    button.appendChild(dot)
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

    const iframeUrl = new URL('/embed-frame', scriptUrl)
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
      options && typeof options.resumeToken === 'string'
        ? JSON.stringify({ resumeToken: options.resumeToken })
        : undefined
    const response = await fetch(new URL(`/api/embed/session/${encodeURIComponent(token)}`, scriptUrl).toString(), {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.publicChatToken || !payload?.publicSessionToken || !payload?.publicSessionId || !payload?.resumeToken) {
      const error = new Error(payload?.error?.message || 'Embedded chat could not be started from this website.')
      error.status = response.status
      error.code = payload?.error?.code
      throw error
    }

    return payload
  }

  const isInvalidResumeSessionError = (error) =>
    error &&
    error.status === 400 &&
    error.code === 'bad_request' &&
    error.message === 'Invalid public chat session request'

  const bootstrapEmbeddedSessionWithResumeFallback = async (scriptUrl, token, storageKey) => {
    const resumeToken = readStoredResumeToken(storageKey)
    try {
      const session = await bootstrapEmbeddedSession(scriptUrl, token, { resumeToken })
      return { session, resumed: Boolean(resumeToken) }
    } catch (error) {
      if (!resumeToken || !isInvalidResumeSessionError(error)) {
        throw error
      }

      safeStorage.remove(storageKey)
      const session = await bootstrapEmbeddedSession(scriptUrl, token, {})
      return { session, resumed: false }
    }
  }

  const readStoredResumeToken = (storageKey) => {
    const rawValue = safeStorage.get(storageKey)
    if (!rawValue) {
      return null
    }

    try {
      const parsed = JSON.parse(rawValue)
      if (!parsed || typeof parsed.resumeToken !== 'string' || typeof parsed.resumeExpiresAt !== 'string') {
        safeStorage.remove(storageKey)
        return null
      }

      if (Date.parse(parsed.resumeExpiresAt) <= Date.now()) {
        safeStorage.remove(storageKey)
        return null
      }

      return parsed.resumeToken
    } catch {
      safeStorage.remove(storageKey)
      return null
    }
  }

  const storeResumeToken = (storageKey, session) => {
    if (!session || typeof session.resumeToken !== 'string' || typeof session.resumeExpiresAt !== 'string') {
      safeStorage.remove(storageKey)
      return
    }

    safeStorage.set(storageKey, JSON.stringify({
      resumeToken: session.resumeToken,
      resumeExpiresAt: session.resumeExpiresAt,
    }))
  }

  const createButton = (label, icon, avatarUrl, theme) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'radioso-launcher'
    button.setAttribute('aria-label', label || defaultCopy.launcherDefaultLabel)
    const hasVisibleLabel = Boolean(label)

    const iconContainer = document.createElement('span')
    styleLauncherAvatarContainer(iconContainer, theme, hasVisibleLabel ? 'compact' : 'large')
    setLauncherAvatarMarkup(iconContainer, icon, avatarUrl)

    button.appendChild(iconContainer)
    if (hasVisibleLabel) {
      const labelNode = document.createElement('span')
      labelNode.textContent = label
      button.appendChild(labelNode)
    }

    const dot = document.createElement('span')
    dot.className = 'radioso-launcher-dot'
    dot.setAttribute('aria-hidden', 'true')
    button.appendChild(dot)

    button.style.all = 'unset'
    button.style.position = 'relative'
    button.style.boxSizing = 'border-box'
    button.style.display = 'inline-flex'
    button.style.alignItems = 'center'
    button.style.gap = '0.75rem'
    button.style.padding = hasVisibleLabel ? '0.875rem 1rem' : '0.5rem'
    button.style.borderRadius = hasVisibleLabel ? '18px' : '24px'
    button.style.cursor = 'pointer'
    button.style.background = theme.launcherBackground
    button.style.color = theme.launcherForeground
    button.style.border = `1px solid ${theme.launcherBorder}`
    button.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif'
    button.style.fontSize = '14px'
    button.style.fontWeight = '600'
    button.style.lineHeight = '1'
    button.style.boxShadow = `${theme.launcherShadow}, inset 0 1px 0 rgba(255, 255, 255, 0.18)`
    button.style.transition = 'box-shadow 200ms ease, opacity 140ms ease'
    button.style.userSelect = 'none'
    button.style.pointerEvents = 'auto'
    button.addEventListener('mouseenter', () => {
      button.style.boxShadow = `0 22px 48px rgba(15, 23, 42, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.22)`
    })
    button.addEventListener('mouseleave', () => {
      button.style.boxShadow = `${theme.launcherShadow}, inset 0 1px 0 rgba(255, 255, 255, 0.18)`
    })
    return button
  }

  const createTeaser = (text, theme, position) => {
    const teaser = document.createElement('div')
    teaser.className = 'radioso-teaser'
    teaser.setAttribute('role', 'button')
    teaser.setAttribute('tabindex', '0')
    teaser.dataset.position = position === 'bottom-left' ? 'bottom-left' : 'bottom-right'
    teaser.style.background = theme.assistantBubbleBackground
    teaser.style.color = theme.assistantBubbleForeground
    teaser.style.border = `1px solid ${theme.panelBorder}`
    teaser.style.boxShadow = theme.panelShadow

    const body = document.createElement('span')
    body.textContent = text
    body.style.display = 'block'
    body.style.paddingRight = '14px'
    teaser.appendChild(body)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'radioso-teaser-close'
    close.setAttribute('aria-label', 'Dismiss')
    close.textContent = '×'
    teaser.appendChild(close)
    return { teaser, close }
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
    const scriptOverrides = readScriptExpertOverrides(script)
    const configOverrides = config && typeof config.expertOverrides === 'object' ? config.expertOverrides : {}
    const expertOverrides = { ...configOverrides, ...scriptOverrides }
    const scriptCopyOverrides = sanitizeOverrides(parseJsonOverrides(script.dataset.radiosoCopy), copyOverrideKeys, 280)
    const scriptThemeOverrides = sanitizeOverrides(parseJsonOverrides(script.dataset.radiosoTheme), themeOverrideKeys, 160)
    // The server's `/embed-config` endpoint already merges a built-in locale
    // pack (matched against this visitor's Accept-Language) into `config.copy`
    // under the `default` key, so `resolveLocaleCopy` picks it up via its
    // existing fallback chain. Operator's per-locale packs still win.
    const copyOverrides = {
      ...resolveLocaleCopy(config.copy),
      ...sanitizeOverrides(expertOverrides, copyOverrideKeys, 280),
      ...scriptCopyOverrides,
    }
    const themeOverrides = {
      ...sanitizeOverrides(expertOverrides, themeOverrideKeys, 160),
      ...scriptThemeOverrides,
    }
    const copy = getCopy(copyOverrides)
    const theme = deriveTheme(config.theme, themeOverrides)
    const rawLabel =
      readDatasetValue(script.dataset, 'radiosoLauncherLabel') ??
      (typeof config.launcherLabel === 'string' ? config.launcherLabel : null)
    const normalizedLabel = rawLabel === null ? null : rawLabel.trim().replace(/\s+/g, ' ')
    const label =
      normalizedLabel === null || normalizedLabel === DEFAULT_LABEL ? copy.launcherDefaultLabel : normalizedLabel
    const icon = normalizeIcon(readDatasetValue(script.dataset, 'radiosoLauncherIcon')) || DEFAULT_ICON
    const scriptPosition = readDatasetValue(script.dataset, 'radiosoLauncherPosition')
    const position =
      scriptPosition === 'bottom-left' || scriptPosition === 'bottom-right'
        ? scriptPosition
        : config.launcherPosition === 'bottom-left'
          ? 'bottom-left'
          : DEFAULT_POSITION
    const displayMode = normalizeDisplayMode(expertOverrides.displayMode) || DEFAULT_DISPLAY_MODE
    const initialState = normalizeInitialState(expertOverrides.initialState) || DEFAULT_INITIAL_STATE
    const pageContextMode = normalizePageContextMode(expertOverrides.pageContext)
    const pageContext = collectPageContext(pageContextMode)
    const avatarUrl = resolveAvatarUrl(config.assistantLogoUrl, scriptUrl) || new URL('/radioso-icon.svg', scriptUrl).toString()

    const proactiveGreetingAttr =
      typeof script.dataset.radiosoProactiveGreeting === 'string'
        ? script.dataset.radiosoProactiveGreeting.trim().toLowerCase()
        : null
    const proactiveGreetingEnabled =
      proactiveGreetingAttr === 'true'
        ? true
        : proactiveGreetingAttr === 'false'
          ? false
          : Boolean(config && config.proactiveGreetingEnabled)
    const attentionPreset = normalizeAttention(expertOverrides.launcherAttention)
    const teaserDelayMs = parsePositiveInt(expertOverrides.launcherTeaserDelayMs, DEFAULT_TEASER_DELAY_MS)
    const teaserText = (copyOverrides.proactiveGreetingTeaser || defaultCopy.proactiveGreetingTeaser).trim()
    const reducedMotion = prefersReducedMotion()
    const openedStorageKey = `radioso:embed:opened:${token}`
    const teaserStorageKey = `radioso:embed:teaserDismissed:${token}`
    const resumeStorageKey = `radioso:embed:resume:${token}`
    const hasBeenOpened = safeStorage.get(openedStorageKey) === '1'
    const teaserPreviouslyDismissed = safeStorage.get(teaserStorageKey) === '1'
    ensureStylesInjected()

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
    const panelMotionTransition = reducedMotion
      ? 'none'
      : 'opacity 200ms ease, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)'
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

    button.style.setProperty('--radioso-accent', theme.accent)
    button.style.setProperty('--radioso-pulse-color', theme.accent)
    button.style.setProperty('--radioso-dot-color', '#ef4444')
    button.style.setProperty('--radioso-dot-border', theme.launcherBackground)

    // Panel-handle launchers have an absolute-position transform; keyframe-based
    // attention animations would override that and break vertical centering, so
    // only apply them to bubble-mode launchers.
    const attentionEnabled =
      attentionPreset !== 'none' && !reducedMotion && !hasBeenOpened && displayMode !== 'panel'
    if (attentionEnabled) {
      button.dataset.radiosoAttention = attentionPreset
    }
    if (displayMode !== 'panel') {
      panel.style.transformOrigin = position === 'bottom-left' ? '0% 100%' : '100% 100%'
      panel.style.transition = panelMotionTransition
      panel.style.willChange = 'opacity, transform'
    }

    const dotEl = button.querySelector('.radioso-launcher-dot')
    let teaser = null
    let teaserCloseBtn = null
    let teaserTimer = null
    let teaserScrollHandler = null

    const showLauncherDot = (visible) => {
      if (!dotEl) {
        return
      }
      if (visible) {
        dotEl.dataset.visible = 'true'
      } else {
        delete dotEl.dataset.visible
      }
    }

    let isOpen = initialState === 'open'
    let isFullscreenOpen = false
    let isManualFullscreenOpen = false
    let bootstrapPromise = null
    let iframe = null

    const applyResponsiveLayout = () => {
      const viewport = getViewportFrame()
      isFullscreenOpen =
        isOpen &&
        (
          isManualFullscreenOpen ||
          viewport.width <= NARROW_VIEWPORT_MAX_WIDTH ||
          viewport.height <= NARROW_VIEWPORT_MAX_HEIGHT
        )

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
      panel.style.maxHeight = `min(${DESKTOP_BUBBLE_MAX_HEIGHT}px, calc(100vh - 2rem))`
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

      if (event.origin !== scriptUrl.origin) {
        return
      }

      if (!event.data || typeof event.data !== 'object') {
        return
      }

      if (event.data.type === RESET_SESSION_MESSAGE) {
        safeStorage.remove(resumeStorageKey)
        bootstrapPromise = null
        return
      }

      if (event.data.type === COLLAPSE_MESSAGE) {
        isOpen = false
        isManualFullscreenOpen = false
        updatePanelVisibility()
        return
      }

      if (event.data.type === FULLSCREEN_MESSAGE) {
        isOpen = true
        isManualFullscreenOpen = !isManualFullscreenOpen
        ensureIframe()
        markOpened()
        updatePanelVisibility({ animateFullscreenTransition: true })
        return
      }

      if (event.data.type !== READY_MESSAGE) {
        return
      }

      if (!bootstrapPromise) {
        const activeIframe = iframe
        const activeContentWindow = activeIframe && activeIframe.contentWindow

        bootstrapPromise = bootstrapEmbeddedSessionWithResumeFallback(scriptUrl, token, resumeStorageKey)
          .then(({ session, resumed }) => {
            if (!activeContentWindow || iframe !== activeIframe) {
              return
            }

            storeResumeToken(resumeStorageKey, session)
            const sessionAvatarUrl = resolveAvatarUrl(session.assistantAvatarUrl, scriptUrl)
            const iconContainer = button.querySelector('[data-radioso-launcher-avatar="true"]')
            if (sessionAvatarUrl && iconContainer) {
              setLauncherAvatarMarkup(iconContainer, icon, sessionAvatarUrl)
            }
            activeContentWindow.postMessage({ type: SESSION_MESSAGE, session, pageContext, resumed }, scriptUrl.origin)
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

    let panelHideTimer = null
    let panelLayoutAnimationTimer = null
    const animateBubblePanel = (visible) => {
      if (panelHideTimer) {
        clearTimeout(panelHideTimer)
        panelHideTimer = null
      }
      if (visible) {
        panel.style.display = 'block'
        if (reducedMotion) {
          panel.style.opacity = '1'
          panel.style.transform = 'none'
          return
        }
        panel.style.opacity = '0'
        panel.style.transform = 'scale(0.92) translateY(8px)'
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            panel.style.opacity = '1'
            panel.style.transform = 'none'
          })
        })
        return
      }

      if (reducedMotion) {
        panel.style.display = 'none'
        return
      }
      panel.style.opacity = '0'
      panel.style.transform = 'scale(0.92) translateY(8px)'
      panelHideTimer = setTimeout(() => {
        panel.style.display = 'none'
      }, 240)
    }

    const animateFullscreenPanel = (direction) => {
      if (panelHideTimer) {
        clearTimeout(panelHideTimer)
        panelHideTimer = null
      }
      if (panelLayoutAnimationTimer) {
        clearTimeout(panelLayoutAnimationTimer)
        panelLayoutAnimationTimer = null
      }

      panel.style.display = 'block'
      if (reducedMotion) {
        panel.style.opacity = '1'
        panel.style.transform = 'none'
        return
      }

      const previousTransition = panel.style.transition
      const previousTransformOrigin = panel.style.transformOrigin
      const previousWillChange = panel.style.willChange
      const needsTemporaryTransition = displayMode === 'panel'

      if (needsTemporaryTransition) {
        panel.style.transition = panelMotionTransition
        panel.style.transformOrigin = position === 'bottom-left' ? '0% 50%' : '100% 50%'
      }
      panel.style.willChange = 'opacity, transform'
      panel.style.opacity = '0.92'
      panel.style.transform = direction === 'contract' ? 'scale(1.03) translateY(-6px)' : 'scale(0.96) translateY(8px)'

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          panel.style.opacity = '1'
          panel.style.transform = 'none'
        })
      })

      if (needsTemporaryTransition) {
        panelLayoutAnimationTimer = setTimeout(() => {
          panel.style.transition = previousTransition
          panel.style.transformOrigin = previousTransformOrigin
          panel.style.willChange = previousWillChange
          panelLayoutAnimationTimer = null
        }, 260)
      }
    }

    const updatePanelVisibility = (options = {}) => {
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
        if (options.animateFullscreenTransition) {
          animateFullscreenPanel(isFullscreenOpen ? 'expand' : 'contract')
        }
      } else {
        if (options.animateFullscreenTransition) {
          animateFullscreenPanel(isFullscreenOpen ? 'expand' : 'contract')
        } else {
          animateBubblePanel(isOpen || isFullscreenOpen)
        }
        button.style.display = isFullscreenOpen ? 'none' : 'inline-flex'
        button.style.opacity = isOpen ? '0.94' : '1'
        button.style.pointerEvents = isFullscreenOpen ? 'none' : 'auto'
      }
      panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true')
      button.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
    }

    const dismissTeaser = (persist) => {
      if (teaserTimer) {
        clearTimeout(teaserTimer)
        teaserTimer = null
      }
      if (teaserScrollHandler) {
        window.removeEventListener('scroll', teaserScrollHandler, { passive: true })
        teaserScrollHandler = null
      }
      if (teaser && teaser.parentNode) {
        teaser.parentNode.removeChild(teaser)
      }
      teaser = null
      teaserCloseBtn = null
      showLauncherDot(false)
      if (persist) {
        safeStorage.set(teaserStorageKey, '1')
      }
    }

    const stopAttention = () => {
      if (button.dataset.radiosoAttention) {
        delete button.dataset.radiosoAttention
      }
    }

    const markOpened = () => {
      safeStorage.set(openedStorageKey, '1')
      stopAttention()
      dismissTeaser(true)
    }

    const showTeaser = () => {
      if (teaser || isOpen || isFullscreenOpen || !teaserText) {
        return
      }
      const created = createTeaser(teaserText, theme, position)
      teaser = created.teaser
      teaserCloseBtn = created.close
      teaser.addEventListener('click', (event) => {
        if (event.target === teaserCloseBtn) {
          return
        }
        isOpen = true
        ensureIframe()
        markOpened()
        updatePanelVisibility()
      })
      teaserCloseBtn.addEventListener('click', (event) => {
        event.stopPropagation()
        dismissTeaser(true)
      })
      if (displayMode === 'panel' && shell) {
        teaser.style.position = 'fixed'
        teaser.style.bottom = '24px'
        if (position === 'bottom-left') {
          teaser.style.left = `${PANEL_HANDLE_WIDTH + 16}px`
        } else {
          teaser.style.right = `${PANEL_HANDLE_WIDTH + 16}px`
        }
        document.body.appendChild(teaser)
      } else {
        host.insertBefore(teaser, button)
      }
      showLauncherDot(true)
      teaserScrollHandler = () => dismissTeaser(true)
      window.addEventListener('scroll', teaserScrollHandler, { passive: true })
      teaserTimer = setTimeout(() => dismissTeaser(false), TEASER_AUTO_HIDE_MS)
    }

    button.addEventListener('click', () => {
      isOpen = !isOpen
      if (isOpen) {
        ensureIframe()
        markOpened()
      }
      updatePanelVisibility()
    })

    if (isOpen) {
      ensureIframe()
      markOpened()
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
    window.addEventListener('message', (event) => {
      if (event.source !== (iframe && iframe.contentWindow)) {
        return
      }
      if (event.origin !== scriptUrl.origin) {
        return
      }
      if (!event.data || typeof event.data !== 'object' || event.data.type !== TYPING_MESSAGE) {
        return
      }
      if (event.data.active) {
        button.dataset.radiosoTyping = 'true'
        if (!isOpen) {
          showLauncherDot(true)
        }
      } else {
        delete button.dataset.radiosoTyping
        if (!teaser) {
          showLauncherDot(false)
        }
      }
    })
    window.addEventListener('resize', updatePanelVisibility)
    window.visualViewport?.addEventListener('resize', updatePanelVisibility)
    window.visualViewport?.addEventListener('scroll', updatePanelVisibility)
    updatePanelVisibility()
    document.body.appendChild(host)

    if (proactiveGreetingEnabled && !teaserPreviouslyDismissed && !hasBeenOpened && !isOpen && teaserText) {
      teaserTimer = setTimeout(showTeaser, teaserDelayMs)
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }
})()
