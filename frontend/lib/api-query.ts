type QueryValue = string | number | boolean | null | undefined;

export const buildQueryString = (params: Record<string, QueryValue>): string => {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }

    searchParams.set(key, String(value));
  }

  return searchParams.toString();
};

export const withQuery = (path: string, params: Record<string, QueryValue>): string => {
  const query = buildQueryString(params);
  return query ? `${path}?${query}` : path;
};
