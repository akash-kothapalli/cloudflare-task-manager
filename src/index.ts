// =============================================================================
// index.ts  — Cloudflare Worker entry point
//
//  Request pipeline — each step either returns a Response or passes through:
//
//   Request arrives
//       ↓
//   withErrorHandling  — catches any AppError or unexpected throw
//       ↓
//   detectMaliciousInput — WAF: SQLi / XSS / path traversal scan
//       ↓
//   handleCors           — OPTIONS preflight → 204, or continue
//       ↓
//   checkRateLimit       — 60 req/min/IP via KV → 429, or continue
//       ↓
//   logWithTiming        — records method/path/status/duration
//       ↓
//   router               — routes to correct controller
//       ↓
//   addSecurityHeaders   — wraps every response with security + CORS headers
//       ↓
//   Response sent
//
//  CORS strategy:
//    - The request Origin is extracted once at the top and threaded through.
//    - addSecurityHeaders calls getCorsHeaders(origin) to set the correct
//      Access-Control-Allow-Origin on every response (not just preflights).
//    - This ensures browsers accept the response for credentialed requests.
// =============================================================================

import { withErrorHandling } from './middleware/error-handler';
import { logWithTiming } from './middleware/logger';
import {
	addSecurityHeaders,
	handleCors,
	checkRateLimit,
	detectMaliciousInput,
	getCorsHeaders,
} from './middleware/security';
import { router } from './routes/index';
import type { Env } from './types/env.types';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Extract origin once — reused by CORS helpers throughout the pipeline
		const origin = request.headers.get('Origin') ?? '';

		return withErrorHandling(async () => {
			// 1. WAF — block obvious injection attempts before any processing
			const wafBlock = await detectMaliciousInput(request);
			if (wafBlock) return withCors(wafBlock, origin);

			// 2. CORS preflight — OPTIONS must return 204 before rate limit check
			//    (browsers send OPTIONS before every cross-origin credentialed request)
			const corsResponse = handleCors(request);
			if (corsResponse) return withCors(corsResponse, origin);

			// 3. Rate limiting — check KV counter for this IP
			const rateLimitResponse = await checkRateLimit(request, env.CACHE);
			if (rateLimitResponse) return withCors(rateLimitResponse, origin);

			// 4. Log + route — timing wraps the actual handler
			//    ctx is passed so task creation can use ctx.waitUntil() for AI enrichment
			//    without blocking the response
			const response = await logWithTiming(request, () => router(request, env, ctx));

			// 5. Security + CORS headers on every response that reaches the client
			return withCors(addSecurityHeaders(response), origin);
		});
	},
};

// ─── Helper: attach CORS headers to any response ──────────────────────────────
// Separated so every early-exit path (WAF block, rate limit, preflight) also
// gets the correct Access-Control-Allow-Origin header. Without this, browsers
// cannot read the error body because the CORS header is missing on the 403/429.

function withCors(response: Response, origin: string): Response {
	const corsHeaders = getCorsHeaders(origin);
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(corsHeaders)) {
		if (value) headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
