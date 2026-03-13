const API_BASE = `${process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/backend/api/v1"}`;
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

export interface ChatResponse {
  conversationId: string
  answer: string
  citations?: Citation[]
}

export interface ErrorResponse {
  error: {
    code: string
    message: string
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
  }
}
