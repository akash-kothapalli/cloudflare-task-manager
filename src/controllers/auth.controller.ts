// =============================================================================
// controllers/auth.controller.ts
//
// WHY REWRITE:
//   Old: used `error: any`, validated only email+password (no name),
//        returned inconsistent shapes from register vs login
//
// NEW:
//   - Uses central validation from utils/validation.ts — no inline logic
//   - No `any` anywhere — all errors properly typed and narrowed
//   - register and login both return AuthResponse: { token, user }
//   - GET /auth/me endpoint to fetch current user profile
//   - All responses use typed helpers from utils/response.ts
// =============================================================================

import { registerUser, loginUser, getProfile } from "../services/auth.service";
import { validateRegisterInput, validateLoginInput } from "../utils/validation";
import { ok, created, badRequest } from "../utils/response";
import type { AuthContext } from "../middleware/auth.middleware";
import type { Env } from "../types/env.types";

// ─── POST /auth/register ──────────────────────────────────────────────────────

export async function registerController(
  request: Request,
  env:     Env
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const validation = validateRegisterInput(body);
  if (!validation.ok) {
    return badRequest(validation.error);
  }

  // registerUser throws AppError — caught by withErrorHandling in index.ts
  const result = await registerUser(env.DB, env, validation.value);

  return created(result);
}

// ─── POST /auth/login ─────────────────────────────────────────────────────────

export async function loginController(
  request: Request,
  env:     Env
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const validation = validateLoginInput(body);
  if (!validation.ok) {
    return badRequest(validation.error);
  }

  const result = await loginUser(env.DB, env, validation.value);

  return ok(result);
}

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

export async function getMeController(
  auth: AuthContext,
  env:  Env
): Promise<Response> {
  const user = await getProfile(env.DB, auth.userId);
  return ok(user);
}
