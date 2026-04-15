// =============================================================================
// controllers/task.controller.ts
//   - Every handler receives AuthContext — userId always available
//   - PATCH replaces PUT — partial updates only
//   - GET /tasks supports ?status, ?priority, ?search, ?due_before, ?page,
//     ?limit, ?tag_id 
//   - All validation via utils/validation.ts
//   - All responses via utils/response.ts typed helpers
//
//   handleUpdateTask now passes env and ctx to updateTask so the
//   service can trigger AI enrichment on tasks that have no summary yet.
//   tag_id query param extracted and passed through to service.
// =============================================================================

import * as taskService from '../services/task.service';
import { validateCreateTaskInput, validateUpdateTaskInput, parsePositiveInt } from '../utils/validation';
import { ok, created, badRequest } from '../utils/response';
import type { AuthContext } from '../middleware/auth.middleware';
import type { Env } from '../types/env.types';
import type { TaskStatus, TaskPriority, TaskQueryParams } from '../types/task.types';
import { TASK_STATUSES, TASK_PRIORITIES } from '../types/task.types';

// ─── GET /tasks ───────────────────────────────────────────────────────────────

export async function handleGetAllTasks(request: Request, env: Env, auth: AuthContext): Promise<Response> {
	const url = new URL(request.url);

	const statusParam   = url.searchParams.get('status');
	const priorityParam = url.searchParams.get('priority');
	const tagIdParam    = url.searchParams.get('tag_id');   

	if (statusParam && !TASK_STATUSES.includes(statusParam as TaskStatus)) {
		return badRequest(`status must be one of: ${TASK_STATUSES.join(', ')}`);
	}
	if (priorityParam && !TASK_PRIORITIES.includes(priorityParam as TaskPriority)) {
		return badRequest(`priority must be one of: ${TASK_PRIORITIES.join(', ')}`);
	}

	// Validate tag_id is a positive integer if provided
	let tagId: number | undefined;
	if (tagIdParam !== null) {
		const parsed = parseInt(tagIdParam, 10);
		if (!Number.isInteger(parsed) || parsed < 1) {
			return badRequest('tag_id must be a positive integer');
		}
		tagId = parsed;
	}

	const params: TaskQueryParams = {
		status:     (statusParam   as TaskStatus   | undefined) ?? undefined,
		priority:   (priorityParam as TaskPriority | undefined) ?? undefined,
		due_before: url.searchParams.get('due_before') ?? undefined,
		search:     url.searchParams.get('search')     ?? undefined,
		page:       parsePositiveInt(url.searchParams.get('page'),  1),
		limit:      parsePositiveInt(url.searchParams.get('limit'), 20, 100),
		tag_id:     tagId,   
	};

	const result = await taskService.getAllTasks(env.DB, env.CACHE, auth.userId, params);

	return ok(result.tasks, {
		page:    result.page,
		limit:   result.limit,
		total:   result.total,
		hasMore: result.page * result.limit < result.total,
	});
}

// ─── GET /tasks/:id ───────────────────────────────────────────────────────────

export async function handleGetTaskById(id: number, env: Env, auth: AuthContext): Promise<Response> {
	const task = await taskService.getTaskById(env.DB, env.CACHE, id, auth.userId);
	return ok(task);
}

// ─── POST /tasks ──────────────────────────────────────────────────────────────

export async function handleCreateTask(
	request: Request,
	env: Env,
	auth: AuthContext,
	ctx: ExecutionContext,
): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }

	const validation = validateCreateTaskInput(body);
	if (!validation.ok) return badRequest(validation.error);

	const task = await taskService.createTask(env, auth.userId, validation.value, ctx);
	return created(task);
}

// ─── PATCH /tasks/:id ────────────────────────────────────────────────────────
// WHY PATCH not PUT:
//   PUT = full replacement (must send all fields, missing fields get cleared).
//   PATCH = partial update (only send what changes).
//   For a task manager, partial update is almost always what clients want.
//
// ctx and env are now passed to updateTask so the service can
// trigger AI enrichment via ctx.waitUntil() for tasks with no summary yet.

export async function handleUpdateTask(
	id: number,
	request: Request,
	env: Env,
	auth: AuthContext,
	ctx: ExecutionContext,  //  added so service can call ctx.waitUntil
): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return badRequest('Request body must be valid JSON'); }

	const validation = validateUpdateTaskInput(body);
	if (!validation.ok) return badRequest(validation.error);

	//  env and ctx passed so updateTask can trigger AI enrichment
	const task = await taskService.updateTask(
		env.DB,
		env.CACHE,
		id,
		auth.userId,
		validation.value,
		env,   
		ctx,   
	);

	return ok(task);
}

// ─── DELETE /tasks/:id ────────────────────────────────────────────────────────

export async function handleDeleteTask(id: number, env: Env, auth: AuthContext): Promise<Response> {
	await taskService.deleteTask(env.DB, env.CACHE, id, auth.userId);
	return ok({ message: `Task ${id} deleted successfully` });
}
