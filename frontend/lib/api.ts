const API_BASE = `${process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/backend/api/v1"}`;
const STREAMING_API_PATH = '/api/chat/stream'
const API_TOKEN_STORAGE_KEY = "hivec.apiToken";

const getStoredApiToken = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem(API_TOKEN_STORAGE_KEY);
};

const setStoredApiToken = (token: string | null) => {
  if (typeof window === "undefined") {
    return;
  }

  if (token) {
    window.localStorage.setItem(API_TOKEN_STORAGE_KEY, token);
    return;
  }

  window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
};

const buildError = async (response: Response): Promise<ErrorResponse> => {
  try {
    return await response.json();
  } catch {
    return {
      error: {
        code: "HTTP_ERROR",
        message: `Request failed with status ${response.status}`,
      },
    };
  }
};

const request = async <T>(
  path: string,
  init: RequestInit = {},
  options: { withSession?: boolean; withApiToken?: boolean } = {},
): Promise<T> => {
  const headers = new Headers(init.headers);

  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }

  if (options.withApiToken) {
    const token = getStoredApiToken();

    if (!token) {
      throw {
        error: {
          code: "UNAUTHORIZED",
          message: "Sign in again to continue.",
        },
      } satisfies ErrorResponse;
    }

    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers,
    credentials: options.withSession ? "include" : init.credentials,
  });

  if (!response.ok) {
    throw await buildError(response);
  }

  return response.json() as Promise<T>;
};

// Types based on OpenAPI schema
export interface RegisterRequest {
  email: string
  password: string
}

export interface RegisterResponse {
  userId: string
}

export interface LoginRequest {
  email: string
  password: string
}

export interface LoginResponse {
  userId: string
}

export interface AccountTokenResponse {
  token: string
}

export interface RetrievalSettings {
  queryRewriteEnabled: boolean
  rerankEnabled: boolean
  vectorTopK: number
  similarityThreshold: number
  rerankTopK: number
  warmthLevel: number
  citationDisplayEnabled: boolean
}

export interface DocumentCreateRequest {
  title: string
  content: string
}

export interface DocumentCreateResponse {
  documentId: string
  status: 'received' | 'normalized' | 'chunked' | 'embedded' | 'ready'
}

export interface DocumentSummary {
  id: string
  title: string
  status: string
  ragStatus: 'processed' | 'pending'
  createdAt: string
  updatedAt: string
}

export interface DocumentDetails extends DocumentSummary {
  content: string
}

export interface DocumentListResponse {
  documents: DocumentSummary[]
}

export interface ChatRequest {
  query: string
  stream: boolean
  conversationId?: string
}

export interface Citation {
  documentId: string
  chunkId: string
  title?: string
}

export interface AnswerSegment {
  text: string
  citationIndices?: number[]
}

export interface ChatResponse {
  conversationId: string
  answer: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
}

export interface ChatStreamConversation {
  conversationId: string
}

export interface ChatStreamChunk {
  text: string
}

export interface ChatStreamCompletion {
  conversationId?: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
}

interface ChatStreamHandlers {
  onConversation?: (payload: ChatStreamConversation) => void
  onChunk?: (payload: ChatStreamChunk) => void
  onDone?: (payload: ChatStreamCompletion) => void
}

export interface ErrorResponse {
  error: {
    code: string
    message: string
  }
}

const requireApiToken = () => {
  const token = getStoredApiToken()

  if (!token) {
    throw {
      error: {
        code: "UNAUTHORIZED",
        message: "Sign in again to continue.",
      },
    } satisfies ErrorResponse
  }

  return token
}

const parseSseEvent = (rawEvent: string) => {
  const normalized = rawEvent.replaceAll('\r', '')
  const lines = normalized.split('\n')
  let eventName = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      continue
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }

  return {
    eventName,
    data: dataLines.join('\n'),
  }
}

