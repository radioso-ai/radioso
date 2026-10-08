export function getApiErrorStatus(error: unknown): number | undefined {
  if (
    error
    && typeof error === 'object'
    && 'status' in error
    && typeof error.status === 'number'
  ) {
    return error.status
  }
  return undefined
}

/** The machine-readable `error.code` of an API error body, when it carries one. */
export function getApiErrorCode(error: unknown): string | undefined {
  if (
    error
    && typeof error === 'object'
    && 'error' in error
    && error.error
    && typeof error.error === 'object'
    && 'code' in error.error
    && typeof error.error.code === 'string'
  ) {
    return error.error.code
  }
  return undefined
}

/** The machine-readable `error.details` payload of an API error body, when it carries one. */
export function getApiErrorDetails(error: unknown): unknown {
  if (
    error
    && typeof error === 'object'
    && 'error' in error
    && error.error
    && typeof error.error === 'object'
    && 'details' in error.error
  ) {
    return error.error.details
  }
  return undefined
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    typeof error.error === 'string'
  ) {
    return error.error
  }

  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    return error.error.message
  }

  if (
    error &&
    typeof error === 'object' &&
    'detail' in error &&
    typeof error.detail === 'string'
  ) {
    return error.detail
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}
