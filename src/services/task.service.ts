// =============================================================================
// services/task.service.ts
//   - Every function receives userId — all queries are user-scoped
//   - Cache keys are per-user: "tasks:{userId}" not "all_tasks"
//   - Full CreateTaskInput / UpdateTaskInput support
//   - AI enrichment: called async after create/update (non-blocking)
//   - All errors are AppError instances
// =============================================================================

import * as taskRepo from '../repositories/task.repository';
import { updateAiFields } from '../repositories/task.repository';
import { AppError } from '../middleware/error-handler';
import type { Env } from '../types/env.types';
import type { TaskResponse, CreateTaskInput, UpdateTaskInput, TaskQueryParams } from '../types/task.types';
import type { FindAllResult } from '../repositories/task.repository';

// ─── Cache helpers ────────────────────────────────────────────────────────────
// Per-user cache keys — user A's cached list never contains user B's tasks.

const cacheKey = {
	list: (userId: number) => `tasks:${userId}`,
	item: (userId: number, taskId: number) => `task:${userId}:${taskId}`,
};

const CACHE_TTL = 60; // seconds

async function invalidateUserCache(cache: KVNamespace, userId: number, taskId?: number): Promise<void> {
	const deletes: Promise<void>[] = [cache.delete(cacheKey.list(userId))];
	if (taskId !== undefined) {
		deletes.push(cache.delete(cacheKey.item(userId, taskId)));
	}
	await Promise.all(deletes);
}

// ─── getAllTasks ──────────────────────────────────────────────────────────────

export async function getAllTasks(db: D1Database, cache: KVNamespace, userId: number, params: TaskQueryParams): Promise<FindAllResult> {
	// Only cache simple unpaged unfiltered requests
	const isSimple = !params.status && !params.priority && !params.search && !params.due_before;
	const page = params.page ?? 1;

	if (isSimple && page === 1) {
		const cached = await cache.get(cacheKey.list(userId));
		if (cached) {
			console.log(JSON.stringify({ level: 'info', event: 'cache_hit', key: cacheKey.list(userId) }));
			return JSON.parse(cached) as FindAllResult;
		}
	}

	const result = await taskRepo.findAll(db, userId, params);

	if (isSimple && page === 1) {
		await cache.put(cacheKey.list(userId), JSON.stringify(result), {
			expirationTtl: CACHE_TTL,
		});
	}

	return result;
}

// ─── getTaskById ──────────────────────────────────────────────────────────────

export async function getTaskById(db: D1Database, cache: KVNamespace, id: number, userId: number): Promise<TaskResponse> {
	const key = cacheKey.item(userId, id);
	const cached = await cache.get(key);

	if (cached) {
		console.log(JSON.stringify({ level: 'info', event: 'cache_hit', key }));
		return JSON.parse(cached) as TaskResponse;
	}

	const task = await taskRepo.findById(db, id, userId);

	if (!task) {
		throw AppError.notFound(`Task ${id} not found`);
	}

	await cache.put(key, JSON.stringify(task), { expirationTtl: CACHE_TTL });

	return task;
}

// ─── createTask ───────────────────────────────────────────────────────────────

export async function createTask(env: Env, userId: number, input: CreateTaskInput, ctx: ExecutionContext): Promise<TaskResponse> {
	const task = await taskRepo.create(env.DB, userId, input);

	// Invalidate user's task list cache
	await invalidateUserCache(env.CACHE, userId);

	// Kick off AI enrichment — non-blocking, client gets response immediately
	// ctx.waitUntil() is CRITICAL here.
	// Without it: Worker process is killed the moment the response is sent.
	// Any floating promise (like enrichWithAI) dies mid-execution.
	// That's why ai_summary stayed null — Llama-3 was called but the DB write
	// never completed because the Worker was already terminated.
	//
	// ctx.waitUntil() tells Cloudflare: "keep this Worker alive until
	// this promise resolves, even though the response has already been sent."
	ctx.waitUntil(
		enrichWithAI(env, userId, task.id, task.title, task.description).catch((err) => {
			console.error(JSON.stringify({ level: 'error', event: 'ai_enrich_failed', taskId: task.id, error: String(err) }));
		}),
	);

	return task;
}

