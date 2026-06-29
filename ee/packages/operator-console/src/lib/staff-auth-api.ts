// Frontend calls reach the backend through the Next proxy at /backend
// (see frontend app/backend/[...path]/route.ts and api-client API_BASE),
// not the bare /api path. Using /api here 404s in the real app.
export const operatorConsoleApiBase = "/backend/api/v1/ee/operator-console";

export type StaffRole = "support_read" | "billing_write" | "owner";
export type StaffStatus = "active" | "disabled";

export interface StaffUser {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  status: StaffStatus;
  lastLoginAt: string | null;
}

export interface UsageLimitProfile {
  key: string;
  displayName: string;
  monthlyAnswerLimit: number | null;
  storedDocumentLimit: number | null;
  storedIndexedByteLimit: number | null;
  monthlyIndexedByteLimit: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MeterUsage {
  used: number;
  limit: number | null;
  periodStart?: string;
  resetAt?: string;
}

export interface AccountUsageSummary {
  accountId: string;
  profile: UsageLimitProfile | null;
  monthlyAnswers: MeterUsage;
  storedDocuments: MeterUsage;
  storedIndexedBytes: MeterUsage;
  monthlyIndexedBytes: MeterUsage;
}

export interface OrganizationDirectoryRow {
  accountId: string;
  name: string;
  ownerEmail: string | null;
  ownerCount: number;
  profileKey: string | null;
  profileDisplayName: string | null;
  monthlyAnswers: {
    used: number;
    limit: number | null;
  };
}

export interface OrganizationDirectoryPage {
  rows: OrganizationDirectoryRow[];
  pageInfo: {
    limit: number;
    offset: number;
    nextOffset: number | null;
    hasMore: boolean;
    total: number;
  };
}

export interface TierPayload {
  displayName: string;
  monthlyAnswerLimit: number | null;
  storedDocumentLimit: number | null;
  storedIndexedByteLimit?: number | null;
  monthlyIndexedByteLimit?: number | null;
}

export interface StaffCreatePayload {
  email: string;
  name: string;
  role: StaffRole;
  password: string;
}

export class StaffApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, options: { status: number; code?: string | null }) {
    super(message);
    this.name = "StaffApiError";
    this.status = options.status;
    this.code = options.code ?? null;
  }
}

const parseErrorBody = async (response: Response): Promise<{ message: string; code: string | null }> => {
  try {
    const body = await response.json() as { error?: { message?: string; code?: string } };
    return {
      message: body.error?.message ?? `Request failed with status ${response.status}`,
      code: body.error?.code ?? null,
    };
  } catch {
    return {
      message: `Request failed with status ${response.status}`,
      code: null,
    };
  }
};

export const operatorFetch = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  const hasBody = init.body !== undefined && init.body !== null;
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${operatorConsoleApiBase}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const error = await parseErrorBody(response);
    throw new StaffApiError(error.message, { status: response.status, code: error.code });
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
};

export const staffAuthApi = {
  login: (input: { email: string; password: string }) =>
    operatorFetch<{ staff: StaffUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  logout: () =>
    operatorFetch<void>("/auth/logout", { method: "POST" }),
  me: () =>
    operatorFetch<{ staff: StaffUser }>("/auth/me"),
  listOrganizations: (input: { limit?: number; offset?: number; search?: string } = {}) => {
    const params = new URLSearchParams();
    if (input.limit !== undefined) {
      params.set("limit", String(input.limit));
    }
    if (input.offset !== undefined) {
      params.set("offset", String(input.offset));
    }
    if (input.search?.trim()) {
      params.set("search", input.search.trim());
    }
    const query = params.toString();
    return operatorFetch<OrganizationDirectoryPage>(`/organizations${query ? `?${query}` : ""}`);
  },
  getOrganizationUsage: (accountId: string) =>
    operatorFetch<AccountUsageSummary>(`/organizations/${encodeURIComponent(accountId)}/usage`),
  changeOrganizationTier: (accountId: string, profileKey: string | null) =>
    operatorFetch<AccountUsageSummary>(`/organizations/${encodeURIComponent(accountId)}/tier`, {
      method: "PUT",
      body: JSON.stringify({ profileKey }),
    }),
  listTiers: () =>
    operatorFetch<{ tiers: UsageLimitProfile[] }>("/tiers"),
  upsertTier: (profileKey: string, payload: TierPayload) =>
    operatorFetch<{ profile: UsageLimitProfile }>(`/tiers/${encodeURIComponent(profileKey)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  listStaff: () =>
    operatorFetch<{ staff: StaffUser[] }>("/staff"),
  createStaff: (payload: StaffCreatePayload) =>
    operatorFetch<{ staff: StaffUser }>("/staff", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  setStaffRole: (staffId: string, role: StaffRole) =>
    operatorFetch<{ staff: StaffUser }>(`/staff/${encodeURIComponent(staffId)}/role`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  setStaffStatus: (staffId: string, status: StaffStatus) =>
    operatorFetch<{ staff: StaffUser }>(`/staff/${encodeURIComponent(staffId)}/status`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    }),
};

export const canWriteTiers = (role: StaffRole): boolean =>
  role === "billing_write" || role === "owner";

export const canManageStaff = (role: StaffRole): boolean =>
  role === "owner";
