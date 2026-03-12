// =============================================================================
// utils/jwt.ts
//
//   Access tokens:  JWT, HS256, 15-minute TTL (short-lived)
//   Refresh tokens: JWT, HS256, 7-day TTL, signed with separate secret
//
//   WHY two secrets?
//     - If JWT_SECRET leaks, attacker can forge access tokens.
//     - REFRESH_TOKEN_SECRET rotation doesn't invalidate existing access tokens.
//     - Separate secrets let you invalidate all sessions without affecting
//       short-lived access tokens that expire on their own in ≤15 min.
//
//   Password hashing: PBKDF2-SHA256, 100k iterations, 16-byte random salt.
//   Web Crypto only — no Node.js dependencies (Workers V8 runtime).
// =============================================================================

import { SignJWT, jwtVerify, JWTPayload } from 'jose';
import { Env } from '../types/env.types';

// ─── Access token (15 min) ────────────────────────────────────────────────────

export async function generateToken(payload: JWTPayload, env: Env): Promise<string> {
	const secret = new TextEncoder().encode(env.JWT_SECRET);
	return new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('15m') // short-lived — refresh flow handles re-issue
		.sign(secret);
}

export async function verifyToken(token: string, env: Env): Promise<JWTPayload> {
	const secret = new TextEncoder().encode(env.JWT_SECRET);
	const { payload } = await jwtVerify(token, secret);
	return payload;
}

// ─── Refresh token (7 days) ───────────────────────────────────────────────────

export async function generateRefreshToken(payload: JWTPayload, env: Env): Promise<string> {
	const secret = new TextEncoder().encode(env.REFRESH_TOKEN_SECRET ?? env.JWT_SECRET + '_refresh');
	return new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('7d')
		.sign(secret);
}

export async function verifyRefreshToken(token: string, env: Env): Promise<JWTPayload> {
	const secret = new TextEncoder().encode(env.REFRESH_TOKEN_SECRET ?? env.JWT_SECRET + '_refresh');
	const { payload } = await jwtVerify(token, secret);
	return payload;
}

// ─── Password hashing — Web Crypto PBKDF2 ────────────────────────────────────
// WHY: bcryptjs uses Node.js crypto module which does not exist in the
//      Cloudflare Workers V8 runtime. Web Crypto (crypto.subtle) is native.
//
// HOW: PBKDF2-SHA256 with 100,000 iterations + 16-byte random salt.
//      Result stored as "saltHex:hashHex" — self-contained string.

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));

	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	);

	const hashBuffer = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
		keyMaterial,
		256,
	);

	const toHex = (buf: ArrayBuffer) =>
		Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

	return `${toHex(salt.buffer)}:${toHex(hashBuffer)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltHex, hashHex] = stored.split(':');
	if (!saltHex || !hashHex) return false;

	const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

	const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);

	const hashBuffer = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
		keyMaterial,
		256,
	);

	const attempt = Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	if (attempt.length !== hashHex.length) return false;
	let diff = 0;
	for (let i = 0; i < attempt.length; i++) {
		diff |= attempt.charCodeAt(i) ^ hashHex.charCodeAt(i);
	}
	return diff === 0;
}
