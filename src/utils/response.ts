// =============================================================================
// utils/response.ts
//
// WHY REWRITE:
//   Old: jsonResponse(data: any, status: number)
//        - `any` means TypeScript can't catch wrong response shapes
//        - No consistent envelope — some places return { error } some return data directly
//        - No CORS headers — preflight would fail
//
// NEW:
//   - Generic typed envelope: { success, data } | { success, error }
//   - Single source of truth for every HTTP response in the app
//   - CORS headers on every response (required for browser clients)
//   - Named helpers: ok(), created(), badRequest(), etc. — no magic status numbers
// =============================================================================

// ─── Response envelope types ──────────────────────────────────────────────────

export interface SuccessResponse<T> {
  success: true;
  data:    T;
  meta?:   ResponseMeta;
}

export interface ErrorResponse {
  success: false;
  error: {
    code:    string;
    message: string;
  };
}

export interface ResponseMeta {
  page?:    number;
  limit?:   number;
  total?:   number;
  hasMore?: boolean;
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

// ─── CORS headers ─────────────────────────────────────────────────────────────
// Applied to EVERY response so browser clients (Pages, localhost) can call the API.
// The security middleware handles the preflight OPTIONS separately.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age":       "86400",
};

// ─── Core builder ─────────────────────────────────────────────────────────────

function buildResponse<T>(
  body:    ApiResponse<T>,
  status:  number,
  extra?:  Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(extra ?? {}),
    },
  });
}

// ─── Success helpers ──────────────────────────────────────────────────────────

/** 200 OK */
export function ok<T>(data: T, meta?: ResponseMeta): Response {
  return buildResponse<T>({ success: true, data, ...(meta ? { meta } : {}) }, 200);
}

/** 201 Created */
export function created<T>(data: T): Response {
  return buildResponse<T>({ success: true, data }, 201);
}

/** 204 No Content — e.g. after DELETE */
export function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// ─── Error helpers ────────────────────────────────────────────────────────────

export function badRequest(message: string, code = "BAD_REQUEST"): Response {
  return buildResponse<never>({ success: false, error: { code, message } }, 400);
}

export function unauthorized(message = "Unauthorized"): Response {
  return buildResponse<never>(
    { success: false, error: { code: "UNAUTHORIZED", message } },
    401
  );
}

export function forbidden(message = "Forbidden"): Response {
  return buildResponse<never>(
    { success: false, error: { code: "FORBIDDEN", message } },
    403
  );
}

export function notFound(message = "Not found"): Response {
  return buildResponse<never>(
    { success: false, error: { code: "NOT_FOUND", message } },
    404
  );
}

export function conflict(message: string): Response {
  return buildResponse<never>(
    { success: false, error: { code: "CONFLICT", message } },
    409
  );
}

export function tooManyRequests(retryAfter: number): Response {
  return buildResponse<never>(
    { success: false, error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } },
    429,
    { "Retry-After": String(retryAfter) }
  );
}

export function internalError(message = "Internal server error"): Response {
  return buildResponse<never>(
    { success: false, error: { code: "INTERNAL_ERROR", message } },
    500
  );
}

/** CORS preflight response for OPTIONS requests */
export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
