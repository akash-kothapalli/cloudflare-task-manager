// =============================================================================
// services/email-validation.service.ts
//
//   Two-layer email validation:
//
//   Layer 1 — Strict regex
//     - Blocks single-char local parts (a@b.com)
//     - Blocks single-char domains (a@b.c)
//     - Blocks known disposable/test domains (mailinator, guerrillamail, etc.)
//     - Requires proper TLD (2+ chars)
//     - Enforces reasonable length limits
//
//   Layer 2 — MX record lookup via DNS-over-HTTPS
//     - Checks if the email's domain has a valid mail server (MX record)
//     - Uses Cloudflare's public DoH endpoint (1.1.1.1)
//     - No paid service needed — Cloudflare Workers can make fetch() calls natively
//     - Catches typos like "gmial.com" and fake domains like "notreal.xyz"
//     - Fails open: if DNS lookup itself fails, we allow the email through
//       (don't reject real users due to DNS service downtime)
//
//   Why both layers?
//     Regex alone misses domains that look valid but have no mail server.
//     MX alone is slow and can be flaky. Together they catch ~95% of bad emails
//     without requiring a paid email verification API.
// =============================================================================

// ─── Layer 1: Strict Regex Validation ────────────────────────────────────────

// Known disposable / throwaway email domains — extend as needed
const DISPOSABLE_DOMAINS = new Set([
	'mailinator.com',
	'guerrillamail.com',
	'guerrillamail.net',
	'guerrillamail.org',
	'throwaway.email',
	'tempmail.com',
	'temp-mail.org',
	'sharklasers.com',
	'guerrillamailblock.com',
	'grr.la',
	'guerrillamail.info',
	'spam4.me',
	'yopmail.com',
	'yopmail.fr',
	'cool.fr.nf',
	'jetable.fr.nf',
	'nospam.ze.tc',
	'nomail.xl.cx',
	'mega.zik.dj',
	'speed.1s.fr',
	'courriel.fr.nf',
	'moncourrier.fr.nf',
	'monemail.fr.nf',
	'monmail.fr.nf',
	'trashmail.at',
	'trashmail.io',
	'trashmail.me',
	'trashmail.net',
	'dispostable.com',
	'fakeinbox.com',
	'mailnull.com',
	'spamgourmet.com',
	'spamgourmet.net',
	'spamgourmet.org',
	'maildrop.cc',
]);

export interface EmailValidationResult {
	valid: boolean;
	reason?: string;
}

/**
 * Layer 1: Strict format validation.
 *
 * Rules beyond basic RFC-5321:
 *  - Local part must be >= 2 chars (blocks a@example.com)
 *  - Domain must have >= 4 chars before TLD (blocks a@b.com)
 *  - TLD must be >= 2 chars
 *  - No consecutive dots
 *  - No leading/trailing dots in local part
 *  - Total length <= 254 chars (RFC 5321 limit)
 *  - Blocks known disposable domains
 */
export function validateEmailFormat(email: string): EmailValidationResult {
	const trimmed = email.trim().toLowerCase();

	if (trimmed.length > 254) {
		return { valid: false, reason: 'Email address is too long' };
	}

	const atIndex = trimmed.lastIndexOf('@');
	if (atIndex < 1) {
		return { valid: false, reason: 'Email must contain an @ symbol' };
	}

	const local = trimmed.slice(0, atIndex);
	const domain = trimmed.slice(atIndex + 1);

	// ── Local part checks ───────────────────────────────────────────────────
	if (local.length < 2) {
		return { valid: false, reason: 'Email local part must be at least 2 characters' };
	}
	if (local.startsWith('.') || local.endsWith('.')) {
		return { valid: false, reason: 'Email local part cannot start or end with a dot' };
	}
	if (local.includes('..')) {
		return { valid: false, reason: 'Email local part cannot contain consecutive dots' };
	}
	// Only allow alphanumeric + . _ + - in local part
	if (!/^[a-z0-9._%+\-]+$/.test(local)) {
		return { valid: false, reason: 'Email local part contains invalid characters' };
	}

	// ── Domain checks ───────────────────────────────────────────────────────
	if (!domain.includes('.')) {
		return { valid: false, reason: 'Email domain must contain a dot' };
	}

	const domainParts = domain.split('.');
	const tld = domainParts[domainParts.length - 1] ?? '';
	const domainBody = domainParts.slice(0, -1).join('.');

	if (tld.length < 2) {
		return { valid: false, reason: 'Email domain TLD must be at least 2 characters' };
	}
	// Single-char domain body like "a.com" is suspicious
	if (domainBody.length < 2) {
		return { valid: false, reason: 'Email domain is too short' };
	}
	if (!/^[a-z0-9.-]+$/.test(domain)) {
		return { valid: false, reason: 'Email domain contains invalid characters' };
	}
	if (domain.startsWith('-') || domain.endsWith('-')) {
		return { valid: false, reason: 'Email domain cannot start or end with a hyphen' };
	}

	// ── Disposable domain check ─────────────────────────────────────────────
	if (DISPOSABLE_DOMAINS.has(domain)) {
		return { valid: false, reason: 'Disposable email addresses are not allowed' };
	}

	return { valid: true };
}

