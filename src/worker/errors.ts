import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function logFailure(event: string, error: unknown) {
  console.error(JSON.stringify({
    event,
    code: error instanceof ApiError ? error.code : 'unexpected_error',
  }))
}
