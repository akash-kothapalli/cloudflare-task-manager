// =============================================================================
// middleware/error-handler.ts
//   - AppError class: typed errors with HTTP status + code, thrown anywhere
//     in the app and handled here consistently
//   - No `any` — error is narrowed properly
//   - Structured JSON log so wrangler tail output is parseable
//   - Stack traces logged in development, hidden from client always
// =============================================================================

import { internalError, badRequest, conflict, notFound, unauthorized, forbidden } from '../utils/response';

// ─── AppError ──────────────────────────────────────────────────────────────────
// Throw this anywhere in the app instead of { status, message } plain objects.
// The handler below knows how to convert it to the right HTTP response.

export class AppError extends Error {
	constructor(
		public readonly statusCode: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'AppError';
	}

	// ── Convenience factories ────────────────────────────────────────────────────
	static badRequest(message: string): AppError {
		return new AppError(400, 'BAD_REQUEST', message);
	}
	static unauthorized(message = 'Unauthorized'): AppError {
		return new AppError(401, 'UNAUTHORIZED', message);
	}
	static forbidden(message = 'Forbidden'): AppError {
		return new AppError(403, 'FORBIDDEN', message);
	}
	static notFound(message = 'Not found'): AppError {
		return new AppError(404, 'NOT_FOUND', message);
	}
	static conflict(message: string): AppError {
		return new AppError(409, 'CONFLICT', message);
	}
	static internal(message = 'Internal server error'): AppError {
		return new AppError(500, 'INTERNAL_ERROR', message);
	}
}

// ─── Global error boundary ────────────────────────────────────────────────────

export async function withErrorHandling(handler: () => Promise<Response>): Promise<Response> {
	try {
		return await handler();
	} catch (error: unknown) {
		// ── Known app errors ──────────────────────────────────────────────────────
		if (error instanceof AppError) {
			// Log at warn level — these are expected errors (400, 401, 404…)
			console.warn(
				JSON.stringify({
					level: 'warn',
					code: error.code,
					status: error.statusCode,
					message: error.message,
				}),
			);

			// Map to the correct response helper
			switch (error.statusCode) {
				case 400:
					return badRequest(error.message, error.code);
				case 401:
					return unauthorized(error.message);
				case 403:
					return forbidden(error.message);
				case 404:
					return notFound(error.message);
				case 409:
					return conflict(error.message);
				default:
					return internalError(error.message);
			}
		}

		// ── Legacy plain-object throws { status, message } ────────────────────────
		// Keep supporting these while we migrate — won't be needed after full rewrite
		if (typeof error === 'object' && error !== null && 'status' in error && 'message' in error) {
			const e = error as { status: number; message: string };
			console.warn(JSON.stringify({ level: 'warn', status: e.status, message: e.message }));
			switch (e.status) {
				case 400:
					return badRequest(e.message);
				case 401:
					return unauthorized(e.message);
				case 403:
					return forbidden(e.message);
				case 404:
					return notFound(e.message);
				case 409:
					return conflict(e.message);
				default:
					return internalError(e.message);
			}
		}

		// ── Unexpected errors ──────────────────────────────────────────────────────
		// Log full stack at error level, but never expose internals to client
		const message = error instanceof Error ? error.message : 'Unknown error';
		const stack = error instanceof Error ? error.stack : undefined;

		console.error(
			JSON.stringify({
				level: 'error',
				message,
				stack,
			}),
		);

		return internalError();
	}
}
