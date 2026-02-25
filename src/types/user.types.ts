// =============================================================================
// user.types.ts
// =============================================================================

// ─── DB row ───────────────────────────────────────────────────────────────────
// Readonly<> — DB rows must never be mutated directly after fetching.
// `password` is the PBKDF2 hash string, never the plaintext.

export type User = Readonly<{
	id: number;
	email: string;
	name: string;
	password: string; // PBKDF2: "saltHex:hashHex" — never expose in API response
	created_at: string;
	updated_at: string;
}>;

// ─── API response ─────────────────────────────────────────────────────────────
// What the API returns — password is explicitly omitted so it can never
// accidentally be serialised into a response.

export type UserPublic = Omit<User, 'password'>;

// ─── JWT payload ──────────────────────────────────────────────────────────────
// What we encode inside the token. Keep it small — token is sent on every request.

export interface JwtPayload {
	userId: number;
	email: string;
	name: string;
}

// ─── Auth inputs ──────────────────────────────────────────────────────────────

export interface RegisterInput {
	email: string;
	name: string; // ADDED: users now have a display name
	password: string;
}

export interface LoginInput {
	email: string;
	password: string;
}

// ─── Auth response ────────────────────────────────────────────────────────────
// Returned from POST /auth/register and POST /auth/login

export interface AuthResponse {
	token: string;
	user: UserPublic;
}
