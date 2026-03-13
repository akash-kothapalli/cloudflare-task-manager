// =============================================================================
// services/otp.service.ts
//
//   Email OTP flow:
//     1. generateAndStoreOtp  — creates 6-digit OTP, stores in KV with 10-min TTL
//     2. sendOtpEmail         — sends OTP via Cloudflare Email Workers (or logs in dev)
//     3. verifyOtp            — checks KV, returns true and deletes key if valid
//
//   KV key format: "otp:{email}"
//   KV value:      OTP string (6 digits)
//   KV TTL:        600 seconds (10 minutes)
//
//   Security notes:
//     - OTP is deleted after first successful use (single-use)
//     - OTP is cryptographically random via Web Crypto API
//     - Brute force is limited by rate limiter (60 req/min)
//     - Timing-safe comparison prevents side-channel leaks
// =============================================================================

import type { Env } from '../types/env.types';

const OTP_TTL = 600; // 10 minutes in seconds
const OTP_DIGITS = 6;

// ─── Generate & Store ─────────────────────────────────────────────────────────

/**
 * Generates a cryptographically random 6-digit OTP and stores it in KV.
 * Overwrites any existing OTP for this email (re-send flow).
 */
export async function generateAndStoreOtp(cache: KVNamespace, email: string): Promise<string> {
	const array = new Uint32Array(1);
	crypto.getRandomValues(array);

	// DataView avoids the TypeScript strict-mode "possibly undefined" on array[0]
	const randomValue = new DataView(array.buffer).getUint32(0, true);
	const otp = String(randomValue % 1_000_000).padStart(OTP_DIGITS, '0');

	await cache.put(`otp:${email.toLowerCase()}`, otp, { expirationTtl: OTP_TTL });

	return otp;
}

// ─── Verify ───────────────────────────────────────────────────────────────────

/**
 * Verifies the OTP for a given email.
 * Returns true if valid. Deletes the KV key on success (single-use).
 */
export async function verifyOtp(cache: KVNamespace, email: string, inputOtp: string): Promise<boolean> {
	const key = `otp:${email.toLowerCase()}`;
	const stored = await cache.get(key);

	if (!stored) return false;

	const isValid = timingSafeEqual(stored, inputOtp.trim());

	if (isValid) {
		await cache.delete(key);
	}

	return isValid;
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

// ─── Send Email ───────────────────────────────────────────────────────────────

/**
 * Sends OTP email via Brevo (https://brevo.com).
 * Free tier: 300 emails/day, sends to ANY email — no domain verification needed.
 * Falls back to console.log in dev when BREVO_API_KEY is not set.
 */
export async function sendOtpEmail(env: Env, email: string, otp: string, name: string): Promise<void> {
	if (!env.BREVO_API_KEY) {
		// Dev mode — OTP is already returned in the API response via auth.service.
		console.log(
			JSON.stringify({
				level: 'info',
				event: 'OTP_DEV',
				to: email,
				otp,
				note: 'Set BREVO_API_KEY secret to send real emails in production',
			}),
		);
		return;
	}

	const senderEmail = env.EMAIL_FROM ?? 'akashkothapalli95@gmail.com';
	const senderName = 'TaskFlow';

	const res = await fetch('https://api.brevo.com/v3/smtp/email', {
		method: 'POST',
		headers: {
			'api-key': env.BREVO_API_KEY,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			sender: { name: senderName, email: senderEmail },
			to: [{ email, name }],
			subject: `Your TaskFlow verification code: ${otp}`,
			textContent: buildTextEmail(name, otp),
			htmlContent: buildHtmlEmail(name, otp),
		}),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		console.error(JSON.stringify({ level: 'error', event: 'OTP_EMAIL_FAILED', status: res.status, body }));
		throw new Error('Failed to send verification email — please try again');
	}
}

// ─── Email Templates ──────────────────────────────────────────────────────────

function buildTextEmail(name: string, otp: string): string {
	return [
		`Hi ${name},`,
		'',
		`Your TaskFlow verification code is: ${otp}`,
		'',
		'This code expires in 10 minutes. Do not share it with anyone.',
		'',
		'If you did not request this, you can safely ignore this email.',
		'',
		'— The TaskFlow Team',
	].join('\n');
}

function buildHtmlEmail(name: string, otp: string): string {
	const digitSpans = otp
		.split('')
		.map(
			(d) =>
				`<span style="display:inline-block;width:44px;height:52px;line-height:52px;text-align:center;` +
				`background:#1c1c1e;border:1px solid #3f3f46;border-radius:8px;font-size:28px;` +
				`font-weight:700;color:#f97316;font-family:monospace;margin:0 4px;">${d}</span>`,
		)
		.join('');

	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:40px auto;background:#111113;border:1px solid #27272a;border-radius:16px;overflow:hidden;">
    <tr>
      <td style="padding:32px;text-align:center;border-bottom:1px solid #27272a;">
        <span style="font-size:22px;font-weight:800;color:#fafafa;letter-spacing:-0.03em;">
          Task<span style="color:#f97316;">Flow</span>
        </span>
      </td>
    </tr>
    <tr>
      <td style="padding:40px 32px;text-align:center;">
        <p style="color:#71717a;font-size:14px;margin:0 0 8px;">Hi ${escapeHtml(name)},</p>
        <h1 style="color:#fafafa;font-size:20px;font-weight:700;margin:0 0 24px;">Verify your email address</h1>
        <p style="color:#a1a1aa;font-size:14px;margin:0 0 32px;">Enter this code in the TaskFlow app to complete your registration:</p>
        <div style="margin:0 0 32px;">${digitSpans}</div>
        <p style="color:#71717a;font-size:12px;margin:0;">
          This code expires in <strong style="color:#fafafa;">10 minutes</strong>.
          Do not share it with anyone.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 32px;border-top:1px solid #27272a;text-align:center;">
        <p style="color:#3f3f46;font-size:11px;margin:0;">
          If you didn't create a TaskFlow account, you can safely ignore this email.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
