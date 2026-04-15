// =============================================================================
// controllers/auth.controller.ts
//
//   Each controller does exactly three things:
//     1. Parse + validate the request body
//     2. Call one service function
//     3. Return a typed Response using helpers from utils/response.ts
//
//   	— logoutController added:
//     POST /auth/logout accepts { refreshToken } in body OR the HttpOnly cookie.
//     Calls logoutUser() which deletes the jti from KV — token is permanently dead.
//     Always returns 200 even if token is already invalid (idempotent logout).
// =============================================================================

import {
	registerUser,
	loginUser,
	getProfile,
	verifyOtpAndLogin,
	resendOtp,
	forgotPassword,
	resetPassword,
	refreshAccessToken,
	logoutUser,
} from '../services/auth.service';
import { validateRegisterInput, validateLoginInput } from '../utils/validation';
import { ok, created, badRequest, noContent } from '../utils/response';
import type { AuthContext } from '../middleware/auth.middleware';
import type { Env } from '../types/env.types';

// ─── HttpOnly cookie helpers ──────────────────────────────────────────────────
// The refresh token is stored in an HttpOnly cookie on browser clients.
// HttpOnly = JavaScript cannot read it → XSS cannot steal the refresh token.
// SameSite=None; Secure = required for cross-origin requests (Cloudflare Workers
// frontend and API share the same origin so this is belt-and-suspenders).
//
// Path=/auth — cookie is only sent on requests to /auth/* routes, not on every
// single API call, reducing exposure.

const REFRESH_COOKIE_OPTIONS = `HttpOnly; Secure; SameSite=None; Path=/auth; Max-Age=${7 * 24 * 3600}`;

function withRefreshCookie(response: Response, refreshToken: string): Response {
	const headers = new Headers(response.headers);
	headers.set('Set-Cookie', `refresh_token=${refreshToken}; ${REFRESH_COOKIE_OPTIONS}`);
	return new Response(response.body, { status: response.status, headers });
}

// Clears the refresh cookie on logout — browser deletes it immediately.
function clearRefreshCookie(response: Response): Response {
	const headers = new Headers(response.headers);
	// Max-Age=0 tells the browser to delete the cookie immediately
	headers.set('Set-Cookie', `refresh_token=; HttpOnly; Secure; SameSite=None; Path=/auth; Max-Age=0`);
	return new Response(response.body, { status: response.status, headers });
}

// Extracts refresh token from HttpOnly cookie OR request body.
// Cookie takes priority (browser clients). Body fallback for API/mobile clients.
async function extractRefreshToken(request: Request): Promise<string | null> {
	// Try cookie first
	const cookieHeader = request.headers.get('Cookie') ?? '';
	const match = cookieHeader.match(/(?:^|;\s*)refresh_token=([^;]+)/);
	if (match?.[1]) return match[1];

	// Fallback: JSON body
	try {
		const b = await request.clone().json() as Record<string, unknown>;
		if (typeof b.refreshToken === 'string' && b.refreshToken) return b.refreshToken;
	} catch { /* no body or not JSON */ }

	return null;
}

// ─── POST /auth/register ──────────────────────────────────────────────────────

export async function registerController(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }

	const validation = validateRegisterInput(body);
	if (!validation.ok) return badRequest(validation.error);

	const result = await registerUser(env.DB, env, validation.value);
	return created(result);
}

// ─── POST /auth/verify-otp ────────────────────────────────────────────────────

export async function verifyOtpController(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }

	if (typeof body !== 'object' || body === null) return badRequest('Request body must be a JSON object');
	const b = body as Record<string, unknown>;

	if (typeof b.email !== 'string' || !b.email.trim()) return badRequest('email is required');
	if (typeof b.otp   !== 'string' || !b.otp.trim())   return badRequest('otp is required');
	if (!/^\d{6}$/.test(b.otp.trim()))                  return badRequest('otp must be a 6-digit code');

	const result = await verifyOtpAndLogin(env.DB, env, b.email.trim().toLowerCase(), b.otp.trim());
	return withRefreshCookie(ok(result), result.refreshToken);
}

// ─── POST /auth/login ─────────────────────────────────────────────────────────

export async function loginController(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }

	const validation = validateLoginInput(body);
	if (!validation.ok) return badRequest(validation.error);

	const result = await loginUser(env.DB, env, validation.value);
	return withRefreshCookie(ok(result), result.refreshToken);
}

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

export async function refreshController(request: Request, env: Env): Promise<Response> {
	const refreshToken = await extractRefreshToken(request);

	if (!refreshToken) {
		return badRequest('Refresh token required');
	}

	const tokens = await refreshAccessToken(env, refreshToken);
	return withRefreshCookie(ok(tokens), tokens.refreshToken);
}

// ─── POST /auth/logout ────────────────────────────────────────────────────────
//
// Accepts refresh token from HttpOnly cookie OR { refreshToken } body.
// Calls logoutUser() → deletes jti from KV → token permanently dead.
// Always returns 200 — logout is idempotent (already-invalid token = already logged out).
// Clears the HttpOnly cookie so browser removes it immediately.
//
// The client must also delete the access token from localStorage/memory.
// The access token lives max 15 more minutes — acceptable by design.

export async function logoutController(request: Request, env: Env): Promise<Response> {
	const refreshToken = await extractRefreshToken(request);

	// Even if no token is found, we treat it as a successful logout.
	// Client may have already cleared their token — that is fine.
	if (refreshToken) {
		await logoutUser(env, refreshToken);
	}

	// clearRefreshCookie sets Max-Age=0 so browser deletes cookie immediately
	return clearRefreshCookie(ok({ message: 'Logged out successfully' }));
}

// ─── POST /auth/resend-otp ────────────────────────────────────────────────────

export async function resendOtpController(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }

	if (typeof body !== 'object' || body === null) return badRequest('Request body must be a JSON object');
	const b = body as Record<string, unknown>;

	if (typeof b.email !== 'string' || !b.email.trim()) return badRequest('email is required');

	const result = await resendOtp(env.DB, env, b.email.trim().toLowerCase());
	return ok(result);
}

// ─── POST /auth/forgot-password ───────────────────────────────────────────────

export async function forgotPasswordController(request: Request, env: Env): Promise<Response> {
	const b = (await request.json().catch(() => ({}))) as { email?: string };
	if (!b.email || typeof b.email !== 'string') return badRequest('email is required');

	const result = await forgotPassword(env.DB, env, b.email.trim().toLowerCase());
	return ok(result);
}

// ─── POST /auth/reset-password ────────────────────────────────────────────────

export async function resetPasswordController(request: Request, env: Env): Promise<Response> {
	const b = (await request.json().catch(() => ({}))) as {
		email?: string;
		otp?: string;
		newPassword?: string;
	};

	if (!b.email || !b.otp || !b.newPassword) {
		return badRequest('email, otp, and newPassword are required');
	}

	const result = await resetPassword(
		env.DB,
		env,
		b.email.trim().toLowerCase(),
		b.otp.trim(),
		b.newPassword,
	);
	return withRefreshCookie(ok(result), result.refreshToken);
}

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

export async function getMeController(auth: AuthContext, env: Env): Promise<Response> {
	return ok(await getProfile(env.DB, auth.userId));
}