const streamChatEvents = async (
  response: Response,
  handlers: ChatStreamHandlers,
): Promise<ChatResponse> => {
  if (!response.body) {
    throw new Error('Streaming response body was unavailable.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  let conversationId = ''
  let citations: Citation[] | undefined
  let answerSegments: AnswerSegment[] | undefined

  const flushEvent = (rawEvent: string) => {
    if (!rawEvent.trim()) {
      return
    }

    const { eventName, data } = parseSseEvent(rawEvent)

    if (!data) {
      return
    }

    if (eventName === 'conversation') {
      const payload = JSON.parse(data) as ChatStreamConversation
      conversationId = payload.conversationId
      handlers.onConversation?.(payload)
      return
    }

    if (eventName === 'chunk') {
      const payload = JSON.parse(data) as ChatStreamChunk
      answer = `${answer}${payload.text}`
      handlers.onChunk?.(payload)
      return
    }

    if (eventName === 'done') {
      const payload = JSON.parse(data) as { citations?: Citation[]; answerSegments?: AnswerSegment[] }
      citations = payload.citations
      answerSegments = payload.answerSegments
      handlers.onDone?.({
        conversationId,
        citations,
        answerSegments,
      })
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

    let delimiterIndex = buffer.indexOf('\n\n')

    while (delimiterIndex !== -1) {
      flushEvent(buffer.slice(0, delimiterIndex))
      buffer = buffer.slice(delimiterIndex + 2)
      delimiterIndex = buffer.indexOf('\n\n')
    }

    if (done) {
      break
    }
  }

  if (buffer.trim()) {
    flushEvent(buffer)
  }

  return {
    conversationId,
    answer,
    citations,
    answerSegments,
  }
}

// Auth API
export const authApi = {
  async register(data: RegisterRequest): Promise<RegisterResponse> {
    return request<RegisterResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async login(data: LoginRequest): Promise<LoginResponse> {
    return request<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withSession: true })
  }
}

// Account API
export const accountApi = {
  async getToken(): Promise<AccountTokenResponse> {
    const response = await request<AccountTokenResponse>("/account/token", {
      method: "GET",
    }, { withSession: true })
    setStoredApiToken(response.token)
    return response
  },

  clearToken() {
    setStoredApiToken(null)
  },
}

// Settings API
export const settingsApi = {
  async getRetrievalSettings(): Promise<RetrievalSettings> {
    return request<RetrievalSettings>("/settings/retrieval", {
      method: "GET",
    }, { withApiToken: true })
  },

  async updateRetrievalSettings(data: RetrievalSettings): Promise<RetrievalSettings> {
    return request<RetrievalSettings>("/settings/retrieval", {
      method: "PUT",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  }
}

// Documents API
export const documentsApi = {
  async createDocument(data: DocumentCreateRequest): Promise<DocumentCreateResponse> {
    return request<DocumentCreateResponse>("/document/", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async getDocument(documentId: string): Promise<DocumentDetails> {
    return request<DocumentDetails>(`/document/${documentId}`, {
      method: "GET",
    }, { withApiToken: true })
  },

  async listDocuments(): Promise<DocumentSummary[]> {
    const response = await request<DocumentListResponse>("/document/", {
      method: "GET",
    }, { withApiToken: true })
    return response.documents
  },

  async updateDocument(documentId: string, data: DocumentCreateRequest): Promise<DocumentCreateResponse> {
    return request<DocumentCreateResponse>(`/document/${documentId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  }
}

// Chat API
export const chatApi = {
  async createChatResponse(data: ChatRequest): Promise<ChatResponse> {
    return request<ChatResponse>("/chat/", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async streamChatResponse(
    data: ChatRequest,
    handlers: ChatStreamHandlers = {},
  ): Promise<ChatResponse> {
    const response = await fetch(STREAMING_API_PATH, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${requireApiToken()}`,
      },
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    const contentType = response.headers.get("content-type") ?? ""

    if (!contentType.includes("text/event-stream")) {
      const payload = (await response.json()) as ChatResponse
      handlers.onConversation?.({ conversationId: payload.conversationId })
      if (payload.answer) {
        handlers.onChunk?.({ text: payload.answer })
      }
      handlers.onDone?.({
        conversationId: payload.conversationId,
        citations: payload.citations,
        answerSegments: payload.answerSegments,
      })
      return payload
    }

    return streamChatEvents(response, handlers)
  },
}
