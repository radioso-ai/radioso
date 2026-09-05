import { API_BASE, request } from './api-client'
import { normalizeSameOriginReturnPath } from './auth-return-url'
import type {
  AcceptedResponse,
  EmailVerificationResendRequest,
  EmailVerificationVerifyRequest,
  EmailVerificationVerifyResponse,
  InvitationDetailsResponse,
  LoginRequest,
  LoginResponse,
  PasswordResetConfirmRequest,
  PasswordResetConfirmResponse,
  PasswordResetRequest,
  RegistrationAvailabilityResponse,
  SessionResponse,
  RegisterRequest,
  RegisterResponse,
} from './api-types'

export const authApi = {
  async getRegistrationAvailability(): Promise<RegistrationAvailabilityResponse> {
    return request<RegistrationAvailabilityResponse>('/auth/registration', {
      method: 'GET',
    }, { withSession: false })
  },

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
  },

  // Federated (Google) sign-in is an Enterprise Edition capability. The probe
  // returns `{ enabled: false }` whenever the EE module is absent (404) or the
  // provider is unconfigured, so the OSS login UI degrades cleanly.
  // Recovers the signed-in identity from the session cookie. Returns null when
  // there is no live session, which is the normal case for a first-time
  // visitor, so callers treat it as "signed out" rather than an error.
  async getCurrentSession(): Promise<SessionResponse | null> {
    try {
      return await request<SessionResponse>('/auth/session', { method: 'GET' }, { withSession: true })
    } catch {
      return null
    }
  },

  async getGoogleLoginStatus(): Promise<{ enabled: boolean }> {
    try {
      return await request<{ enabled: boolean }>("/ee/auth/google/status", {
        method: "GET",
      }, { withSession: false })
    } catch {
      return { enabled: false }
    }
  },

  // Full-page navigation target that begins the Google OAuth redirect dance.
  // Same-origin via the `/backend` proxy so the session cookie lands on the app.
  // `returnTo` sends the browser back to where it started instead of the
  // default landing page; `loginHint` preselects an address in the chooser.
  getGoogleLoginStartUrl(options: { returnTo?: string; loginHint?: string } = {}): string {
    const query = new URLSearchParams()
    const returnTo = normalizeSameOriginReturnPath(options.returnTo)
    if (returnTo) {
      query.set('returnTo', returnTo)
    }
    if (options.loginHint) {
      query.set('loginHint', options.loginHint)
    }
    const search = query.toString()
    return `${API_BASE}/ee/auth/google/start${search ? `?${search}` : ''}`
  },

  async requestPasswordReset(data: PasswordResetRequest): Promise<AcceptedResponse> {
    return request<AcceptedResponse>("/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withSession: false })
  },

  async confirmPasswordReset(data: PasswordResetConfirmRequest): Promise<PasswordResetConfirmResponse> {
    return request<PasswordResetConfirmResponse>("/auth/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async verifyEmail(data: EmailVerificationVerifyRequest): Promise<EmailVerificationVerifyResponse> {
    return request<EmailVerificationVerifyResponse>("/auth/email-verification/verify", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withSession: false })
  },

  async resendEmailVerification(data: EmailVerificationResendRequest): Promise<AcceptedResponse> {
    return request<AcceptedResponse>("/auth/email-verification/resend", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withSession: false })
  },

  async getInvitation(invitationToken: string): Promise<InvitationDetailsResponse> {
    return request<InvitationDetailsResponse>(`/auth/invitations/${invitationToken}`, {
      method: 'GET',
    }, { withSession: false })
  },

  async acceptInvitation(invitationToken: string, data: RegisterRequest): Promise<LoginResponse> {
    return request<LoginResponse>(`/auth/invitations/${invitationToken}/accept`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  // Accepts on the strength of the existing session cookie, so no password is
  // collected. The only path in for a federated login, which has none.
  async acceptInvitationAsCurrentUser(invitationToken: string): Promise<LoginResponse> {
    return request<LoginResponse>(`/auth/invitations/${invitationToken}/accept-as-current-user`, {
      method: 'POST',
    }, { withSession: true })
  },
}
