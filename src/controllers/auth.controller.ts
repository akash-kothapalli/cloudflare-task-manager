// =============================================================================
// controllers/auth.controller.ts
//
//   - Uses central validation from utils/validation.ts — no inline logic
//   - No `any` anywhere — all errors properly typed and narrowed
//   - register and login both return AuthResponse: { token, user }
//   - GET /auth/me endpoint to fetch current user profile
//   - All responses use typed helpers from utils/response.ts
// =============================================================================


import { registerUser, loginUser, getProfile, verifyOtpAndLogin, resendOtp, forgotPassword, resetPassword, refreshAccessToken } from '../services/auth.service';
import { validateRegisterInput, validateLoginInput } from '../utils/validation';
import { ok, created, badRequest } from '../utils/response';
import type { AuthContext } from '../middleware/auth.middleware';
import type { Env } from '../types/env.types';

const REFRESH_COOKIE = (token: string) =>
	`refresh_token=${token}; HttpOnly; Secure; SameSite=None; Path=/auth/refresh; Max-Age=${7 * 24 * 3600}`;

function withRefreshCookie(response: Response, refreshToken: string): Response {
	const headers = new Headers(response.headers);
	headers.set('Set-Cookie', REFRESH_COOKIE(refreshToken));
	return new Response(response.body, { status: response.status, headers });
}

// POST /auth/register
export async function registerController(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }
	const validation = validateRegisterInput(body);
	if (!validation.ok) return badRequest(validation.error);
	const result = await registerUser(env.DB, env, validation.value);
	return created(result);
}

// POST /auth/verify-otp
export async function verifyOtpController(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }
	if (typeof body !== 'object' || body === null) return badRequest('Request body must be a JSON object');
	const b = body as Record<string, unknown>;
	if (typeof b.email !== 'string' || !b.email.trim()) return badRequest('email is required');
	if (typeof b.otp !== 'string' || !b.otp.trim()) return badRequest('otp is required');
	if (!/^\d{6}$/.test(b.otp.trim())) return badRequest('otp must be a 6-digit code');
	const result = await verifyOtpAndLogin(env.DB, env, b.email.trim().toLowerCase(), b.otp.trim());
	return withRefreshCookie(ok(result), result.refreshToken);
}

// POST /auth/forgot-password — sends OTP to verified users for password reset
export async function forgotPasswordController(request: Request, env: Env): Promise<Response> {
	const b = (await request.json().catch(() => ({}))) as { email?: string };
	if (!b.email || typeof b.email !== 'string') return badRequest('email is required');
	const result = await forgotPassword(env.DB, env, b.email.trim().toLowerCase());
	return ok(result);
}

// POST /auth/reset-password — verify OTP + save new password + sign in
export async function resetPasswordController(request: Request, env: Env): Promise<Response> {
	const b = (await request.json().catch(() => ({}))) as { email?: string; otp?: string; newPassword?: string };
	if (!b.email || !b.otp || !b.newPassword) return badRequest('email, otp, and newPassword are required');
	const result = await resetPassword(env.DB, env, b.email.trim().toLowerCase(), b.otp.trim(), b.newPassword);
	return withRefreshCookie(ok(result), result.refreshToken);
}

// POST /auth/resend-otp
export async function resendOtpController(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }
	if (typeof body !== 'object' || body === null) return badRequest('Request body must be a JSON object');
	const b = body as Record<string, unknown>;
	if (typeof b.email !== 'string' || !b.email.trim()) return badRequest('email is required');
	const result = await resendOtp(env.DB, env, b.email.trim().toLowerCase());
	return ok(result);
}

// POST /auth/login
export async function loginController(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }
	const validation = validateLoginInput(body);
	if (!validation.ok) return badRequest(validation.error);
	const result = await loginUser(env.DB, env, validation.value);
	return withRefreshCookie(ok(result), result.refreshToken);
}

// POST /auth/refresh — accepts HttpOnly cookie OR { refreshToken } body
export async function refreshController(request: Request, env: Env): Promise<Response> {
	// Try HttpOnly cookie first (browser clients)
	let refreshToken: string | null = null;
	const cookieHeader = request.headers.get('Cookie') ?? '';
	const match = cookieHeader.match(/(?:^|;\s*)refresh_token=([^;]+)/);
	if (match) refreshToken = match[1] ?? null;

	// Fallback: request body (API / mobile clients)
	if (!refreshToken) {
		try {
			const b = await request.json() as Record<string, unknown>;
			if (typeof b.refreshToken === 'string') refreshToken = b.refreshToken;
		} catch { /* no body */ }
	}

	if (!refreshToken) {
		return new Response(
			JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Refresh token required' } }),
			{ status: 401, headers: { 'Content-Type': 'application/json' } },
		);
	}

	const tokens = await refreshAccessToken(env, refreshToken);
	return withRefreshCookie(ok(tokens), tokens.refreshToken);
}

// GET /auth/me
export async function getMeController(auth: AuthContext, env: Env): Promise<Response> {
	return ok(await getProfile(env.DB, auth.userId));
}
