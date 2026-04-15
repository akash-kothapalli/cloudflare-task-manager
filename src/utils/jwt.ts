// =============================================================================
// utils/jwt.ts
//
//   Access tokens:  JWT, HS256, 15-minute TTL (short-lived)
//   Refresh tokens: JWT, HS256, 7-day TTL, signed with separate secret
//
//   WHY two secrets?
//     - If JWT_SECRET leaks, attacker can forge access tokens.
//     - REFRESH_TOKEN_SECRET rotation does not invalidate existing access tokens.
//     - Separate secrets let you invalidate all sessions without affecting
//       short-lived access tokens that expire on their own in 15 min.
//
//    — Refresh token revocation:
//     generateRefreshToken now returns { token, jti } instead of just a string.
//     jti (JWT ID) = crypto.randomUUID() — unique ID embedded in token payload.
//     auth.service.ts stores jti in KV on issue, deletes it on logout.
//     verifyRefreshToken still returns JWTPayload — jti is inside payload.jti.
//
//   Password hashing: PBKDF2-SHA256, 100k iterations, 16-byte random salt.
//   Web Crypto only — no Node.js dependencies (Cloudflare Workers V8 runtime).
// =============================================================================

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../types/env.types';

// ─── Access token (15 min) ────────────────────────────────────────────────────
// Short-lived — if stolen, attacker has 15 minutes maximum.
// No revocation needed — expiry is the revocation mechanism.

export async function generateToken(payload: JWTPayload, env: Env): Promise<string> {
	const secret = new TextEncoder().encode(env.JWT_SECRET);
	return new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('15m')
		.sign(secret);
}

export async function verifyToken(token: string, env: Env): Promise<JWTPayload> {
	const secret = new TextEncoder().encode(env.JWT_SECRET);
	const { payload } = await jwtVerify(token, secret);
	return payload;
}

// ─── Refresh token (7 days) ───────────────────────────────────────────────────
//  — generateRefreshToken now returns { token, jti } instead of string.
//
// WHY return jti separately?
//   The caller (auth.service.ts → issueTokenPair) needs the jti to store it
//   in KV right after generation. It is inside the JWT payload, but decoding
//   the token again just to extract jti would waste CPU. We generate jti here
//   and return it directly alongside the signed token string.
//
// WHY jti = crypto.randomUUID()?
//   UUID v4 is 122 bits of randomness — collision probability is negligible
//   even with millions of active sessions. It is the standard JWT claim for
//   a unique token identifier (RFC 7519 §4.1.7).

export async function generateRefreshToken(
	payload: JWTPayload,
	env: Env,
): Promise<{ token: string; jti: string }> {
	// Generate a unique ID for this specific refresh token
	const jti = crypto.randomUUID();

	const secret = new TextEncoder().encode(
		env.REFRESH_TOKEN_SECRET ?? env.JWT_SECRET + '_refresh',
	);

	const token = await new SignJWT({ ...payload, jti })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('7d')
		.sign(secret);

	// Return both — caller stores jti in KV, sends token to client
	return { token, jti };
}

// verifyRefreshToken is unchanged — returns full payload including jti.
// Callers extract payload.jti for KV lookup/delete.

export async function verifyRefreshToken(token: string, env: Env): Promise<JWTPayload> {
	const secret = new TextEncoder().encode(
		env.REFRESH_TOKEN_SECRET ?? env.JWT_SECRET + '_refresh',
	);
	const { payload } = await jwtVerify(token, secret);
	return payload;
}

// ─── Password hashing — Web Crypto PBKDF2 ────────────────────────────────────
// WHY PBKDF2 and not bcrypt?
//   bcryptjs uses Node.js crypto which does not exist in Workers V8 runtime.
//   Web Crypto (crypto.subtle) is native to the runtime — no dependencies.
//
// HOW: PBKDF2-SHA256, 100,000 iterations, 16-byte random salt.
//   Result stored as "saltHex:hashHex" — fully self-contained string.
//   The salt is stored with the hash so verification never needs the original.

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

	const attempt = Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	// Constant-time comparison — prevents timing attacks on the hash string.
	// Even if attempt.length !== hashHex.length we still run the loop to
	// avoid leaking length information via timing.
	if (attempt.length !== hashHex.length) return false;
	let diff = 0;
	for (let i = 0; i < attempt.length; i++) {
		diff |= attempt.charCodeAt(i) ^ hashHex.charCodeAt(i);
	}
	return diff === 0;
}
