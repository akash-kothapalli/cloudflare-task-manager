// =============================================================================
// services/auth.service.ts
//
//   Token strategy:
//     - Access token:  JWT, 15 min, signed with JWT_SECRET
//     - Refresh token: JWT, 7 days, signed with REFRESH_TOKEN_SECRET
//
//     — Refresh token revocation via KV denylist:
//
//     ISSUE:   generateRefreshToken() returns { token, jti }.
//              issueTokenPair() stores jti in KV with 7-day TTL immediately.
//              KV key format: "rt:{jti}"  value: "1"
//
//     REFRESH: refreshAccessToken() verifies signature first, then checks KV.
//              If jti is missing from KV → token was revoked → 401.
//              On success: old jti deleted, new token pair issued, new jti stored.
//              This is token rotation — each refresh consumes the old token.
//
//     LOGOUT:  logoutUser() verifies token, deletes jti from KV → token is dead.
//              Any subsequent use of that refresh token fails the KV check.
//
//     WHY KV and not a database table?
//       A DB table grows forever and needs a cleanup job.
//       KV TTL = same as token TTL (7 days) — entry auto-deletes when the
//       token would have expired anyway. Zero maintenance, zero orphaned rows.
// =============================================================================

import { findByEmail, createUser, findById, markUserVerified, updatePassword } from '../repositories/user.repository';
import { generateToken, hashPassword, verifyPassword, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { AppError } from '../middleware/error-handler';
import { generateAndStoreOtp, sendOtpEmail, verifyOtp } from './otp.service';
import { validateEmailFull } from './email-validation.service';
import type { RegisterInput, LoginInput, UserPublic } from '../types/user.types';
import type { Env } from '../types/env.types';

// ─── KV key helpers ───────────────────────────────────────────────────────────
// All refresh token KV keys use the "rt:" prefix so they are easy to identify
// in the Cloudflare dashboard and never collide with OTP keys ("otp:") or
// rate limit keys ("rl:").

const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds — matches JWT expiry

function refreshTokenKey(jti: string): string {
	return `rt:${jti}`;
}

// ─── Response types ───────────────────────────────────────────────────────────

export interface RegisterResponse {
	requiresVerification: true;
	email: string;
	message: string;
	dev_otp?: string; // only present in non-production when BREVO_API_KEY is not set
}

export interface FullAuthResponse {
	token: string;
	refreshToken: string;
	user: UserPublic;
}

// ─── toPublic ─────────────────────────────────────────────────────────────────
// Strips internal fields (password) before sending user data to the client.
// Called every time we return a user object in an API response.

function toPublic(user: {
	id: number;
	email: string;
	name: string;
	is_verified: number;
	created_at: string;
	updated_at: string;
}): UserPublic {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		is_verified: user.is_verified,
		created_at: user.created_at,
		updated_at: user.updated_at,
	};
}

// ─── issueTokenPair ───────────────────────────────────────────────────────────
// — now stores refresh token jti in KV immediately after generation.
//
// Flow:
//   1. Generate access token (no KV interaction — short-lived, no revocation needed)
//   2. Generate refresh token → get back { token, jti }
//   3. Store jti in KV with 7-day TTL (same lifetime as the token itself)
//   4. Return { token, refreshToken } to caller
//
// The KV write happens in parallel with the access token generation via
// Promise.all — no extra latency added.

async function issueTokenPair(
	user: { id: number; email: string; name: string },
	env: Env,
): Promise<{ token: string; refreshToken: string }> {
	const payload = { userId: user.id, email: user.email, name: user.name };

	// Generate both tokens in parallel
	const [token, { token: refreshToken, jti }] = await Promise.all([
		generateToken(payload, env),
		generateRefreshToken(payload, env),
	]);

	// Store jti in KV — this is what makes revocation possible.
	// TTL matches the token's own expiry so KV auto-cleans when token dies.
	await env.CACHE.put(refreshTokenKey(jti), '1', {
		expirationTtl: REFRESH_TOKEN_TTL,
	});
	return { token, refreshToken };
}


// ─── revokeRefreshToken ───────────────────────────────────────────────────────
// Deletes the jti from KV — makes the token permanently unusable.
// Called by logoutUser() and by refreshAccessToken() to consume the old token.

async function revokeRefreshToken(jti: string, env: Env): Promise<void> {
	await env.CACHE.delete(refreshTokenKey(jti));
}

// ─── getDevOtpIfApplicable ────────────────────────────────────────────────────
// Returns the OTP in the API response ONLY in non-production dev environments
// where no email provider is configured. Safe to expose in dev — never in prod.

