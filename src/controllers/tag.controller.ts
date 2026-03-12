// =============================================================================
// controllers/tag.controller.ts
// =============================================================================

import * as tagService from '../services/tag.service';
import { validateCreateTagInput } from '../utils/validation';
import { ok, created, badRequest } from '../utils/response';
import type { AuthContext } from '../middleware/auth.middleware';
import type { Env } from '../types/env.types';

// GET /tags
export async function handleGetTags(env: Env, auth: AuthContext): Promise<Response> {
	return ok(await tagService.getUserTags(env.DB, auth.userId));
}

// POST /tags
export async function handleCreateTag(request: Request, env: Env, auth: AuthContext): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }

	const validation = validateCreateTagInput(body);
	if (!validation.ok) return badRequest(validation.error);

	return created(await tagService.createTag(env.DB, auth.userId, validation.value));
}

// PATCH /tags/:id  — rename and/or recolor an existing tag
export async function handleUpdateTag(id: number, request: Request, env: Env, auth: AuthContext): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }

	if (typeof body !== 'object' || body === null) return badRequest('Request body must be a JSON object');
	const b = body as Record<string, unknown>;

	const input: { name?: string; color?: string } = {};

	if ('name' in b) {
		if (typeof b.name !== 'string' || !b.name.trim()) return badRequest('name must be a non-empty string');
		input.name = b.name.trim();
	}
	if ('color' in b) {
		if (typeof b.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.color)) return badRequest('color must be a valid hex colour (e.g. #6366f1)');
		input.color = b.color;
	}
	if (Object.keys(input).length === 0) return badRequest('Provide at least one field to update: name or color');

	return ok(await tagService.updateTag(env.DB, auth.userId, id, input));
}

// DELETE /tags/:id
export async function handleDeleteTag(id: number, env: Env, auth: AuthContext): Promise<Response> {
	await tagService.deleteTag(env.DB, auth.userId, id);
	return ok({ message: `Tag ${id} deleted successfully` });
}
