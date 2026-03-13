// =============================================================================
// services/auth.service.ts
//
//   Token strategy:
//     - Access token:  JWT, 15 min, signed with JWT_SECRET
//     - Refresh token: JWT, 7 days, signed with REFRESH_TOKEN_SECRET
//
//   On login/verify-otp both tokens are returned.
//   POST /auth/refresh accepts a refresh token → issues new access token.
//   This eliminates the "silent 401 after 1 hour" issue from the old design.
// =============================================================================

import { findByEmail, createUser, findById, markUserVerified, updatePassword } from '../repositories/user.repository';
import { generateToken, hashPassword, verifyPassword, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { AppError } from '../middleware/error-handler';
import { generateAndStoreOtp, sendOtpEmail, verifyOtp } from './otp.service';import { validateEmailFull } from './email-validation.service';
import type { RegisterInput, LoginInput, AuthResponse, UserPublic } from '../types/user.types';
import type { Env } from '../types/env.types';

// ─── Response types ───────────────────────────────────────────────────────────

export interface RegisterResponse {
	requiresVerification: true;
	email: string;
	message: string;
	dev_otp?: string; // ONLY present when RESEND_API_KEY is not configured + non-production
}

export interface FullAuthResponse {
	token: string;
	refreshToken: string;
	user: UserPublic;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

async function issueTokenPair(user: { id: number; email: string; name: string }, env: Env): Promise<{ token: string; refreshToken: string }> {
	const payload = { userId: user.id, email: user.email, name: user.name };
	const [token, refreshToken] = await Promise.all([
		generateToken(payload, env),
		generateRefreshToken(payload, env),
	]);
	return { token, refreshToken };
}

// Returns dev_otp only when BREVO_API_KEY is not configured and not production.
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
		const otp = await generateAndStoreOtp(env.CACHE, input.email);
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

	const otp = await generateAndStoreOtp(env.CACHE, input.email);
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

	// Always verify OTP — even for already-verified users (forgot-password flow)
	const isValid = await verifyOtp(env.CACHE, email, otp);
	if (!isValid) throw AppError.badRequest('Invalid or expired verification code');

	if (user.is_verified === 0) {
		await markUserVerified(db, email);
	}

	const verifiedUser = await findByEmail(db, email);
	if (!verifiedUser) throw AppError.internal('User not found after verification');

	const { token, refreshToken } = await issueTokenPair(verifiedUser, env);
	return { token, refreshToken, user: toPublic(verifiedUser) };
}

// ─── login ────────────────────────────────────────────────────────────────────

export async function loginUser(db: D1Database, env: Env, input: LoginInput): Promise<FullAuthResponse> {
	const user = await findByEmail(db, input.email);

	// Constant-time path: always hash even if user doesn't exist
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

	const { token, refreshToken } = await issueTokenPair(user, env);
	return { token, refreshToken, user: toPublic(user) };
}

// ─── refreshAccessToken ───────────────────────────────────────────────────────
// Accepts a valid refresh token → issues a new access token (+ new refresh token).
// This is a token rotation pattern: old refresh token is single-use conceptually.
// Full revocation would require a KV denylist (out of scope here).

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<{ token: string; refreshToken: string }> {
	let payload;
	try {
		payload = await verifyRefreshToken(refreshToken, env);
	} catch {
		throw AppError.unauthorized('Invalid or expired refresh token');
	}

	if (
		typeof payload.userId !== 'number' ||
		typeof payload.email !== 'string' ||
		typeof payload.name !== 'string'
	) {
		throw AppError.unauthorized('Malformed refresh token');
	}

	return issueTokenPair({ id: payload.userId, email: payload.email, name: payload.name }, env);
}

// ─── resendOtp ────────────────────────────────────────────────────────────────

export async function resendOtp(db: D1Database, env: Env, email: string): Promise<{ message: string; dev_otp?: string }> {
	const user = await findByEmail(db, email);

	if (!user) return { message: 'If that email is registered, a new code has been sent.' };
	if (user.is_verified === 1) return { message: 'This account is already verified. Please log in.' };

	const otp = await generateAndStoreOtp(env.CACHE, email);
	await sendOtpEmail(env, email, otp, user.name);

	return {
		message: 'A new verification code has been sent to your email address.',
		dev_otp: getDevOtpIfApplicable(env, otp),
	};
}

// ─── forgotPassword ───────────────────────────────────────────────────────────
// Sends OTP to ANY registered email regardless of verification status.
// Used by the "Forgot password" flow.

export async function forgotPassword(db: D1Database, env: Env, email: string): Promise<{ message: string; dev_otp?: string }> {
	const user = await findByEmail(db, email);

	// Always return the same message to prevent email enumeration
	if (!user) return { message: 'If that email is registered, a reset code has been sent.' };

	const otp = await generateAndStoreOtp(env.CACHE, email);
	await sendOtpEmail(env, email, otp, user.name);

	return {
		message: 'A reset code has been sent to your email address.',
		dev_otp: getDevOtpIfApplicable(env, otp),
	};
}

// ─── resetPassword ────────────────────────────────────────────────────────────
// Verifies OTP → hashes new password → saves to DB → signs user in.
// This is the correct forgot-password completion step.

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

	// Verify OTP — consumes it (single-use)
	const isValid = await verifyOtp(env.CACHE, email, otp);
	if (!isValid) throw AppError.badRequest('Invalid or expired reset code');

	// Hash and save new password
	const hashed = await hashPassword(newPassword);
	await updatePassword(db, email, hashed);

	// Ensure user is marked verified (edge case: unverified user resets password)
	if (user.is_verified === 0) {
		await markUserVerified(db, email);
	}

	// Issue session tokens
	const freshUser = await findByEmail(db, email);
	if (!freshUser) throw AppError.internal('User not found after password reset');
	const { token, refreshToken } = await issueTokenPair(freshUser, env);
	return { token, refreshToken, user: toPublic(freshUser) };
}

// ─── getProfile ───────────────────────────────────────────────────────────────

export async function getProfile(db: D1Database, userId: number): Promise<UserPublic> {
	const user = await findById(db, userId);
	if (!user) throw AppError.notFound('User not found');
	return toPublic(user);
}