function getDevOtpIfApplicable(env: Env, otp: string): string | undefined {
	if (env.ENVIRONMENT === 'production') return undefined;
	if (env.BREVO_API_KEY) return undefined;
	return otp;
}

// ─── register ─────────────────────────────────────────────────────────────────

export async function registerUser(db: D1Database, env: Env, input: RegisterInput): Promise<RegisterResponse> {
	const emailValidation = await validateEmailFull(input.email, env);
	if (!emailValidation.valid) {
		throw AppError.badRequest(emailValidation.reason ?? 'Invalid email address');
	}

	const existing = await findByEmail(db, input.email);

	if (existing) {
		if (existing.is_verified === 1) {
			throw AppError.conflict('An account with this email already exists');
		}
		// Unverified account exists — resend OTP instead of creating duplicate
		const otp = await generateAndStoreOtp(env.CACHE, input.email, 'verify');
		await sendOtpEmail(env, input.email, otp, existing.name);
		return {
			requiresVerification: true,
			email: input.email,
			message: 'A new verification code has been sent to your email address.',
			dev_otp: getDevOtpIfApplicable(env, otp),
		};
	}

	const hashedPassword = await hashPassword(input.password);
	await createUser(db, input.email, input.name, hashedPassword);

	const otp = await generateAndStoreOtp(env.CACHE, input.email, 'verify');
	await sendOtpEmail(env, input.email, otp, input.name);

	return {
		requiresVerification: true,
		email: input.email,
		message: 'Account created. Please check your email for a 6-digit verification code.',
		dev_otp: getDevOtpIfApplicable(env, otp),
	};
}

// ─── verifyOtpAndLogin ────────────────────────────────────────────────────────

export async function verifyOtpAndLogin(
	db: D1Database,
	env: Env,
	email: string,
	otp: string,
): Promise<FullAuthResponse> {
	const user = await findByEmail(db, email);
	if (!user) throw AppError.badRequest('Invalid or expired verification code');

	const isValid = await verifyOtp(env.CACHE, email, otp, 'verify');
	if (!isValid) throw AppError.badRequest('Invalid or expired verification code');

	if (user.is_verified === 0) {
		await markUserVerified(db, email);
	}

	const verifiedUser = await findByEmail(db, email);
	if (!verifiedUser) throw AppError.internal('User not found after verification');

	// issueTokenPair now stores refresh jti in KV automatically (Fix 5)
	const { token, refreshToken } = await issueTokenPair(verifiedUser, env);
	return { token, refreshToken, user: toPublic(verifiedUser) };
}

// ─── login ────────────────────────────────────────────────────────────────────

export async function loginUser(db: D1Database, env: Env, input: LoginInput): Promise<FullAuthResponse> {
	const user = await findByEmail(db, input.email);

	// Always run the hash even when user does not exist — prevents timing attacks
	// that could reveal whether an email is registered by measuring response time.
	const DUMMY_HASH =
		'0000000000000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000';
	const storedHash = user?.password ?? DUMMY_HASH;
	const isValid = await verifyPassword(input.password, storedHash);

	if (!user || !isValid) throw AppError.unauthorized('Invalid email or password');

	if (user.is_verified === 0) {
		throw AppError.forbidden(
			'Please verify your email address before logging in. Check your inbox for the verification code.',
		);
	}

	// issueTokenPair now stores refresh jti in KV automatically (Fix 5)
	const { token, refreshToken } = await issueTokenPair(user, env);
	return { token, refreshToken, user: toPublic(user) };
}

// ─── refreshAccessToken ───────────────────────────────────────────────────────
//  — now checks KV before issuing new tokens.
//
// Steps:
//   1. Verify JWT signature — rejects tampered/expired tokens fast
//   2. Extract jti from payload
//   3. Check KV — if jti missing, token was revoked → 401
//   4. Revoke old jti (token rotation — each refresh is single-use)
//   5. Issue new token pair (new jti stored in KV automatically)
//
// WHY revoke the old refresh token on use (token rotation)?
//   If a refresh token is stolen, the attacker uses it first.
//   The real user then tries to refresh → their token is already gone → 401.
//   This signals compromise. Without rotation, both attacker and user could
//   use the same refresh token indefinitely until it expires.

