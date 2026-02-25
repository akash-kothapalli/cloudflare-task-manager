// =============================================================================
// controllers/tag.controller.ts  — NEW FILE
// Handles GET/POST/DELETE for /tags endpoints.
// =============================================================================

import * as tagService from '../services/tag.service';
import { validateCreateTagInput } from '../utils/validation';
import { ok, created, badRequest } from '../utils/response';
import type { AuthContext } from '../middleware/auth.middleware';
import type { Env } from '../types/env.types';

// GET /tags
export async function handleGetTags(env: Env, auth: AuthContext): Promise<Response> {
	const tags = await tagService.getUserTags(env.DB, auth.userId);
	return ok(tags);
}

// POST /tags
export async function handleCreateTag(request: Request, env: Env, auth: AuthContext): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return badRequest('Request body must be valid JSON');
	}

	const validation = validateCreateTagInput(body);
	if (!validation.ok) {
		return badRequest(validation.error);
	}

	const tag = await tagService.createTag(env.DB, auth.userId, validation.value);
	return created(tag);
}

// DELETE /tags/:id
export async function handleDeleteTag(id: number, env: Env, auth: AuthContext): Promise<Response> {
	await tagService.deleteTag(env.DB, auth.userId, id);
	return ok({ message: `Tag ${id} deleted successfully` });
}