// ─── updateTask ───────────────────────────────────────────────────────────────

export async function updateTask(
	db: D1Database,
	cache: KVNamespace,
	id: number,
	userId: number,
	input: UpdateTaskInput,
): Promise<TaskResponse> {
	const updated = await taskRepo.update(db, id, userId, input);

	if (!updated) {
		throw AppError.notFound(`Task ${id} not found`);
	}

	await invalidateUserCache(cache, userId, id);

	return updated;
}

// ─── deleteTask ───────────────────────────────────────────────────────────────

export async function deleteTask(db: D1Database, cache: KVNamespace, id: number, userId: number): Promise<void> {
	const deleted = await taskRepo.remove(db, id, userId);

	if (!deleted) {
		throw AppError.notFound(`Task ${id} not found`);
	}

	await invalidateUserCache(cache, userId, id);
}

// ─── Workers AI enrichment ────────────────────────────────────────────────────
// Uses Cloudflare Workers AI (Llama-3-8b) to generate a one-sentence summary
// and classify sentiment. Runs AFTER the response is sent — never delays the API.
//
// Prompt is kept short (Workers AI has token limits) and asks for JSON output
// so we can parse it deterministically.

async function enrichWithAI(env: Env, userId: number, taskId: number, title: string, description: string | null): Promise<void> {
	const content = [title, description].filter(Boolean).join('\n');

	const prompt = `Analyse this task and respond ONLY with valid JSON (no markdown, no explanation):
{"summary":"one sentence max 100 chars","sentiment":"positive|neutral|negative"}

Task: ${content}`;

	// Guard: AI binding may not be available in local dev/test environments
	if (!env.AI) {
		console.log(JSON.stringify({ level: 'info', event: 'ai_skipped', reason: 'AI binding not available', taskId }));
		return;
	}

	try {
		const result = (await env.AI.run('@cf/meta/llama-3-8b-instruct', {
			prompt,
			max_tokens: 256,
			stream: false,
		})) as { response?: string | { result?: { response?: string } } };

		// Workers AI SDK shape can vary by version:
		// v1: { response: "..." }
		// v2: { result: { response: "..." } }
		// Cast defensively and extract the string from whichever shape is present
		const aiResult = result as Record<string, unknown>;
		const responseStr =
			(aiResult.response as string | undefined) ??
			((aiResult.result as Record<string, unknown> | undefined)?.response as string | undefined) ??
			'';
		// Strip markdown code fences the model sometimes adds: ```json\n{...}\n```
		// Strip invisible chars (BOM \uFEFF, zero-width space \u200B) before matching
		const raw = responseStr
			.replace(/^\uFEFF/, '') // BOM
			.replace(/\u200B/g, '') // zero-width space
			.replace(/```json\s*/gi, '') // opening fence
			.replace(/```\s*$/g, '') // closing fence
			.trim();

		console.log(JSON.stringify({ level: 'info', event: 'ai_raw_response', taskId, raw: raw.slice(0, 200) }));

		// Extract JSON from the response — model sometimes adds surrounding text
		const match = raw.match(/\{[\s\S]*\}/);
		if (!match) {
			console.warn(JSON.stringify({ level: 'warn', event: 'ai_bad_response', raw }));
			return;
		}

		const parsed = JSON.parse(match[0]) as { summary?: string; sentiment?: string };

		const validSentiments = ['positive', 'neutral', 'negative'];
		const sentiment = validSentiments.includes(parsed.sentiment ?? '') ? parsed.sentiment! : 'neutral';

		const summary =
			typeof parsed.summary === 'string'
				? parsed.summary.slice(0, 200) // hard cap — DB column is TEXT but be safe
				: '';

		if (summary) {
			await updateAiFields(env.DB, taskId, userId, summary, sentiment);
			// Invalidate item cache so next read gets AI fields
			await env.CACHE.delete(cacheKey.item(userId, taskId));
			console.log(JSON.stringify({ level: 'info', event: 'ai_enriched', taskId, sentiment }));
		}
	} catch (err) {
		// AI enrichment is best-effort — a failure must not affect task data
		console.error(JSON.stringify({ level: 'error', event: 'ai_enrich_error', taskId, error: String(err) }));
	}
}
