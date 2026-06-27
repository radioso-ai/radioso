(function () {
  const SCRIPT_PATH = '/radioso-embed.js'
  const DEFAULT_LABEL = 'Chat with us'
  const DEFAULT_POSITION = 'bottom-right'
  const DEFAULT_ICON = 'chat'
  const DEFAULT_DISPLAY_MODE = 'bubble'
  const DEFAULT_INITIAL_STATE = 'collapsed'
  const READY_MESSAGE = 'radioso:embed:ready'
  const SESSION_MESSAGE = 'radioso:embed:session'
  const IDENTITY_MESSAGE = 'radioso:embed:identity'
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
  const LAUNCHER_DRAG_THRESHOLD_PX = 6
  const LAUNCHER_TRAIL_MIN_INTERVAL_MS = 18
  const LAUNCHER_DRAG_VIEWPORT_MARGIN_PX = 8
  const LAUNCHER_RETURN_TRANSITION = 'transform 820ms cubic-bezier(0.22, 1.42, 0.36, 1)'
  const LAUNCHER_TRAIL_COLORS = ['#FFC720', '#FFE08A', '#F4B400']
  const LAUNCHER_RELEASE_COLORS = ['#FFC720', '#FFE08A', '#22C55E', '#38BDF8', '#A78BFA', '#FB7185', '#F97316']
  let signedIdentityToken = null
  const defaultCopy = {
    launcherDefaultLabel: 'Chat with us',
    iframeTitle: 'Radioso embedded chat',
    proactiveGreetingTeaser: 'Hi! How can I help?',
  }

  // Built-in visitor-facing translations. They live in this static, edge-cached
  // launcher (shared across every tenant, downloaded once) rather than in the
  // per-token embed-config response, so that config stays origin- and
  // Accept-Language-independent and can be served straight from a CDN. English
  // is the baseline and intentionally absent. Operator-supplied per-locale packs
  // and expert overrides still win — they're merged on top in `init`.
  const builtInLocaleCopy = {
    es: {
      launcherDefaultLabel: 'Chatea con nosotros',
      embeddedChatTitle: 'Chat embebido de Radioso',
      proactiveGreetingTeaser: '¡Hola! ¿En qué puedo ayudarte?',
      embeddedChatUnavailableTitle: 'Chat no disponible',
      embeddedChatUnavailableMessage: 'No se pudo iniciar este chat desde este sitio web.',
      embeddedChatLauncherRequiredMessage: 'Este chat debe abrirse desde el script del botón.',
      embeddedChatStartingMessage: 'Invocando a {name}...',
      publicChatEmptyTitle: 'Inicia una conversación',
      publicChatEmptyMessage: 'Haz una pregunta y obtén una respuesta con IA.',
      startPrompt: 'Haz una pregunta...',
      publicChatUnavailableTitle: 'Chat no disponible',
      publicChatUnavailableMessage:
        'Este enlace de chat ya no está activo. Contacta al administrador del espacio de trabajo para obtener acceso.',
      publicChatLoadOlderMessages: 'Cargar mensajes anteriores',
      publicChatSendMessageLabel: 'Enviar mensaje',
      publicChatContactHumanLabel: 'Hablar con una persona',
      publicChatContactHumanMessage: 'Quiero hablar con una persona.',
      publicChatNewChatLabel: 'Borrar chat',
      publicChatCollapseLabel: 'Contraer chat',
      publicChatOpenFullScreenLabel: 'Abrir en pantalla completa',
      publicChatOpenNewTabLabel: 'Abrir en una pestaña nueva',
      publicChatDisclaimerTemplate: '{name} usa IA y puede cometer errores.',
      publicChatRateLimitRetryTemplate: 'Inténtalo de nuevo en {seconds}s.',
    },
    fr: {
      launcherDefaultLabel: 'Discutez avec nous',
      embeddedChatTitle: 'Chat intégré Radioso',
      proactiveGreetingTeaser: 'Bonjour ! Comment puis-je vous aider ?',
      embeddedChatUnavailableTitle: 'Chat indisponible',
      embeddedChatUnavailableMessage: "Ce chat n'a pas pu être lancé depuis ce site web.",
      embeddedChatLauncherRequiredMessage: 'Ce chat doit être ouvert depuis le script du bouton.',
      embeddedChatStartingMessage: 'Connexion à {name}...',
      publicChatEmptyTitle: 'Commencer une conversation',
      publicChatEmptyMessage: "Posez une question et obtenez une réponse alimentée par l'IA.",
      startPrompt: 'Posez une question...',
      publicChatUnavailableTitle: 'Chat indisponible',
      publicChatUnavailableMessage:
        "Ce lien de chat n'est plus actif. Veuillez contacter l'administrateur de l'espace de travail.",
      publicChatLoadOlderMessages: 'Charger les messages précédents',
      publicChatSendMessageLabel: 'Envoyer le message',
      publicChatContactHumanLabel: 'Parler à une personne',
      publicChatContactHumanMessage: 'Je souhaite parler à une personne.',
      publicChatNewChatLabel: 'Effacer le chat',
      publicChatCollapseLabel: 'Réduire le chat',
      publicChatOpenFullScreenLabel: 'Ouvrir en plein écran',
      publicChatOpenNewTabLabel: 'Ouvrir dans un nouvel onglet',
      publicChatDisclaimerTemplate: "{name} utilise l'IA et peut faire des erreurs.",
      publicChatRateLimitRetryTemplate: 'Réessayez dans {seconds} s.',
    },
    de: {
      launcherDefaultLabel: 'Mit uns chatten',
      embeddedChatTitle: 'Eingebetteter Radioso-Chat',
      proactiveGreetingTeaser: 'Hallo! Wie kann ich helfen?',
      embeddedChatUnavailableTitle: 'Chat nicht verfügbar',
      embeddedChatUnavailableMessage: 'Dieser Chat konnte von dieser Website nicht gestartet werden.',
      embeddedChatLauncherRequiredMessage: 'Dieser Chat muss über das Schaltflächen-Skript geöffnet werden.',
      embeddedChatStartingMessage: 'Verbinde mit {name}...',
      publicChatEmptyTitle: 'Gespräch beginnen',
      publicChatEmptyMessage: 'Stellen Sie eine Frage und erhalten Sie eine KI-Antwort.',
      startPrompt: 'Frage stellen...',
      publicChatUnavailableTitle: 'Chat nicht verfügbar',
      publicChatUnavailableMessage:
        'Dieser Chat-Link ist nicht mehr aktiv. Bitte wenden Sie sich an den Arbeitsbereichsadministrator.',
      publicChatLoadOlderMessages: 'Ältere Nachrichten laden',
      publicChatSendMessageLabel: 'Nachricht senden',
      publicChatContactHumanLabel: 'Mit einem Menschen sprechen',
      publicChatContactHumanMessage: 'Ich möchte mit einem Menschen sprechen.',
      publicChatNewChatLabel: 'Chat löschen',
      publicChatCollapseLabel: 'Chat einklappen',
      publicChatOpenFullScreenLabel: 'Im Vollbild öffnen',
      publicChatOpenNewTabLabel: 'In neuem Tab öffnen',
      publicChatDisclaimerTemplate: '{name} verwendet KI und kann Fehler machen.',
      publicChatRateLimitRetryTemplate: 'Erneut versuchen in {seconds} s.',
    },
    it: {
      launcherDefaultLabel: 'Chatta con noi',
      embeddedChatTitle: 'Chat integrata Radioso',
      proactiveGreetingTeaser: 'Ciao! Come posso aiutarti?',
      embeddedChatUnavailableTitle: 'Chat non disponibile',
      embeddedChatUnavailableMessage: 'Impossibile avviare questa chat da questo sito web.',
      embeddedChatLauncherRequiredMessage: 'Questa chat deve essere aperta dallo script del pulsante.',
      embeddedChatStartingMessage: 'Connessione a {name}...',
      publicChatEmptyTitle: 'Inizia una conversazione',
      publicChatEmptyMessage: "Fai una domanda e ottieni una risposta basata sull'IA.",
      startPrompt: 'Fai una domanda...',
      publicChatUnavailableTitle: 'Chat non disponibile',
      publicChatUnavailableMessage:
        "Questo link non è più attivo. Contatta l'amministratore dello spazio di lavoro per accedere.",
      publicChatLoadOlderMessages: 'Carica messaggi precedenti',
      publicChatSendMessageLabel: 'Invia messaggio',
      publicChatContactHumanLabel: 'Parlare con una persona',
      publicChatContactHumanMessage: 'Vorrei parlare con una persona.',
      publicChatNewChatLabel: 'Cancella chat',
      publicChatCollapseLabel: 'Riduci chat',
      publicChatOpenFullScreenLabel: 'Apri a schermo intero',
      publicChatOpenNewTabLabel: 'Apri in una nuova scheda',
      publicChatDisclaimerTemplate: "{name} utilizza l'IA e può commettere errori.",
      publicChatRateLimitRetryTemplate: 'Riprova tra {seconds} s.',
    },
    pt: {
      launcherDefaultLabel: 'Fale conosco',
      embeddedChatTitle: 'Chat incorporado Radioso',
      proactiveGreetingTeaser: 'Olá! Como posso ajudar?',
      embeddedChatUnavailableTitle: 'Chat indisponível',
      embeddedChatUnavailableMessage: 'Não foi possível iniciar este chat a partir deste site.',
      embeddedChatLauncherRequiredMessage: 'Este chat deve ser aberto pelo script do botão.',
      embeddedChatStartingMessage: 'Conectando a {name}...',
      publicChatEmptyTitle: 'Iniciar uma conversa',
      publicChatEmptyMessage: 'Faça uma pergunta e receba uma resposta com IA.',
      startPrompt: 'Faça uma pergunta...',
      publicChatUnavailableTitle: 'Chat indisponível',
      publicChatUnavailableMessage:
        'Este link de chat não está mais ativo. Entre em contato com o administrador do espaço de trabalho.',
      publicChatLoadOlderMessages: 'Carregar mensagens anteriores',
      publicChatSendMessageLabel: 'Enviar mensagem',
      publicChatContactHumanLabel: 'Falar com uma pessoa',
      publicChatContactHumanMessage: 'Quero falar com uma pessoa.',
      publicChatNewChatLabel: 'Limpar chat',
      publicChatCollapseLabel: 'Recolher chat',
      publicChatOpenFullScreenLabel: 'Abrir em tela cheia',
      publicChatOpenNewTabLabel: 'Abrir em nova aba',
      publicChatDisclaimerTemplate: '{name} usa IA e pode cometer erros.',
      publicChatRateLimitRetryTemplate: 'Tente novamente em {seconds}s.',
    },
    nl: {
      launcherDefaultLabel: 'Chat met ons',
      embeddedChatTitle: 'Radioso ingesloten chat',
      proactiveGreetingTeaser: 'Hallo! Hoe kan ik helpen?',
      embeddedChatUnavailableTitle: 'Chat niet beschikbaar',
      embeddedChatUnavailableMessage: 'Deze chat kon niet worden gestart vanaf deze website.',
      embeddedChatLauncherRequiredMessage: 'Deze chat moet worden geopend via het knopscript.',
      embeddedChatStartingMessage: 'Verbinding maken met {name}...',
      publicChatEmptyTitle: 'Een gesprek starten',
      publicChatEmptyMessage: 'Stel een vraag en krijg een AI-antwoord.',
      startPrompt: 'Stel een vraag...',
      publicChatUnavailableTitle: 'Chat niet beschikbaar',
      publicChatUnavailableMessage:
        'Deze chatlink is niet meer actief. Neem contact op met de werkruimtebeheerder voor toegang.',
      publicChatLoadOlderMessages: 'Oudere berichten laden',
      publicChatSendMessageLabel: 'Bericht verzenden',
      publicChatContactHumanLabel: 'Met een medewerker praten',
      publicChatContactHumanMessage: 'Ik wil met een medewerker praten.',
      publicChatNewChatLabel: 'Chat wissen',
      publicChatCollapseLabel: 'Chat inklappen',
      publicChatOpenFullScreenLabel: 'Volledig scherm openen',
      publicChatOpenNewTabLabel: 'Openen in nieuw tabblad',
      publicChatDisclaimerTemplate: '{name} gebruikt AI en kan fouten maken.',
      publicChatRateLimitRetryTemplate: 'Probeer het opnieuw over {seconds}s.',
    },
    pl: {
      launcherDefaultLabel: 'Porozmawiaj z nami',
      embeddedChatTitle: 'Osadzony czat Radioso',
      proactiveGreetingTeaser: 'Cześć! Jak mogę pomóc?',
      embeddedChatUnavailableTitle: 'Czat niedostępny',
      embeddedChatUnavailableMessage: 'Nie można uruchomić tego czatu z tej witryny.',
      embeddedChatLauncherRequiredMessage: 'Ten czat musi zostać otwarty ze skryptu przycisku.',
      embeddedChatStartingMessage: 'Łączenie z {name}...',
      publicChatEmptyTitle: 'Rozpocznij rozmowę',
      publicChatEmptyMessage: 'Zadaj pytanie i uzyskaj odpowiedź z AI.',
      startPrompt: 'Zadaj pytanie...',
      publicChatUnavailableTitle: 'Czat niedostępny',
      publicChatUnavailableMessage:
        'Ten link do czatu nie jest już aktywny. Skontaktuj się z administratorem obszaru roboczego.',
      publicChatLoadOlderMessages: 'Załaduj starsze wiadomości',
      publicChatSendMessageLabel: 'Wyślij wiadomość',
      publicChatContactHumanLabel: 'Porozmawiaj z człowiekiem',
      publicChatContactHumanMessage: 'Chcę porozmawiać z człowiekiem.',
      publicChatNewChatLabel: 'Wyczyść czat',
      publicChatCollapseLabel: 'Zwiń czat',
      publicChatOpenFullScreenLabel: 'Otwórz na pełnym ekranie',
      publicChatOpenNewTabLabel: 'Otwórz w nowej karcie',
      publicChatDisclaimerTemplate: '{name} korzysta z AI i może popełniać błędy.',
      publicChatRateLimitRetryTemplate: 'Spróbuj ponownie za {seconds}s.',
    },
    zh: {
      launcherDefaultLabel: '与我们聊天',
      embeddedChatTitle: 'Radioso 嵌入式聊天',
      proactiveGreetingTeaser: '你好！我能帮你什么？',
      embeddedChatUnavailableTitle: '聊天不可用',
      embeddedChatUnavailableMessage: '无法从该网站启动此聊天。',
      embeddedChatLauncherRequiredMessage: '必须通过按钮脚本打开此聊天。',
      embeddedChatStartingMessage: '正在召唤 {name}...',
      publicChatEmptyTitle: '开始对话',
      publicChatEmptyMessage: '提出问题，获取 AI 答案。',
      startPrompt: '提出问题...',
      publicChatUnavailableTitle: '聊天不可用',
      publicChatUnavailableMessage: '此聊天链接已失效。请联系工作区管理员获取访问权限。',
      publicChatLoadOlderMessages: '加载更早的消息',
      publicChatSendMessageLabel: '发送消息',
      publicChatContactHumanLabel: '联系人工客服',
      publicChatContactHumanMessage: '我想联系人工客服。',
      publicChatNewChatLabel: '清除聊天',
      publicChatCollapseLabel: '收起聊天',
      publicChatOpenFullScreenLabel: '全屏打开',
      publicChatOpenNewTabLabel: '在新标签页中打开',
      publicChatDisclaimerTemplate: '{name} 使用 AI，可能会出错。',
      publicChatRateLimitRetryTemplate: '请在 {seconds} 秒后重试。',
    },
    ja: {
      launcherDefaultLabel: 'チャットでお問い合わせ',
      embeddedChatTitle: 'Radioso 埋め込みチャット',
      proactiveGreetingTeaser: 'こんにちは!どのようにお手伝いできますか?',
      embeddedChatUnavailableTitle: 'チャットを利用できません',
      embeddedChatUnavailableMessage: 'このサイトからチャットを開始できませんでした。',
      embeddedChatLauncherRequiredMessage: 'このチャットはボタンのスクリプトから開く必要があります。',
      embeddedChatStartingMessage: '{name} に接続中...',
      publicChatEmptyTitle: '会話を始める',
      publicChatEmptyMessage: '質問してAIの回答を受け取りましょう。',
      startPrompt: '質問を入力...',
      publicChatUnavailableTitle: 'チャットを利用できません',
      publicChatUnavailableMessage:
        'このチャットリンクは無効です。ワークスペース管理者にお問い合わせください。',
      publicChatLoadOlderMessages: '以前のメッセージを読み込む',
      publicChatSendMessageLabel: 'メッセージを送信',
      publicChatContactHumanLabel: '担当者に相談する',
      publicChatContactHumanMessage: '担当者に相談したいです。',
      publicChatNewChatLabel: 'チャットをクリア',
      publicChatCollapseLabel: 'チャットを閉じる',
      publicChatOpenFullScreenLabel: '全画面で開く',
      publicChatOpenNewTabLabel: '新しいタブで開く',
      publicChatDisclaimerTemplate: '{name} は AI を使用しており、間違える可能性があります。',
      publicChatRateLimitRetryTemplate: '{seconds} 秒後に再試行してください。',
    },
    ru: {
      launcherDefaultLabel: 'Напишите нам',
      embeddedChatTitle: 'Встроенный чат Radioso',
      proactiveGreetingTeaser: 'Привет! Чем могу помочь?',
      embeddedChatUnavailableTitle: 'Чат недоступен',
      embeddedChatUnavailableMessage: 'Не удалось запустить этот чат с этого сайта.',
      embeddedChatLauncherRequiredMessage: 'Этот чат должен открываться скриптом кнопки.',
      embeddedChatStartingMessage: 'Подключение к {name}...',
      publicChatEmptyTitle: 'Начать разговор',
      publicChatEmptyMessage: 'Задайте вопрос и получите ответ ИИ.',
      startPrompt: 'Задайте вопрос...',
      publicChatUnavailableTitle: 'Чат недоступен',
      publicChatUnavailableMessage:
        'Эта ссылка на чат больше не активна. Свяжитесь с администратором рабочей области для доступа.',
      publicChatLoadOlderMessages: 'Загрузить старые сообщения',
      publicChatSendMessageLabel: 'Отправить сообщение',
      publicChatContactHumanLabel: 'Поговорить с человеком',
      publicChatContactHumanMessage: 'Я хочу поговорить с человеком.',
      publicChatNewChatLabel: 'Очистить чат',
      publicChatCollapseLabel: 'Свернуть чат',
      publicChatOpenFullScreenLabel: 'Открыть во весь экран',
      publicChatOpenNewTabLabel: 'Открыть в новой вкладке',
      publicChatDisclaimerTemplate: '{name} использует ИИ и может ошибаться.',
      publicChatRateLimitRetryTemplate: 'Повторите через {seconds} с.',
    },
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
      // Expand a fixed-pixel ring via box-shadow spread rather than a transform
      // scale: scaling grew the ring proportionally to the launcher width, so a
      // long labeled pill produced a huge ripple. A px-based spread stays the
      // same visual size no matter how wide the widget is.
      '@keyframes radioso-pulse-ring { 0% { box-shadow: 0 0 0 0 var(--radioso-pulse-color, rgba(15,23,42,0.45)); } 70% { box-shadow: 0 0 0 12px rgba(15,23,42,0); } 100% { box-shadow: 0 0 0 0 rgba(15,23,42,0); } }',
      '@keyframes radioso-bounce-in { 0% { transform: scale(0.6); opacity: 0; } 60% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }',
      '@keyframes radioso-typing-ring { 0% { box-shadow: 0 0 0 0 var(--radioso-accent, rgba(15,23,42,0.55)); } 70% { box-shadow: 0 0 0 8px rgba(15,23,42,0); } 100% { box-shadow: 0 0 0 0 rgba(15,23,42,0); } }',
      '@keyframes radioso-teaser-in { 0% { transform: translateY(8px) scale(0.96); opacity: 0; } 100% { transform: translateY(0) scale(1); opacity: 1; } }',
      '@keyframes radioso-comet-square { 0% { transform: translate3d(0, 0, 0) rotate(0deg) scale(1); opacity: 0.95; } 100% { transform: translate3d(var(--radioso-tail-dx, 0), var(--radioso-tail-dy, 16px), 0) rotate(var(--radioso-tail-rotate, 90deg)) scale(0.35); opacity: 0; } }',
      '.radioso-launcher { position: relative; }',
      // !important needed because the launcher button uses inline `all: unset`,
      // which sets `animation: none` inline. Stylesheet rules normally lose to
      // inline styles unless they declare !important. (The `pulse` variant
      // below animates a ::before pseudo-element, which isn\'t affected by the
      // button\'s inline styles, so it doesn\'t need !important.)
      '.radioso-launcher[data-radioso-attention="breathe"] { animation: radioso-breathe 3.4s ease-in-out infinite !important; }',
      '.radioso-launcher[data-radioso-attention="nudge"] { animation: radioso-nudge 8s ease-in-out infinite !important; transform-origin: 50% 80%; }',
      '.radioso-launcher[data-radioso-attention="bounce-in"] { animation: radioso-bounce-in 700ms cubic-bezier(0.34, 1.56, 0.64, 1) 1 !important; }',
      '.radioso-launcher[data-radioso-attention="pulse"]::before { content: ""; position: absolute; inset: 0; border-radius: inherit; z-index: -1; animation: radioso-pulse-ring 2.2s ease-out infinite; pointer-events: none; }',
      '.radioso-launcher[data-radioso-typing="true"] .radioso-launcher-avatar { animation: radioso-typing-ring 1.4s ease-out infinite; }',
      '.radioso-launcher-dot { position: absolute; top: 9px; right: 12px; width: 10px; height: 10px; border-radius: 9999px; background: var(--radioso-dot-color, #ef4444); border: 2px solid var(--radioso-dot-border, #ffffff); opacity: 0; transform: scale(0.6); transition: opacity 180ms ease, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1); pointer-events: none; }',
      '.radioso-launcher-dot[data-visible="true"] { opacity: 1; transform: scale(1); }',
      '.radioso-teaser { position: relative; max-width: 280px; padding: 12px 14px; border-radius: 16px; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; line-height: 1.4; cursor: pointer; pointer-events: auto; opacity: 0; transform: translateY(8px) scale(0.96); transform-origin: bottom right; animation: radioso-teaser-in 280ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }',
      '.radioso-teaser[data-position="bottom-left"] { transform-origin: bottom left; }',
      '.radioso-teaser-close { position: absolute; top: 4px; right: 6px; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 9999px; background: transparent; color: inherit; opacity: 0.55; cursor: pointer; font: inherit; font-size: 14px; line-height: 1; padding: 0; }',
      '.radioso-teaser-close:hover { opacity: 1; }',
      '.radioso-comet-square { position: fixed; left: 0; top: 0; width: var(--radioso-tail-size, 8px); height: var(--radioso-tail-size, 8px); border-radius: 2px; background: #FFC720; box-shadow: 0 4px 12px rgba(255, 199, 32, 0.32); pointer-events: none; z-index: 2147483646; animation: radioso-comet-square 720ms ease-out forwards; will-change: transform, opacity; }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .radioso-launcher[data-radioso-attention] { animation: none !important; }',
      '  .radioso-launcher[data-radioso-attention="pulse"]::before { animation: none !important; opacity: 0 !important; }',
      '  .radioso-launcher[data-radioso-typing="true"] .radioso-launcher-avatar { animation: none !important; }',
      '  .radioso-teaser { animation: none !important; opacity: 1; transform: none; }',
      '  .radioso-comet-square { display: none !important; animation: none !important; }',
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

  // Pick the best built-in translation pack for this visitor. Used as the
  // lowest-priority copy layer so the widget is localized even before any
  // operator-supplied packs or overrides are applied.
  const resolveBuiltInLocaleCopy = () => resolveLocaleCopy(builtInLocaleCopy)

  const fetchEmbedConfig = async (scriptUrl, token) => {
    try {
      const response = await fetch(new URL(`/api/embed/config/${encodeURIComponent(token)}`, scriptUrl).toString(), {
        method: 'GET',
        mode: 'cors',
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
      svg.style.width = '78%'
      svg.style.height = '78%'
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
    container.style.width = isLarge ? '3rem' : '2.5rem'
    container.style.height = isLarge ? '3rem' : '2.5rem'
    container.style.overflow = 'hidden'
    container.style.borderRadius = isLarge ? '0.85rem' : '0.8rem'
    container.style.flexShrink = '0'
    container.style.background = theme.mutedBackground
    container.style.color = theme.accent
    container.style.pointerEvents = 'none'
    container.style.userSelect = 'none'
  }

  const setLauncherAvatarMarkup = (container, icon, avatarUrl) => {
    container.innerHTML = ''
    if (avatarUrl) {
      const image = document.createElement('img')
      image.alt = ''
      image.src = avatarUrl
      image.referrerPolicy = 'no-referrer'
      image.draggable = false
      image.style.width = '100%'
      image.style.height = '100%'
      image.style.objectFit = 'cover'
      image.style.display = 'block'
      image.style.userSelect = 'none'
      image.style.webkitUserDrag = 'none'
      image.addEventListener('dragstart', (event) => {
        event.preventDefault()
      })
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
    button.style.userSelect = 'none'
    button.style.touchAction = 'none'
    button.draggable = false
    button.addEventListener('dragstart', (event) => {
      event.preventDefault()
    })
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
    button.style.gap = '0.625rem'
    button.style.padding = hasVisibleLabel ? '0.4rem 0.5rem' : '0.5rem'
    button.style.borderRadius = hasVisibleLabel ? '20px' : '24px'
    button.style.cursor = 'pointer'
    button.style.background = theme.launcherBackground
    button.style.color = theme.launcherForeground
    button.style.border = `1px solid ${theme.launcherBorder}`
    button.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif'
    button.style.fontSize = '14px'
    button.style.fontWeight = '600'
    button.style.lineHeight = '1'
    button.style.boxShadow = `${theme.launcherShadow}, inset 0 1px 0 rgba(255, 255, 255, 0.18)`
    button.style.transition = `box-shadow 200ms ease, opacity 140ms ease, ${LAUNCHER_RETURN_TRANSITION}`
    button.style.userSelect = 'none'
    button.style.touchAction = 'none'
    button.style.pointerEvents = 'auto'
    button.draggable = false
    button.addEventListener('dragstart', (event) => {
      event.preventDefault()
    })
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

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const formatCssNumber = (value) => Number(value.toFixed(3))

  const getEventClientPoint = (event) => {
    if (typeof event?.clientX !== 'number' || typeof event?.clientY !== 'number') {
      return null
    }
    return { x: event.clientX, y: event.clientY }
  }

  const normalizeDragAxisBounds = (min, max) => {
    if (min <= max) {
      return { min, max }
    }

    const midpoint = (min + max) / 2
    return { min: midpoint, max: midpoint }
  }

  const getLauncherDragBounds = (button) => {
    if (typeof button.getBoundingClientRect !== 'function') {
      return null
    }

    const rect = button.getBoundingClientRect()
    if (
      !rect ||
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.right) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.bottom)
    ) {
      return null
    }

    const viewport = getViewportFrame()
    const horizontal = normalizeDragAxisBounds(
      viewport.offsetLeft + LAUNCHER_DRAG_VIEWPORT_MARGIN_PX - rect.left,
      viewport.offsetLeft + viewport.width - LAUNCHER_DRAG_VIEWPORT_MARGIN_PX - rect.right,
    )
    const vertical = normalizeDragAxisBounds(
      viewport.offsetTop + LAUNCHER_DRAG_VIEWPORT_MARGIN_PX - rect.top,
      viewport.offsetTop + viewport.height - LAUNCHER_DRAG_VIEWPORT_MARGIN_PX - rect.bottom,
    )

    return {
      minX: horizontal.min,
      maxX: horizontal.max,
      minY: vertical.min,
      maxY: vertical.max,
    }
  }

  const clampLauncherDragOffset = (offset, bounds) => {
    if (!bounds) {
      return offset
    }

    return {
      x: clamp(offset.x, bounds.minX, bounds.maxX),
      y: clamp(offset.y, bounds.minY, bounds.maxY),
    }
  }

  const createCometSquare = (point, velocity, options = {}) => {
    const square = document.createElement('span')
    const colors = options.colors || LAUNCHER_TRAIL_COLORS
    const size = (options.minSize || 5) + Math.round(Math.random() * (options.sizeRange || 7))
    const spread = options.spread || 24
    const lift = options.lift === undefined ? 16 : options.lift
    const velocityScale = options.velocityScale === undefined ? 0.72 : options.velocityScale
    const pointJitter = options.pointJitter || 0
    const driftX = clamp(-(velocity.x * velocityScale) + (Math.random() - 0.5) * spread, -96, 96)
    const driftY = clamp(-(velocity.y * velocityScale) + lift + (Math.random() - 0.5) * spread, -96, 110)
    const color = colors[Math.floor(Math.random() * colors.length)] || '#FFC720'
    const x = point.x + (Math.random() - 0.5) * pointJitter
    const y = point.y + (Math.random() - 0.5) * pointJitter

    square.className = 'radioso-comet-square'
    square.setAttribute('aria-hidden', 'true')
    square.style.left = `${x - size / 2}px`
    square.style.top = `${y - size / 2}px`
    square.style.background = color
    square.style.setProperty('--radioso-tail-size', `${size}px`)
    square.style.setProperty('--radioso-tail-dx', `${driftX}px`)
    square.style.setProperty('--radioso-tail-dy', `${driftY}px`)
    square.style.setProperty('--radioso-tail-rotate', `${Math.round(90 + Math.random() * 220)}deg`)
    document.body.appendChild(square)
    setTimeout(() => {
      if (square.parentNode) {
        square.parentNode.removeChild(square)
      }
    }, 760)
  }

  const createCometBurst = (point, velocity, options = {}) => {
    const count = options.count || 1
    for (let index = 0; index < count; index += 1) {
      createCometSquare(point, {
        x: velocity.x + (Math.random() - 0.5) * (options.velocityJitter || 0),
        y: velocity.y + (Math.random() - 0.5) * (options.velocityJitter || 0),
      }, options)
    }
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
    // Copy is layered lowest-to-highest priority: a built-in translation pack
    // matched against this visitor's languages, then the operator's per-locale
    // packs from `config.copy`, then expert overrides, then per-script overrides.
    // Built-in packs ship in this (edge-cached) launcher rather than the config
    // response so `/embed-config` stays Accept-Language-independent and cacheable.
    const copyOverrides = {
      ...resolveBuiltInLocaleCopy(),
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
    let suppressNextLauncherClick = false
    let bootstrapPromise = null
    let iframe = null
    const postIdentityToIframe = () => {
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: IDENTITY_MESSAGE, signedIdentity: signedIdentityToken }, scriptUrl.origin)
      }
    }
    window.Radioso = window.Radioso || {}
    window.Radioso.identify = (identityToken) => {
      signedIdentityToken = typeof identityToken === 'string' && identityToken.trim() ? identityToken.trim() : null
      postIdentityToIframe()
    }

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
            activeContentWindow.postMessage({ type: SESSION_MESSAGE, session, pageContext, signedIdentity: signedIdentityToken, resumed }, scriptUrl.origin)
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

    const installBubbleDragEffects = () => {
      if (displayMode !== 'bubble' || reducedMotion) {
        return
      }

      let dragState = null
      let returnTimer = null
      const returnSparkleTimers = new Set()

      const clearReturnSparkleTrail = () => {
        for (const timer of returnSparkleTimers) {
          clearTimeout(timer)
        }
        returnSparkleTimers.clear()
      }

      const addGlobalDragListeners = () => {
        window.addEventListener('pointerup', finishPointerDrag)
        window.addEventListener('pointercancel', finishPointerDrag)
        window.addEventListener('blur', finishPointerDrag)
      }

      const removeGlobalDragListeners = () => {
        window.removeEventListener('pointerup', finishPointerDrag)
        window.removeEventListener('pointercancel', finishPointerDrag)
        window.removeEventListener('blur', finishPointerDrag)
      }

      const resetLauncherTransform = () => {
        if (returnTimer) {
          clearTimeout(returnTimer)
          returnTimer = null
        }
        button.style.transition = `box-shadow 200ms ease, opacity 140ms ease, ${LAUNCHER_RETURN_TRANSITION}`
        button.style.transform = 'translate3d(0px, 0px, 0) rotate(0deg)'
        returnTimer = setTimeout(() => {
          button.style.transform = ''
          button.style.transition = `box-shadow 200ms ease, opacity 140ms ease, ${LAUNCHER_RETURN_TRANSITION}`
          button.style.willChange = ''
          returnTimer = null
        }, 840)
      }

      const startReturnSparkleTrail = (releasePoint, releaseOffset, releaseVelocity) => {
        clearReturnSparkleTrail()
        for (let index = 1; index <= 8; index += 1) {
          const timer = setTimeout(() => {
            returnSparkleTimers.delete(timer)
            const progress = index / 8
            const point = {
              x: releasePoint.x - releaseOffset.x * progress,
              y: releasePoint.y - releaseOffset.y * progress,
            }
            createCometBurst(point, {
              x: releaseVelocity.x - releaseOffset.x * 0.14,
              y: releaseVelocity.y - releaseOffset.y * 0.14,
            }, {
              colors: LAUNCHER_RELEASE_COLORS,
              count: 3,
              lift: 2,
              minSize: 4,
              pointJitter: 28,
              sizeRange: 7,
              spread: 70,
              velocityJitter: 24,
              velocityScale: 0.82,
            })
          }, index * 58)
          returnSparkleTimers.add(timer)
        }
      }

      const handlePointerDown = (event) => {
        if (isOpen || isFullscreenOpen) {
          return
        }
        if (event.button !== undefined && event.button !== 0) {
          return
        }
        if (event.isPrimary === false) {
          return
        }

        const point = getEventClientPoint(event)
        if (!point) {
          return
        }

        if (returnTimer) {
          clearTimeout(returnTimer)
          returnTimer = null
        }
        clearReturnSparkleTrail()

        dragState = {
          pointerId: event.pointerId,
          start: point,
          previous: point,
          velocity: { x: 0, y: 0 },
          offset: { x: 0, y: 0 },
          bounds: getLauncherDragBounds(button),
          lastTrailAt: 0,
          dragging: false,
        }
        button.style.transition = 'box-shadow 200ms ease, opacity 140ms ease'
        button.style.willChange = 'transform'
        button.style.cursor = 'grabbing'
        if (typeof button.setPointerCapture === 'function' && event.pointerId !== undefined) {
          button.setPointerCapture(event.pointerId)
        }
        addGlobalDragListeners()
      }

      const handlePointerMove = (event) => {
        if (!dragState || (dragState.pointerId !== undefined && event.pointerId !== dragState.pointerId)) {
          return
        }

        const point = getEventClientPoint(event)
        if (!point) {
          return
        }

        const dx = point.x - dragState.start.x
        const dy = point.y - dragState.start.y
        const distance = Math.hypot(dx, dy)
        if (distance < LAUNCHER_DRAG_THRESHOLD_PX && !dragState.dragging) {
          return
        }

        if (!dragState.dragging) {
          dragState.dragging = true
          suppressNextLauncherClick = true
          stopAttention()
          dismissTeaser(false)
        }

        event.preventDefault?.()
        const boundedOffset = clampLauncherDragOffset({ x: dx, y: dy }, dragState.bounds)
        const rotation = formatCssNumber(clamp(boundedOffset.x * 0.035, -10, 10))
        button.style.transform = `translate3d(${formatCssNumber(boundedOffset.x)}px, ${formatCssNumber(boundedOffset.y)}px, 0) rotate(${rotation}deg)`
        dragState.offset = boundedOffset
        dragState.velocity = {
          x: point.x - dragState.previous.x,
          y: point.y - dragState.previous.y,
        }

        const now = Date.now()
        if (now - dragState.lastTrailAt >= LAUNCHER_TRAIL_MIN_INTERVAL_MS) {
          createCometBurst(point, dragState.velocity, {
            count: 3,
            pointJitter: 18,
            spread: 34,
            velocityJitter: 8,
          })
          dragState.lastTrailAt = now
        }
        dragState.previous = point
      }

      const finishPointerDrag = (event) => {
        if (
          !dragState ||
          (
            dragState.pointerId !== undefined &&
            event?.pointerId !== undefined &&
            event.pointerId !== dragState.pointerId
          )
        ) {
          return
        }

        const wasDragging = dragState.dragging
        const releasePoint = getEventClientPoint(event) || dragState.previous
        const releaseVelocity = dragState.velocity
        const releaseOffset = dragState.offset
        dragState = null
        button.style.cursor = 'pointer'
        removeGlobalDragListeners()
        if (typeof button.releasePointerCapture === 'function' && event.pointerId !== undefined) {
          button.releasePointerCapture(event.pointerId)
        }
        if (wasDragging) {
          event.preventDefault?.()
          const releaseSpeed = Math.hypot(releaseVelocity.x, releaseVelocity.y)
          const releaseSquares = Math.round(clamp(releaseSpeed / 3, 14, 30))
          createCometBurst(releasePoint, releaseVelocity, {
            colors: LAUNCHER_RELEASE_COLORS,
            count: releaseSquares,
            lift: 0,
            minSize: 4,
            pointJitter: 42,
            sizeRange: 8,
            spread: 92,
            velocityJitter: 34,
            velocityScale: 1.05,
          })
          startReturnSparkleTrail(releasePoint, releaseOffset, releaseVelocity)
          resetLauncherTransform()
        } else {
          button.style.transition = `box-shadow 200ms ease, opacity 140ms ease, ${LAUNCHER_RETURN_TRANSITION}`
          button.style.willChange = ''
        }
      }

      button.addEventListener('pointerdown', handlePointerDown)
      button.addEventListener('pointermove', handlePointerMove)
      button.addEventListener('pointerup', finishPointerDrag)
      button.addEventListener('pointercancel', finishPointerDrag)
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

    installBubbleDragEffects()

    button.addEventListener('click', (event) => {
      if (suppressNextLauncherClick) {
        suppressNextLauncherClick = false
        if (event.detail !== 0) {
          event.preventDefault?.()
          return
        }
      }
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
