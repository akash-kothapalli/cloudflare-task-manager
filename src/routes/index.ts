// =============================================================================
// routes/index.ts  — Central router for all API endpoints
//
//   Clean router function — pure routing only.
//   Each route:
//     1. Parses the URL + method
//     2. Extracts any path params (e.g. id)
//     3. Runs auth if required
//     4. Calls one controller function
//     5. Returns the Response
//
//   All auth is via requireAuth — not inline in routes.
// =============================================================================


import { requireAuth } from '../middleware/auth.middleware';
import { notFound } from '../utils/response';
import {
	registerController, loginController, getMeController,
	verifyOtpController, resendOtpController, refreshController,
} from '../controllers/auth.controller';
import { handleGetAllTasks, handleGetTaskById, handleCreateTask, handleUpdateTask, handleDeleteTask } from '../controllers/task.controller';
import { handleGetTags, handleCreateTag, handleUpdateTag, handleDeleteTag } from '../controllers/tag.controller';
import type { Env } from '../types/env.types';

function parseId(segment: string | undefined): number | null {
	if (!segment) return null;
	const n = parseInt(segment, 10);
	return Number.isInteger(n) && n > 0 ? n : null;
}

export async function router(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const method = request.method;
	const path = url.pathname;
	const segments = path.split('/');
	const seg1 = segments[1];
	const seg2 = segments[2];

	// ── Health ────────────────────────────────────────────────────────────────
	if (path === '/health' && method === 'GET') {
		return new Response(
			JSON.stringify({ success: true, data: { status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' } }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);
	}

	// ── Auth ──────────────────────────────────────────────────────────────────
	if (seg1 === 'auth') {
		if (seg2 === 'register'   && method === 'POST') return registerController(request, env);
		if (seg2 === 'login'      && method === 'POST') return loginController(request, env);
		if (seg2 === 'verify-otp' && method === 'POST') return verifyOtpController(request, env);
		if (seg2 === 'resend-otp' && method === 'POST') return resendOtpController(request, env);
		if (seg2 === 'refresh'    && method === 'POST') return refreshController(request, env);

		if (seg2 === 'me' && method === 'GET') {
			const auth = await requireAuth(request, env);
			if (auth instanceof Response) return auth;
			return getMeController(auth, env);
		}
		return notFound(`Auth route not found: ${method} /auth/${seg2}`);
	}

	// ── Tasks ─────────────────────────────────────────────────────────────────
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
		if (method === 'PATCH')  return handleUpdateTask(id, request, env, auth);
		if (method === 'DELETE') return handleDeleteTask(id, env, auth);
	}

	// ── Tags ──────────────────────────────────────────────────────────────────
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
