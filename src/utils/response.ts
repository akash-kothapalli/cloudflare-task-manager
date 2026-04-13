// =============================================================================
// utils/response.ts
//   - Generic typed envelope: { success, data } | { success, error }
//   - Single source of truth for every HTTP response in the app
//   - Named helpers: ok(), created(), badRequest(), etc. — no magic numbers
//   - CORS headers injected per-response via security middleware, not here.
//     The CORS_HEADERS constant below is used only for the preflight helper
//     and the noContent helper where security.ts cannot wrap the response.
// =============================================================================

// ─── Response envelope types ──────────────────────────────────────────────────

export interface SuccessResponse<T> {
	success: true;
	data: T;
	meta?: ResponseMeta;
}

export interface ErrorResponse {
	success: false;
	error: {
		code: string;
		message: string;
	};
}

export interface ResponseMeta {
	page?: number;
	limit?: number;
	total?: number;
	hasMore?: boolean;
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

// ─── Core builder ─────────────────────────────────────────────────────────────
// extra: optional extra headers to merge in (e.g. Retry-After on 429)

function buildResponse<T>(body: ApiResponse<T>, status: number, extra?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
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

/** 204 No Content — used after DELETE */
export function noContent(): Response {
	return new Response(null, { status: 204 });
}

// ─── Error helpers ────────────────────────────────────────────────────────────

export function badRequest(message: string, code = 'BAD_REQUEST'): Response {
	return buildResponse<never>({ success: false, error: { code, message } }, 400);
}

export function unauthorized(message = 'Unauthorized'): Response {
	return buildResponse<never>({ success: false, error: { code: 'UNAUTHORIZED', message } }, 401);
}

export function forbidden(message = 'Forbidden'): Response {
	return buildResponse<never>({ success: false, error: { code: 'FORBIDDEN', message } }, 403);
}

export function notFound(message = 'Not found'): Response {
	return buildResponse<never>({ success: false, error: { code: 'NOT_FOUND', message } }, 404);
}

export function conflict(message: string): Response {
	return buildResponse<never>({ success: false, error: { code: 'CONFLICT', message } }, 409);
}

/** 429 Too Many Requests
 *  retryAfter: seconds until the client may retry (RFC 6585 Retry-After header)
 */
export function tooManyRequests(retryAfter: number): Response {
	return buildResponse<never>(
		{ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
		429,
		{ 'Retry-After': String(retryAfter) },  // RFC 6585 — tells client when to retry
	);
}

export function internalError(message = 'Internal server error'): Response {
	return buildResponse<never>({ success: false, error: { code: 'INTERNAL_ERROR', message } }, 500);
}

/** CORS preflight response for OPTIONS requests.
 *  origin: the request's Origin header — echoed back only if it's in the allowlist.
 *  The allowlist check happens in security.ts getCorsHeaders().
 */
export function preflight(origin = ''): Response {
	// Import here would cause a circular dep — inline the CORS logic for preflight only.
	// The real CORS allowlist lives in security.ts. This helper just provides the
	// correct shape; security.ts calls preflight(origin) and injects the right headers.
	return new Response(null, {
		status: 204,
		headers: {
			// Temporarily permissive — security.ts wraps this in addSecurityHeaders
			// which will overwrite with the allowlist-checked value via getCorsHeaders.
			// Preflight responses are wrapped by addSecurityHeaders in index.ts.
			'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization',
			'Access-Control-Max-Age': '86400',
		},
	});
}
