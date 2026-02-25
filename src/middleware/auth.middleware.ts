// =============================================================================
// middleware/auth.middleware.ts
//   - Returns a typed AuthContext ({ userId, email, name }) on success
//   - Returns a Response on failure (same pattern — caller checks instanceof)
//   - AuthContext is the single object passed into every protected handler
//   - Validates token structure properly before trusting payload fields
// =============================================================================

import { verifyToken } from '../utils/jwt';
import { unauthorized } from '../utils/response';
import { AppError } from './error-handler';
import type { Env } from '../types/env.types';

// ─── AuthContext ───────────────────────────────────────────────────────────────
// Typed identity of the authenticated user — passed to every protected handler.
// Using a concrete type (not JWTPayload) means controllers always have
// userId as a number and can't forget to parse it.

export interface AuthContext {
	userId: number;
	email: string;
	name: string;
}

// ─── requireAuth ──────────────────────────────────────────────────────────────
// Call this at the top of every protected route handler.
// Returns AuthContext on success, Response on failure.

export async function requireAuth(request: Request, env: Env): Promise<AuthContext | Response> {
	// 1. Check the Authorization header exists and has the right scheme
	const authHeader = request.headers.get('Authorization');

	if (!authHeader) {
		return unauthorized('Authorization header is required');
	}

	if (!authHeader.startsWith('Bearer ')) {
		return unauthorized('Authorization header must use Bearer scheme');
	}

	// 2. Extract the token (everything after "Bearer ")
	const token = authHeader.slice(7).trim();

	if (!token) {
		return unauthorized('Bearer token is empty');
	}

	// 3. Verify and decode
	try {
		const payload = await verifyToken(token, env);

		// 4. Validate required fields are present in the token payload
		//    jose returns JWTPayload (all optional) — we assert what we need
		if (typeof payload.userId !== 'number' || typeof payload.email !== 'string' || typeof payload.name !== 'string') {
			throw AppError.unauthorized('Token payload is malformed');
		}

		return {
			userId: payload.userId,
			email: payload.email,
			name: payload.name,
		};
	} catch (error: unknown) {
		if (error instanceof AppError) {
			return unauthorized(error.message);
		}
		// jose throws DOMException for expired/invalid — surface a clean message
		const message = error instanceof Error ? error.message : 'Invalid token';
		return unauthorized(message.includes('expired') ? 'Token has expired' : 'Invalid token');
	}
}
