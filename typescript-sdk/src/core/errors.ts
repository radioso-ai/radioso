export interface RadiosoErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export class RadiosoError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(input: { code: string; message: string; status?: number; details?: unknown }) {
    super(input.message);
    this.name = "RadiosoError";
    this.code = input.code;
    this.status = input.status;
    this.details = input.details;
  }
}

const defaultMessage = (status: number): string => `Request failed with status ${status}`;

export const parseErrorResponse = async (response: Response): Promise<RadiosoError> => {
  try {
    const payload = await response.json();

    if (
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "code" in payload.error &&
      "message" in payload.error
    ) {
      const error = payload.error as RadiosoErrorShape;
      return new RadiosoError({
        code: error.code,
        message: error.message,
        status: response.status,
        details: error.details,
      });
    }

    if (
      payload &&
      typeof payload === "object" &&
      "code" in payload &&
      "message" in payload
    ) {
      const error = payload as RadiosoErrorShape;
      return new RadiosoError({
        code: error.code,
        message: error.message,
        status: response.status,
        details: error.details,
      });
    }
  } catch {
    // fall through to default error
  }

  return new RadiosoError({
    code: "HTTP_ERROR",
    message: defaultMessage(response.status),
    status: response.status,
  });
};

export const normalizeError = (error: unknown): RadiosoError => {
  if (error instanceof RadiosoError) {
    return error;
  }

  if (error instanceof Error) {
    return new RadiosoError({
      code: "REQUEST_FAILED",
      message: error.message,
    });
  }

  return new RadiosoError({
    code: "REQUEST_FAILED",
    message: "Request failed.",
    details: error,
  });
};
