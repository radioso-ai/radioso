const extractCookies = (headers) => {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const fallback = headers.get("set-cookie");
  return fallback ? [fallback] : [];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createSessionClient = ({ baseUrl, fetchImpl = fetch }) => {
  const jar = new Map();

  const applySetCookie = (headers) => {
    for (const cookie of extractCookies(headers)) {
      const first = cookie.split(";", 1)[0];
      const separatorIndex = first.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }
      jar.set(first.slice(0, separatorIndex), first.slice(separatorIndex + 1));
    }
  };

  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

  const request = async (pathname, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (jar.size > 0) {
      headers.set("Cookie", cookieHeader());
    }
    if (init.json !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetchImpl(new URL(pathname, baseUrl), {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
    applySetCookie(response.headers);

    let body = null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    if (!response.ok) {
      const error = new Error(
        typeof body === "string"
          ? body
          : body?.error?.message ?? body?.message ?? `HTTP ${response.status}`,
      );
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return { status: response.status, body, headers: response.headers };
  };

  return {
    request,
    sleep,
  };
};

export const ensureBenchmarkWorkspace = async ({
  client,
  email,
  password,
  workspaceId,
  provisionAccount = false,
  organizationName = "Performance Benchmark",
}) => {
  if (!email || !password) {
    throw new Error("Authenticated benchmark profiles require --email and --password.");
  }

  try {
    const login = await client.request("/api/v1/auth/login", {
      method: "POST",
      json: {
        email,
        password,
        ...(workspaceId ? { preferredWorkspaceId: workspaceId } : {}),
      },
    });

    return login.body;
  } catch (error) {
    if (!provisionAccount) {
      throw error;
    }
  }

  const registration = await client.request("/api/v1/auth/register", {
    method: "POST",
    json: {
      email,
      password,
      organizationName,
    },
  });

  return registration.body;
};

export const ensureAnonymousChatEnabled = async ({ client, workspaceId }) => {
  const headers = { "X-Workspace-Id": workspaceId };
  const current = await client.request("/api/v1/settings/general", {
    method: "GET",
    headers,
  });

  if (current.body?.anonymousChatEnabled && current.body?.anonymousChatUrl) {
    return current.body.anonymousChatUrl;
  }

  const updated = await client.request("/api/v1/settings/general", {
    method: "PUT",
    headers,
    json: {
      anonymousChatEnabled: true,
      anonymousRateLimit: current.body?.anonymousRateLimit ?? 30,
    },
  });

  if (!updated.body?.anonymousChatUrl) {
    throw new Error("Anonymous chat is enabled but no public chat URL was returned.");
  }

  return updated.body.anonymousChatUrl;
};
