// =============================================================================
// services/auth.service.ts
//   - register returns AuthResponse: { token, user: UserPublic }
//   - login    returns AuthResponse: { token, user: UserPublic }
//   - JWT payload includes name (so clients don't need an extra /me call)
//   - All errors are AppError instances (handled by error-handler.ts)
//   - password never appears in any return value (enforced by UserPublic type)
// =============================================================================

import { findByEmail, createUser, findById } from '../repositories/user.repository';
import { generateToken, hashPassword, verifyPassword } from '../utils/jwt';
import { AppError } from '../middleware/error-handler';
import type { RegisterInput, LoginInput, AuthResponse, UserPublic } from '../types/user.types';
import type { Env } from '../types/env.types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Strip password from User row — TypeScript enforces this via UserPublic = Omit<User, 'password'>
function toPublic(user: { id: number; email: string; name: string; created_at: string; updated_at: string }): UserPublic {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		created_at: user.created_at,
		updated_at: user.updated_at,
	};
}

async function issueToken(user: { id: number; email: string; name: string }, env: Env): Promise<string> {
	return generateToken({ userId: user.id, email: user.email, name: user.name }, env);
}

// ─── register ────────────────────────────────────────────────────────────────

export async function registerUser(db: D1Database, env: Env, input: RegisterInput): Promise<AuthResponse> {
	// Check uniqueness
	const existing = await findByEmail(db, input.email);
	if (existing) {
		throw AppError.conflict('An account with this email already exists');
	}

	const hashedPassword = await hashPassword(input.password);

	const user = await createUser(db, input.email, input.name, hashedPassword);

	const token = await issueToken(user, env);

	return { token, user: toPublic(user) };
}

// ─── login ────────────────────────────────────────────────────────────────────

export async function loginUser(db: D1Database, env: Env, input: LoginInput): Promise<AuthResponse> {
	const user = await findByEmail(db, input.email);

	// Always run verifyPassword even on miss — prevents timing-based user enumeration.
	// If user doesn't exist we compare against a dummy hash (still takes ~300ms).
	const DUMMY_HASH = '0000000000000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000';
	const storedHash = user?.password ?? DUMMY_HASH;

	const isValid = await verifyPassword(input.password, storedHash);

	// Same error whether email or password is wrong — prevents user enumeration
	if (!user || !isValid) {
		throw AppError.unauthorized('Invalid email or password');
	}

	const token = await issueToken(user, env);

	return { token, user: toPublic(user) };
}

// ─── getProfile ───────────────────────────────────────────────────────────────

export async function getProfile(db: D1Database, userId: number): Promise<UserPublic> {
	const user = await findById(db, userId);

	if (!user) {
		throw AppError.notFound('User not found');
	}

	return toPublic(user);
}
