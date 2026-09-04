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
  getGoogleLoginStartUrl(returnTo?: string): string {
    const target = normalizeSameOriginReturnPath(returnTo)
    if (!target) {
      return `${API_BASE}/ee/auth/google/start`
    }
    return `${API_BASE}/ee/auth/google/start?return_to=${encodeURIComponent(target)}`
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
}
