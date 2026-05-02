/**
 * Wire envelope shared by every daemon HTTP response.
 *
 * Why a uniform envelope: the cockpit's fetchFromDaemon helper inspects
 * `ok` and either returns `data` or throws a DaemonError carrying
 * `error.code` + `error.message`. Keeping these types in one place lets
 * the route modules and the chats-flow code in index.ts stay aligned
 * without each importing fastify or redefining the shape inline.
 */
export interface ErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    /**
     * Optional structured payload. Used today for zod-issue lists from
     * /templates POST (`{issues: [{path, message}, ...]}`) so the cockpit
     * can pin each error to the field it references. Kept loose so future
     * routes can attach their own structured detail without changing the
     * envelope shape.
     */
    details?: Record<string, unknown>;
  };
}

export interface SuccessResponse<T> {
  ok: true;
  data: T;
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

export function errorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  return {
    ok: false,
    error: details ? { code, message, details } : { code, message },
  };
}

export function successResponse<T>(data: T): SuccessResponse<T> {
  return {
    ok: true,
    data,
  };
}