export async function refreshAccessToken(
	env: Env,
	refreshToken: string,
): Promise<{ token: string; refreshToken: string }> {
	// Step 1 — verify signature
	let payload;
	try {
		payload = await verifyRefreshToken(refreshToken, env);
	} catch {
		throw AppError.unauthorized('Invalid or expired refresh token');
	}

	// Step 2 — validate payload shape
	if (
		typeof payload.userId !== 'number' ||
		typeof payload.email !== 'string' ||
		typeof payload.name !== 'string' ||
		typeof payload.jti !== 'string'
	) {
		throw AppError.unauthorized('Malformed refresh token');
	}

	// Step 3 — check KV denylist
	// If the jti is not in KV, the token was either revoked (logout) or
	// already used (rotation). Either way: reject.
	const stored = await env.CACHE.get(refreshTokenKey(payload.jti));
	if (!stored) {
		throw AppError.unauthorized('Refresh token has been revoked');
	}

	// Step 4 — revoke old token (consume it — single-use rotation)
	await revokeRefreshToken(payload.jti, env);

	// Step 5 — issue fresh token pair (new jti stored in KV inside issueTokenPair)
	return issueTokenPair(
		{ id: payload.userId, email: payload.email, name: payload.name },
		env,
	);
}

// ─── logoutUser ───────────────────────────────────────────────────────────────
// — new function.
//
// Client sends their refresh token in the request body.
// We verify the signature (proves they own this token) then delete
// the jti from KV (proves logout actually happened server-side).
//
// After this call:
//   - The refresh token is permanently dead — KV entry gone
//   - The access token still works for up to 15 more minutes (by design)
//     Short TTL means this is acceptable — no extra action needed
//   - Client must delete both tokens from localStorage after receiving 200

export async function logoutUser(env: Env, refreshToken: string): Promise<void> {
	// Verify signature — we only revoke tokens that are cryptographically valid.
	// An invalid token string means the client has nothing valid to revoke.
	let payload;
	try {
		payload = await verifyRefreshToken(refreshToken, env);
	} catch {
		// Token is invalid or already expired — treat as already logged out.
		// Do not throw — logout should always succeed from the user's perspective.
		return;
	}

	// Extract jti and delete from KV — token is now permanently revoked
	if (typeof payload.jti === 'string') {
		await revokeRefreshToken(payload.jti, env);
	}
}

// ─── resendOtp ────────────────────────────────────────────────────────────────

export async function resendOtp(
	db: D1Database,
	env: Env,
	email: string,
): Promise<{ message: string; dev_otp?: string }> {
	const user = await findByEmail(db, email);

	// Always return success message — prevents email enumeration
	if (!user) return { message: 'If that email is registered, a new code has been sent.' };
	if (user.is_verified === 1) return { message: 'This account is already verified. Please log in.' };

	const otp = await generateAndStoreOtp(env.CACHE, email, 'verify');
	await sendOtpEmail(env, email, otp, user.name);

	return {
		message: 'A new verification code has been sent to your email address.',
		dev_otp: getDevOtpIfApplicable(env, otp),
	};
}

// ─── forgotPassword ───────────────────────────────────────────────────────────

export async function forgotPassword(
	db: D1Database,
	env: Env,
	email: string,
): Promise<{ message: string; dev_otp?: string }> {
	const user = await findByEmail(db, email);

	// Always return same message — prevents email enumeration
	if (!user) return { message: 'If that email is registered, a reset code has been sent.' };

	const otp = await generateAndStoreOtp(env.CACHE, email, 'reset');
	await sendOtpEmail(env, email, otp, user.name);

	return {
		message: 'A reset code has been sent to your email address.',
		dev_otp: getDevOtpIfApplicable(env, otp),
	};
}

// ─── resetPassword ────────────────────────────────────────────────────────────

export async function resetPassword(
	db: D1Database,
	env: Env,
	email: string,
	otp: string,
	newPassword: string,
): Promise<FullAuthResponse> {
	if (!newPassword || newPassword.length < 8) {
		throw AppError.badRequest('Password must be at least 8 characters');
	}

	const user = await findByEmail(db, email);
	if (!user) throw AppError.badRequest('Invalid or expired reset code');

	const isValid = await verifyOtp(env.CACHE, email, otp, 'reset');
	if (!isValid) throw AppError.badRequest('Invalid or expired reset code');

	const hashed = await hashPassword(newPassword);
	await updatePassword(db, email, hashed);

	if (user.is_verified === 0) {
		await markUserVerified(db, email);
	}

	const freshUser = await findByEmail(db, email);
	if (!freshUser) throw AppError.internal('User not found after password reset');

	// issueTokenPair stores new refresh jti in KV automatically (Fix 5)
	const { token, refreshToken } = await issueTokenPair(freshUser, env);
	return { token, refreshToken, user: toPublic(freshUser) };
}

// ─── getProfile ───────────────────────────────────────────────────────────────

export async function getProfile(db: D1Database, userId: number): Promise<UserPublic> {
	const user = await findById(db, userId);
	if (!user) throw AppError.notFound('User not found');
	return toPublic(user);
}
