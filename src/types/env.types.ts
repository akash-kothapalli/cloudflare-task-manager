// =============================================================================
// env.types.ts  —  Cloudflare Worker bindings
// Every binding here must have a matching entry in wrangler.jsonc
// =============================================================================

export interface Env {
	// D1 — relational database (users, tasks, tags, task_tags)
	DB: D1Database;

	// KV — low-latency cache for task lists + rate-limit counters + OTP storage
	CACHE: KVNamespace;

	// Workers AI — Llama-3 inference (optional: not available in local/test env)
	AI?: Ai;

	// Secret — set via: wrangler secret put JWT_SECRET
	JWT_SECRET: string;

	// Secret — set via: wrangler secret put REFRESH_TOKEN_SECRET
	// Optional so test environments that only set vars[] still compile.
	REFRESH_TOKEN_SECRET?: string;

	// Email — set via: wrangler secret put EMAIL_FROM (optional, defaults to onboarding@resend.dev)
	EMAIL_FROM?: string;

	// Brevo API key — set via: wrangler secret put BREVO_API_KEY
	// Sign up free at https://brevo.com — 300 emails/day, sends to ANY email, no domain needed
	BREVO_API_KEY?: string;

	// Var — set in wrangler.jsonc "vars" block
	ENVIRONMENT: string;

	// CORS origin lock — set via: wrangler secret put ALLOWED_ORIGIN
	// e.g. "https://app.yourdomain.com"
	// Leave unset in local dev — localhost is allowed automatically.
	ALLOWED_ORIGIN?: string;
}


