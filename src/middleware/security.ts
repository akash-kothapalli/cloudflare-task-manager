// =============================================================================
// middleware/security.ts
//
//   1. addSecurityHeaders  — full header set (CSP, HSTS, referrer, permissions)
//   2. handleCors          — CORS preflight + allowlist check (not wildcard *)
//   3. checkRateLimit      — fixed-window counter in KV, 60 req/min/IP
//                            Race condition fix: window key includes the current
//                            minute timestamp so each 60-second window gets a
//                            fresh key. We rely on KV's per-key write ordering
//                            and cap the window with expirationTtl so leaked
//                            counts auto-expire.
//                            Note: true atomic increment is not possible with KV
//                            (no CAS). This approach minimises the race window.
//                            For strict enforcement upgrade to Workers paid plan
//                            and use the native rate_limiting binding.
//   4. detectMaliciousInput — WAF-style pattern scan: SQLi, XSS, path traversal
// =============================================================================

import { tooManyRequests, preflight } from '../utils/response';
import type { Env } from '../types/env.types';

// ─── 1. Security headers ──────────────────────────────────────────────────────
// Returns a NEW Response with all security headers added.
// Workers Response objects are immutable once created — calling .set() on a
// frozen response silently does nothing, so we build a fresh Response here.

export function addSecurityHeaders(response: Response): Response {
	const newHeaders = new Headers(response.headers);

	// Prevents MIME-type sniffing — browser must honour Content-Type
	newHeaders.set('X-Content-Type-Options', 'nosniff');

	// Stops the page being embedded in an iframe (clickjacking defence)
	newHeaders.set('X-Frame-Options', 'DENY');

	// Legacy XSS filter — modern browsers use CSP instead, kept for older browsers
	newHeaders.set('X-XSS-Protection', '1; mode=block');

	// Forces HTTPS for 2 years, includes subdomains
	newHeaders.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');

	// Content Security Policy — API + frontend: allow scripts/styles from same origin
	newHeaders.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");

	// Controls how much referrer info is sent — origin only on cross-origin requests
	newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');

	// Opt out of browser features the API does not use
	newHeaders.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

	// Do not advertise the server stack
	newHeaders.delete('Server');

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	});
}

// ─── 2. CORS ──────────────────────────────────────────────────────────────────
// wildcard allows ANY website to call the API in a logged-in user's browser.
// With an allowlist, only the known frontend origins are permitted.
//
// Since the frontend is served from the same Worker (./public/index.html via
// the ASSETS binding) the origin IS your workers.dev subdomain — no custom
// domain needed for a correct CORS allowlist.

const ALLOWED_ORIGINS = new Set([
	'https://cloudflare-task-manager.taskflow-akash.workers.dev',
	'http://localhost:3000',  // local dev: npm run dev / vite
	'http://localhost:8787',  // local dev: wrangler dev default port
]);

export function getCorsHeaders(origin: string): Record<string, string> {
	// Only echo back the origin if it is in the allowlist.
	// Returning '*' when Authorization headers are present causes browsers to
	// block the response (CORS + credentials requires exact origin, not wildcard).
	const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : '';

	return {
		'Access-Control-Allow-Origin': allowedOrigin,
		'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Max-Age': '86400',
	};
}

export function handleCors(request: Request): Response | null {
	const origin = request.headers.get('Origin') ?? '';

	if (request.method === 'OPTIONS') {
		// Preflight — always respond 204 with CORS headers.
		// The browser blocks the follow-up request if origin doesn't match,
		// so responding to all OPTIONS is safe and required for preflight to work.
		return preflight(origin);
	}

	return null;
}

// ─── 3. Rate limiting — fixed-window with per-minute KV keys ─────────────────
// KV key format: "rl:{ip}:{windowMinute}"
//   windowMinute = Math.floor(Date.now() / 60000)
//
// The expirationTtl of 90s means KV auto-cleans each key after the window ends.
// No manual cleanup needed.
//
// Remaining known limitation:
//   Two concurrent requests can both read count=59, both pass the check,
//   and both write 60 — KV has no atomic increment (no Compare-And-Swap).
//   This allows a small overage (~2-3 requests) at high concurrency.
//   Acceptable for free-tier; fix later with the paid rate_limiting binding.

