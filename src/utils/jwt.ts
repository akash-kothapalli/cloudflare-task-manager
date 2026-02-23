import { SignJWT, jwtVerify, JWTPayload } from "jose";
import { Env } from "../types/env.types";

export async function generateToken(
  payload: JWTPayload,
  env: Env
) {
  const secret = new TextEncoder().encode(env.JWT_SECRET);

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
}

export async function verifyToken(
  token: string,
  env: Env
) {
  const secret = new TextEncoder().encode(env.JWT_SECRET);

  const { payload } = await jwtVerify(token, secret);
  return payload;
}

// ─────────────────────────────────────────────────────────────
// Password hashing — Web Crypto PBKDF2
// WHY: bcryptjs uses Node.js crypto module which does not exist
//      in Cloudflare Workers V8 runtime. Web Crypto (crypto.subtle)
//      is natively available in every Worker with zero dependencies.
//
// HOW: PBKDF2-SHA256 with 100,000 iterations + 16-byte random salt.
//      Result stored as "saltHex:hashHex" — self-contained string.
// ─────────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  // 1. Generate a cryptographically random 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 2. Import the raw password as a key material for PBKDF2
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,           // not extractable
    ["deriveBits"]
  );

  // 3. Derive 256 bits using PBKDF2-SHA256, 100k iterations
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name:       "PBKDF2",
      salt:       salt,
      iterations: 100_000,
      hash:       "SHA-256",
    },
    keyMaterial,
    256  // bits
  );

  // 4. Convert both salt and hash to hex strings
  const toHex = (buf: ArrayBuffer) =>
    Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

  return `${toHex(salt.buffer)}:${toHex(hashBuffer)}`;
}

export async function verifyPassword(
  password: string,
  stored: string   // format: "saltHex:hashHex"
): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");

  if (!saltHex || !hashHex) return false;

  // 1. Reconstruct the original salt bytes from hex
  const salt = new Uint8Array(
    saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16))
  );

  // 2. Derive bits from the candidate password using same salt + params
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name:       "PBKDF2",
      salt:       salt,
      iterations: 100_000,
      hash:       "SHA-256",
    },
    keyMaterial,
    256
  );

  // 3. Compare with stored hash — constant-time to prevent timing attacks
  const attempt = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time string compare: XOR every char, OR all differences
  // WHY: Early-exit comparison leaks password length via timing
  if (attempt.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < attempt.length; i++) {
    diff |= attempt.charCodeAt(i) ^ hashHex.charCodeAt(i);
  }
  return diff === 0;
}