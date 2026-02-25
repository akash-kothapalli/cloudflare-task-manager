// =============================================================================
// env.types.ts  —  Cloudflare Worker bindings
// Every binding here must have a matching entry in wrangler.jsonc
// =============================================================================

export interface Env {
	// D1 — relational database (users, tasks, tags, task_tags)
	DB: D1Database;

	// KV — low-latency cache for task lists + rate-limit counters
	CACHE: KVNamespace;

	// Workers AI — Llama-3 inference (optional: not available in local/test env)
	// Guard with: if (!env.AI) return; before calling env.AI.run()
	AI?: Ai;

	// Secret — set via: wrangler secret put JWT_SECRET
	JWT_SECRET: string;

	// Var — set in wrangler.jsonc "vars" block
	ENVIRONMENT: string;
}
