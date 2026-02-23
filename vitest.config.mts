// vitest.config.mts
// WHY SEPARATE FROM tsconfig.json:
//   vitest runs in Node.js — it legitimately needs @types/node.
//   Our src/ files run in Workers V8 — they must NOT see @types/node.
//   Keeping configs separate means each environment gets the right types.
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				// Point at test config — identical to wrangler.jsonc but without
				// the "ai" binding. Miniflare cannot resolve Workers AI locally
				// (it requires Cloudflare's GPU inference network).
				// AI enrichment is optional — guarded with if (!env.AI) in the service.
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
	},
});

