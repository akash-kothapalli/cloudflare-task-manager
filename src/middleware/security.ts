// =============================================================================
// middleware/security.ts
//
//   1. addSecurityHeaders  — full header set (CSP, HSTS, referrer, permissions)
//   2. handleCors          — CORS preflight for OPTIONS + headers on all responses
//   3. checkRateLimit      — sliding window counter stored in KV, 60 req/min/IP
//   4. detectMaliciousInput — WAF-style pattern scan: SQLi, XSS, path traversal
// =============================================================================

import { tooManyRequests, preflight } from '../utils/response';
import type { Env } from '../types/env.types';

// ─── 1. Security headers ──────────────────────────────────────────────────────
// Returns a NEW Response with all security headers added.
// WHY new Response: Workers Response objects are immutable once created by fetch.
// Calling .set() on a frozen response silently does nothing.

export function addSecurityHeaders(response: Response): Response {
	const newHeaders = new Headers(response.headers);

	// Prevents MIME-type sniffing — browser must honour Content-Type
	newHeaders.set('X-Content-Type-Options', 'nosniff');

	// Stops the page being embedded in an iframe (clickjacking defence)
	newHeaders.set('X-Frame-Options', 'DENY');

	// Legacy XSS filter — modern browsers use CSP instead, but kept for older browsers
	newHeaders.set('X-XSS-Protection', '1; mode=block');

	// Forces HTTPS for 2 years, includes subdomains
	newHeaders.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');

	// Content Security Policy — API only serves JSON, no scripts or styles needed
	newHeaders.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

	// Controls how much referrer info is sent — origin only on cross-origin requests
	newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');

	// Opt out of browser features we don't use
	newHeaders.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

	// Remove Server header — don't advertise what we're running
	newHeaders.delete('Server');

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	});
}

// ─── 2. CORS ──────────────────────────────────────────────────────────────────
// Returns a preflight response for OPTIONS, or null to continue the request.

export function handleCors(request: Request): Response | null {
	if (request.method === 'OPTIONS') {
		return preflight(); // 204 with CORS headers — defined in response.ts
	}
	return null; // not a preflight — continue
}

// ─── 3. Rate limiting ─────────────────────────────────────────────────────────
// Sliding window: 60 requests per minute per IP, stored in KV.
//
// KV key format: "rl:{ip}"
// KV value:      request count as string
// KV TTL:        60 seconds (auto-expires — no cleanup needed)
//
// WHY KV for rate limiting:
//   KV reads are ~1ms globally. Perfect for hot counters.
//   D1 would add unnecessary SQL overhead for every request.

const RATE_LIMIT_MAX = 60; // requests
const RATE_LIMIT_WINDOW = 60; // seconds

export async function checkRateLimit(request: Request, cache: KVNamespace): Promise<Response | null> {
	// Use Cloudflare's real client IP header — not X-Forwarded-For which can be spoofed
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
	const key = `rl:${ip}`;

	const current = await cache.get(key);
	const count = current ? parseInt(current, 10) : 0;

	if (count >= RATE_LIMIT_MAX) {
		return tooManyRequests(RATE_LIMIT_WINDOW);
	}

	// Increment counter — reset TTL each time so window slides
	await cache.put(key, String(count + 1), {
		expirationTtl: RATE_LIMIT_WINDOW,
	});

	return null; // not rate limited — continue
}

// ─── 4. WAF — Malicious input detection ──────────────────────────────────────
// Pattern-based scan of URL path + query string.
// Not a replacement for a real WAF (use Cloudflare WAF rules for production),
// but demonstrates security awareness at the HTTP layer.
//
// Detects:
//   SQLi          — UNION SELECT, comment sequences, quote escapes
//   XSS           — <script>, javascript: URLs, event handlers
//   Path traversal — ../ sequences trying to escape the app root

const SQL_INJECTION_PATTERN = /(\bunion\b.*\bselect\b|'\s*(or|and)\s*'|--(?:\s|$)|\/\*|\*\/|;\s*drop|;\s*delete|;\s*insert|xp_|exec\s*\()/i;
const XSS_PATTERN = /(<script|javascript:|on\w+\s*=|<\s*img[^>]*onerror|<iframe|<object|<embed)/i;
const PATH_TRAVERSAL = /(%2e%2e[/\\]|[/\\]%2e%2e)/i; // encoded dots — literal "../" is normalised away by Request() before the Worker sees it
const VALID_PATH_PREFIXES = ['/tasks', '/tags', '/auth', '/health']; // all known API routes

export async function detectMaliciousInput(request: Request): Promise<Response | null> {
	const url = new URL(request.url);
	// Decode percent-encoding so patterns like %27 (') are caught by SQLi regex
	const decoded = decodeURIComponent(url.pathname + url.search);

	// Also scan request body for XSS — clone so the original stream stays intact
	let bodyText = '';
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		try {
			bodyText = await request.clone().text();
		} catch {
			// Body unreadable — skip body scan, continue with URL-only check
		}
	}

	// Detect path traversal two ways:
	//   1. Percent-encoded dots (%2e%2e) — literal "../" is normalised away by the
	//      Request constructor before the Worker receives request.url, but encoded
	//      variants survive and can still be exploited.
	//   2. Normalised path escapes the known API root — e.g. /tasks/../../../etc/passwd
	//      normalises to /etc/passwd which doesn't match any valid prefix.
	const pathname = url.pathname;
	const isEncodedTraversal = PATH_TRAVERSAL.test(url.href);
	const isEscapedRoot = !VALID_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
	if (isEncodedTraversal || isEscapedRoot) {
		return new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (SQL_INJECTION_PATTERN.test(decoded)) {
		console.warn(
			JSON.stringify({
				level: 'warn',
				type: 'WAF_BLOCK',
				reason: 'sql_injection',
				path: url.pathname,
				ip: request.headers.get('CF-Connecting-IP') ?? 'unknown',
			}),
		);
		return new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (XSS_PATTERN.test(decoded) || XSS_PATTERN.test(bodyText)) {
		console.warn(
			JSON.stringify({
				level: 'warn',
				type: 'WAF_BLOCK',
				reason: 'xss',
				path: url.pathname,
			}),
		);
		return new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	return null; // clean — continue
}
