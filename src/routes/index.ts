// =============================================================================
// routes/index.ts  — Central router for all API endpoints
//
//   Each route:
//     1. Parses URL + method
//     2. Extracts path params (e.g. task id)
//     3. Runs requireAuth if the route is protected
//     4. Calls exactly one controller function
//     5. Returns the Response
//
//     — POST /auth/logout added.
//     No requireAuth middleware needed — the refresh token in the body IS the
//     proof of identity. An attacker without the token cannot logout the user.
// =============================================================================

import { requireAuth } from '../middleware/auth.middleware';
import { notFound } from '../utils/response';
import {
	registerController,
	loginController,
	getMeController,
	verifyOtpController,
	resendOtpController,
	forgotPasswordController,
	resetPasswordController,
	refreshController,
	logoutController,
} from '../controllers/auth.controller';
import {
	handleGetAllTasks,
	handleGetTaskById,
	handleCreateTask,
	handleUpdateTask,
	handleDeleteTask,
} from '../controllers/task.controller';
import {
	handleGetTags,
	handleCreateTag,
	handleUpdateTag,
	handleDeleteTag,
} from '../controllers/tag.controller';
import type { Env } from '../types/env.types';

// ─── parseId ─────────────────────────────────────────────────────────────────
// Converts a URL path segment to a positive integer.
// Returns null for anything non-numeric, zero, or negative.
// Used for /tasks/:id and /tags/:id routes.

function parseId(segment: string | undefined): number | null {
	if (!segment) return null;
	const n = parseInt(segment, 10);
	return Number.isInteger(n) && n > 0 ? n : null;
}

// ─── router ───────────────────────────────────────────────────────────────────

export async function router(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url      = new URL(request.url);
	const method   = request.method;
	const path     = url.pathname;
	const segments = path.split('/');
	const seg1     = segments[1]; // e.g. "auth", "tasks", "tags", "health"
	const seg2     = segments[2]; // e.g. "login", "123", undefined

	// ── Health ────────────────────────────────────────────────────────────────
	// Public — no auth required. Used by uptime monitors and deploy checks.
	if (path === '/health' && method === 'GET') {
		return new Response(
			JSON.stringify({
				success: true,
				data: { status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' },
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);
	}

	// ── Auth ──────────────────────────────────────────────────────────────────
	// Mix of public routes (register, login, otp flows) and one protected route (me).
	// logout is public in the sense that it does not need requireAuth — the
	// refresh token in the body serves as the credential.
	if (seg1 === 'auth') {
		if (seg2 === 'register'        && method === 'POST') return registerController(request, env);
		if (seg2 === 'login'           && method === 'POST') return loginController(request, env);
		if (seg2 === 'verify-otp'      && method === 'POST') return verifyOtpController(request, env);
		if (seg2 === 'resend-otp'      && method === 'POST') return resendOtpController(request, env);
		if (seg2 === 'forgot-password' && method === 'POST') return forgotPasswordController(request, env);
		if (seg2 === 'reset-password'  && method === 'POST') return resetPasswordController(request, env);
		if (seg2 === 'refresh'         && method === 'POST') return refreshController(request, env);

		//  — logout route
		// WHY no requireAuth here: the refresh token in the body is the credential.
		// requireAuth checks the access token (Authorization header) which may
		// already be expired when the user calls logout — that is a valid scenario.
		// The controller verifies the refresh token signature itself.
		if (seg2 === 'logout' && method === 'POST') return logoutController(request, env);

		if (seg2 === 'me' && method === 'GET') {
			const auth = await requireAuth(request, env);
			if (auth instanceof Response) return auth;
			return getMeController(auth, env);
		}

		return notFound(`Auth route not found: ${method} /auth/${seg2}`);
	}

	// ── Tasks ─────────────────────────────────────────────────────────────────
	// All task routes require authentication.
	// ctx passed to handleCreateTask so AI enrichment can use ctx.waitUntil().
	if (seg1 === 'tasks') {
		const auth = await requireAuth(request, env);
		if (auth instanceof Response) return auth;

		if (!seg2) {
			if (method === 'GET')  return handleGetAllTasks(request, env, auth);
			if (method === 'POST') return handleCreateTask(request, env, auth, ctx);
		}

		const id = parseId(seg2);
		if (id === null) {
			return new Response(
				JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: 'Task ID must be a positive integer' } }),
				{ status: 400, headers: { 'Content-Type': 'application/json' } },
			);
		}

		if (method === 'GET')    return handleGetTaskById(id, env, auth);
		if (method === 'PATCH')  return handleUpdateTask(id, request, env, auth, ctx);
		if (method === 'DELETE') return handleDeleteTask(id, env, auth);
	}

	// ── Tags ──────────────────────────────────────────────────────────────────
	// All tag routes require authentication.
	if (seg1 === 'tags') {
		const auth = await requireAuth(request, env);
		if (auth instanceof Response) return auth;

		if (!seg2) {
			if (method === 'GET')  return handleGetTags(env, auth);
			if (method === 'POST') return handleCreateTag(request, env, auth);
		}

		const id = parseId(seg2);
		if (id === null) {
			return new Response(
				JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: 'Tag ID must be a positive integer' } }),
				{ status: 400, headers: { 'Content-Type': 'application/json' } },
			);
		}

		if (method === 'PATCH')  return handleUpdateTag(id, request, env, auth);
		if (method === 'DELETE') return handleDeleteTag(id, env, auth);
	}

	return notFound(`Route not found: ${method} ${path}`);
}
