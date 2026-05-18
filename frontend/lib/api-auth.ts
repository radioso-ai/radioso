import { request } from './api-client'
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
  RegisterRequest,
  RegisterResponse,
} from './api-types'

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
  },

  async requestPasswordReset(data: PasswordResetRequest): Promise<AcceptedResponse> {
    return request<AcceptedResponse>("/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify(data),
    })
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
    })
  },

  async resendEmailVerification(data: EmailVerificationResendRequest): Promise<AcceptedResponse> {
    return request<AcceptedResponse>("/auth/email-verification/resend", {
      method: "POST",
      body: JSON.stringify(data),
    })
  },

  async getInvitation(invitationToken: string): Promise<InvitationDetailsResponse> {
    return request<InvitationDetailsResponse>(`/auth/invitations/${invitationToken}`, {
      method: 'GET',
    }, { withSession: true })
  },

  async acceptInvitation(invitationToken: string, data: RegisterRequest): Promise<LoginResponse> {
    return request<LoginResponse>(`/auth/invitations/${invitationToken}/accept`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withSession: true })
  },
}
