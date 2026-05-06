export interface EnterprisePasswordResetRequest {
  email: string;
}

export interface EnterpriseAcceptedResponse {
  accepted: true;
}

export interface EnterprisePasswordResetConfirmRequest {
  token: string;
  password: string;
}

export interface EnterprisePasswordResetConfirmResponse {
  userId: string;
  accountId: string;
  email: string;
  organizationName: string;
  workspaceId: string;
  workspaceName: string;
  workspacePublicRouteKey: string;
}

export interface EnterpriseEmailVerificationVerifyRequest {
  token: string;
}

export interface EnterpriseEmailVerificationVerifyResponse {
  verified: true;
}

const readErrorBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return {
      error: {
        message: `Request failed with status ${response.status}`,
      },
    };
  }
};

const request = async <TResponse>(
  path: string,
  init: RequestInit,
): Promise<TResponse> => {
  const response = await fetch(`/backend/api/v1/ee/auth${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw await readErrorBody(response);
  }

  return response.json() as Promise<TResponse>;
};

export const enterpriseAuthApi = {
  requestPasswordReset(input: EnterprisePasswordResetRequest): Promise<EnterpriseAcceptedResponse> {
    return request("/password-reset/request", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  confirmPasswordReset(
    input: EnterprisePasswordResetConfirmRequest,
  ): Promise<EnterprisePasswordResetConfirmResponse> {
    return request("/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  verifyEmail(
    input: EnterpriseEmailVerificationVerifyRequest,
  ): Promise<EnterpriseEmailVerificationVerifyResponse> {
    return request("/email-verification/verify", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
};