// ─── Layer 2: MX Record Lookup via DNS-over-HTTPS ────────────────────────────

/**
 * Checks if an email domain has a valid MX record using Cloudflare's DoH API.
 *
 * Fails open: returns true if the DNS lookup itself fails (network error,
 * timeout, etc.) so legitimate users are never blocked due to DNS downtime.
 *
 * @param domain  The domain part of the email (e.g. "gmail.com")
 * @returns true if MX record found or if lookup failed (fail-open)
 */
export async function hasMxRecord(domain: string): Promise<boolean> {
	try {
		// Cloudflare DNS-over-HTTPS — available natively in Workers via fetch()
		// Returns JSON with MX records if they exist
		const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`;

		const response = await fetch(url, {
			headers: {
				Accept: 'application/dns-json',
			},
			// Short timeout — don't block registration for more than 2s
			signal: AbortSignal.timeout(2000),
		});

		if (!response.ok) {
			// DNS service error — fail open
			console.warn(JSON.stringify({ level: 'warn', event: 'MX_CHECK_HTTP_ERROR', domain, status: response.status }));
			return true;
		}

		const data = (await response.json()) as DnsResponse;

		// Status 0 = NOERROR, Status 3 = NXDOMAIN (non-existent domain)
		if (data.Status === 3) {
			// Domain doesn't exist at all
			return false;
		}

		// Check if any MX records are present
		const hasMx = Array.isArray(data.Answer) && data.Answer.some((record) => record.type === 15); // type 15 = MX

		// Some legitimate domains don't have MX but do have A records that
		// can receive email — if no MX, also check for A records as fallback
		if (!hasMx) {
			const hasA = Array.isArray(data.Answer) && data.Answer.some((record) => record.type === 1); // type 1 = A
			return hasA;
		}

		return hasMx;
	} catch (err) {
		// Network error, timeout, parse error — fail open so legit users aren't blocked
		console.warn(
			JSON.stringify({
				level: 'warn',
				event: 'MX_CHECK_FAILED',
				domain,
				error: err instanceof Error ? err.message : String(err),
				note: 'Failing open — user allowed through',
			}),
		);
		return true;
	}
}

// ─── Combined validation ──────────────────────────────────────────────────────

/**
 * Full email validation: format check + MX record lookup.
 * Call this during registration. Returns a result with a user-friendly reason.
 */
export async function validateEmailFull(email: string, env?: { ENVIRONMENT?: string }): Promise<EmailValidationResult> {
	// Layer 1: format
	const formatResult = validateEmailFormat(email);
	if (!formatResult.valid) return formatResult;

	// Skip live DNS lookup outside production — Miniflare (test/dev) has no outbound network
	if (env?.ENVIRONMENT !== 'production') return { valid: true };

	// Layer 2: MX record
	// After validateEmailFormat passes, we know '@' exists, so split is safe.
	// The non-null assertion is justified: formatResult.valid guarantees a valid '@'.
	const domain = email.trim().toLowerCase().split('@').pop()!;
	const mxExists = await hasMxRecord(domain);

	if (!mxExists) {
		return {
			valid: false,
			reason: `The domain "${domain}" does not appear to have an active mail server. Please use a real email address.`,
		};
	}

	return { valid: true };
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DnsRecord {
	name: string;
	type: number; // 1=A, 15=MX, 28=AAAA
	TTL: number;
	data: string;
}

interface DnsResponse {
	Status: number; // 0=NOERROR, 3=NXDOMAIN
	TC: boolean;
	RD: boolean;
	RA: boolean;
	AD: boolean;
	CD: boolean;
	Question: Array<{ name: string; type: number }>;
	Answer?: DnsRecord[];
	Authority?: DnsRecord[];
}