const RATE_LIMIT_MAX = 60;    // max requests per window
const RATE_LIMIT_WINDOW = 60; // seconds — must match the minute bucket logic
const KV_TTL = 90;            // slightly longer than window so key outlives it

export async function checkRateLimit(request: Request, cache: KVNamespace): Promise<Response | null> {
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

	// windowMinute changes every 60 seconds — gives each IP a fresh counter
	const windowMinute = Math.floor(Date.now() / 60_000);
	const key = `rl:${ip}:${windowMinute}`;

	const current = await cache.get(key);
	const count = current ? parseInt(current, 10) : 0;

	if (count >= RATE_LIMIT_MAX) {
		// Calculate exact seconds until this window expires
		const secondsIntoWindow = Math.floor((Date.now() % 60_000) / 1000);
		const retryAfter = RATE_LIMIT_WINDOW - secondsIntoWindow;
		return tooManyRequests(retryAfter);
	}

	// Increment and write back — TTL ensures key self-deletes after window ends
	await cache.put(key, String(count + 1), { expirationTtl: KV_TTL });

	return null;
}

// ─── 4. WAF — Malicious input detection ──────────────────────────────────────
// Pattern-based scan of URL path + query string + request body.
// Not a replacement for Cloudflare's WAF product — demonstrates security
// awareness at the HTTP layer.
//
// Detects:
//   SQLi          — UNION SELECT, comment sequences, stacked queries
//   XSS           — <script>, javascript: URLs, inline event handlers
//   Path traversal — encoded ../ sequences trying to escape the app root

const SQL_INJECTION_PATTERN =
	/(\bunion\b.*\bselect\b|'\s*(or|and)\s*'|--(?:\s|$)|\/\*|\*\/|;\s*drop|;\s*delete|;\s*insert|xp_|exec\s*\()/i;

const XSS_PATTERN =
	/(<script|javascript:|on\w+\s*=|<\s*img[^>]*onerror|<iframe|<object|<embed)/i;

// Encoded path traversal — literal "../" is normalised away by the Workers
// runtime before we see it, but percent-encoded variants survive
const PATH_TRAVERSAL = /(%2e%2e[/\\]|[/\\]%2e%2e)/i;

// Every valid route prefix — anything outside this list gets a 403
const VALID_PATH_PREFIXES = ['/tasks', '/tags', '/auth', '/health'];

export async function detectMaliciousInput(request: Request): Promise<Response | null> {
	const url = new URL(request.url);

	// Decode percent-encoding so patterns like %27 (apostrophe) are caught
	const decoded = decodeURIComponent(url.pathname + url.search);

	// Scan request body — clone so the original readable stream stays intact
	let bodyText = '';
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		try {
			bodyText = await request.clone().text();
		} catch {
			// Binary or empty body — skip body scan, URL-only check still runs
		}
	}

	// Path traversal check: encoded dots OR path outside the known API root
	const pathname = url.pathname;
	const isEncodedTraversal = PATH_TRAVERSAL.test(url.href);
	const isEscapedRoot = !VALID_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));

	if (isEncodedTraversal || isEscapedRoot) {
		return new Response(
			JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }),
			{ status: 403, headers: { 'Content-Type': 'application/json' } },
		);
	}

	if (SQL_INJECTION_PATTERN.test(decoded)) {
		console.warn(JSON.stringify({
			level: 'warn', type: 'WAF_BLOCK', reason: 'sql_injection',
			path: url.pathname, ip: request.headers.get('CF-Connecting-IP') ?? 'unknown',
		}));
		return new Response(
			JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }),
			{ status: 403, headers: { 'Content-Type': 'application/json' } },
		);
	}

	if (XSS_PATTERN.test(decoded) || XSS_PATTERN.test(bodyText)) {
		console.warn(JSON.stringify({
			level: 'warn', type: 'WAF_BLOCK', reason: 'xss',
			path: url.pathname, ip: request.headers.get('CF-Connecting-IP') ?? 'unknown',
		}));
		return new Response(
			JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }),
			{ status: 403, headers: { 'Content-Type': 'application/json' } },
		);
	}

	return null;
}
