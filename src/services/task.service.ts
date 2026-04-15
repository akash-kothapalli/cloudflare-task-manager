// =============================================================================
// services/task.service.ts
//
//   — AI enrichment improvements:
//
//   Problem 1 — Model content refusal (e.g. sensitive task titles like "Suicide")
//     Llama-3 safety filters return empty string or refusal text instead of JSON.
//     OLD: `if (!match) return;` — silently exits, summary stays null forever.
//     NEW: fallback summary generated from the task title itself, so every
//          task always gets an ai_summary regardless of model behaviour.
//
//   Problem 2 — Tasks created locally (wrangler dev) never get AI summary
//     env.AI is undefined in local dev — Workers AI needs production runtime.
//     OLD: silently skipped, summary stays null forever with no way to fix it.
//     NEW: enrichWithAI is now also called from updateTask when title or
//          description changes AND ai_summary is still null. This means:
//          - Edit a locally-created task on production → AI runs → summary saved.
//          - No re-enrichment if summary already exists (avoid wasting AI calls).
//
//   Problem 3 — Prompt was too vague, causing inconsistent JSON output
//     NEW: tighter system/user prompt structure with explicit JSON schema.
//          "respond ONLY with this exact JSON" reduces model hallucination.
//
//   Everything else unchanged — cache strategy, ctx.waitUntil, IDOR protection.
// =============================================================================

import * as taskRepo from '../repositories/task.repository';
import { updateAiFields } from '../repositories/task.repository';
import { AppError } from '../middleware/error-handler';
import type { Env } from '../types/env.types';
import type { TaskResponse, CreateTaskInput, UpdateTaskInput, TaskQueryParams } from '../types/task.types';
import type { FindAllResult } from '../repositories/task.repository';

// ─── Cache helpers ────────────────────────────────────────────────────────────
// Per-user cache keys — user A's cached list never contains user B's tasks.
// tag_id included in isSimple check so filtered results are not incorrectly cached.

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

export async function getAllTasks(
	db: D1Database,
	cache: KVNamespace,
	userId: number,
	params: TaskQueryParams,
): Promise<FindAllResult> {
	// Only cache page 1 with no filters applied — filtered results vary too much
	// to cache safely. tag_id filter added to isSimple check (Fix 9).
	const isSimple =
		!params.status &&
		!params.priority &&
		!params.search &&
		!params.due_before &&
		!params.tag_id;
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

export async function getTaskById(
	db: D1Database,
	cache: KVNamespace,
	id: number,
	userId: number,
): Promise<TaskResponse> {
	const key = cacheKey.item(userId, id);
	const cached = await cache.get(key);

	if (cached) {
		console.log(JSON.stringify({ level: 'info', event: 'cache_hit', key }));
		return JSON.parse(cached) as TaskResponse;
	}

	const task = await taskRepo.findById(db, id, userId);
	if (!task) throw AppError.notFound(`Task ${id} not found`);

	await cache.put(key, JSON.stringify(task), { expirationTtl: CACHE_TTL });
	return task;
}

// ─── createTask ───────────────────────────────────────────────────────────────

export async function createTask(
	env: Env,
	userId: number,
	input: CreateTaskInput,
	ctx: ExecutionContext,
): Promise<TaskResponse> {
	const task = await taskRepo.create(env.DB, userId, input);

	await invalidateUserCache(env.CACHE, userId);

	// ctx.waitUntil() keeps the Worker alive after the response is sent so
	// enrichWithAI can complete its DB write. Without this, the Worker is
	// killed the moment the HTTP response is sent and ai_summary stays null.
	ctx.waitUntil(
		enrichWithAI(env, userId, task.id, task.title, task.description).catch((err) => {
			console.error(JSON.stringify({
				level: 'error', event: 'ai_enrich_failed',
				taskId: task.id, error: String(err),
			}));
		}),
	);

	return task;
}

// ─── updateTask ───────────────────────────────────────────────────────────────
//  — now triggers AI enrichment when:
//   1. title or description changed (content changed → re-summarise)
//   2. AND ai_summary is currently null (task was created locally without AI)
//
// WHY condition 2?
//   We do not re-enrich tasks that already have a summary just because the
//   user made a small edit — that wastes AI quota and changes the summary
//   unexpectedly. But tasks with null summary (created in local dev) should
//   get enriched the first time they are edited on production.
//
// ctx is now required — needed for waitUntil if AI enrichment runs.

export async function updateTask(
	db: D1Database,
	cache: KVNamespace,
	id: number,
	userId: number,
	input: UpdateTaskInput,
	env: Env,
	ctx: ExecutionContext,
): Promise<TaskResponse> {
	const updated = await taskRepo.update(db, id, userId, input);
	if (!updated) throw AppError.notFound(`Task ${id} not found`);

	await invalidateUserCache(cache, userId, id);

	//  — enrich tasks that have no summary yet when content is edited
	const contentChanged = input.title !== undefined || 'description' in input;
	const needsEnrichment = updated.ai_summary === null;

	if (contentChanged && needsEnrichment) {
		ctx.waitUntil(
			enrichWithAI(env, userId, updated.id, updated.title, updated.description).catch((err) => {
				console.error(JSON.stringify({
					level: 'error', event: 'ai_enrich_on_update_failed',
					taskId: updated.id, error: String(err),
				}));
			}),
		);
	}

	return updated;
}

// ─── deleteTask ───────────────────────────────────────────────────────────────

export async function deleteTask(
	db: D1Database,
	cache: KVNamespace,
	id: number,
	userId: number,
): Promise<void> {
	const deleted = await taskRepo.remove(db, id, userId);
	if (!deleted) throw AppError.notFound(`Task ${id} not found`);
	await invalidateUserCache(cache, userId, id);
}

// ─── Workers AI enrichment ────────────────────────────────────────────────────
// Generates a one-sentence summary and sentiment for a task using Llama-3-8b.
// Runs AFTER the HTTP response is sent via ctx.waitUntil — never blocks the API.
//
//  changes:
//
//   1. Tighter prompt — explicit JSON schema in system role reduces the chance
//      of the model wrapping output in markdown or adding prose.
//
//   2. Fallback summary — when the model refuses (content safety) or returns
//      unparseable output, we generate a basic summary from the title itself.
//      This guarantees ai_summary is NEVER null after enrichWithAI runs.
//      Before: silent return → summary stays null.
//      After:  fallback stored → summary always populated.
//
//   3. Sentiment defaults to 'neutral' on refusal (was already the case,
//      but now explicitly documented as intentional).

async function enrichWithAI(
	env: Env,
	userId: number,
	taskId: number,
	title: string,
	description: string | null,
): Promise<void> {
	// Guard: Workers AI binding is undefined in local wrangler dev.
	// AI only runs on deployed production Workers (not local).
	if (!env.AI) {
		console.log(JSON.stringify({
			level: 'info', event: 'ai_skipped',
			reason: 'AI binding not available in local dev', taskId,
		}));
		return;
	}

	const content = [title, description].filter(Boolean).join('\n');

	//  — tighter prompt with explicit output schema.
	// The model is told exactly what shape to return and what NOT to do.
	// This reduces refusals on neutral content and reduces markdown wrapping.
	const prompt = `You are a task management assistant. Analyse the task below.
Respond ONLY with this exact JSON and nothing else — no markdown, no explanation:
{"summary":"one sentence describing the task, max 100 chars","sentiment":"positive|neutral|negative"}

Task title: ${title}${description ? `\nTask description: ${description}` : ''}`;

	try {
		const result = (await env.AI.run('@cf/meta/llama-3-8b-instruct', {
			prompt,
			max_tokens: 150,
			stream: false,
		})) as Record<string, unknown>;

		// Workers AI response shape varies by SDK version:
		// v1: { response: "..." }   v2: { result: { response: "..." } }
		const responseStr =
			(result.response as string | undefined) ??
			((result.result as Record<string, unknown> | undefined)?.response as string | undefined) ??
			'';

		// Strip BOM, zero-width spaces, and markdown code fences that
		// the model sometimes wraps around JSON output
		const raw = responseStr
			.replace(/^\uFEFF/, '')         // BOM
			.replace(/\u200B/g, '')          // zero-width space
			.replace(/```json\s*/gi, '')     // opening fence
			.replace(/```\s*$/g, '')         // closing fence
			.trim();

		console.log(JSON.stringify({
			level: 'info', event: 'ai_raw_response',
			taskId, raw: raw.slice(0, 200),
		}));

		// Try to extract JSON from the response — model sometimes adds prose
		const match = raw.match(/\{[\s\S]*\}/);

		//  — fallback when model refuses or returns bad output
		// Instead of silently returning (old behaviour), we generate a basic
		// summary from the task title so the field is never left null.
		if (!match) {
			console.warn(JSON.stringify({
				level: 'warn', event: 'ai_bad_response_using_fallback',
				taskId, raw: raw.slice(0, 100),
			}));

			// Fallback: truncate title to 100 chars as the summary
			const fallbackSummary = title.length > 100
				? title.slice(0, 97) + '...'
				: title;

			await updateAiFields(env.DB, taskId, userId, fallbackSummary, 'neutral');
			await env.CACHE.delete(cacheKey.item(userId, taskId));
			console.log(JSON.stringify({
				level: 'info', event: 'ai_fallback_stored', taskId,
			}));
			return;
		}

		let parsed: { summary?: string; sentiment?: string };
		try {
			parsed = JSON.parse(match[0]) as { summary?: string; sentiment?: string };
		} catch {
			// JSON.parse failed — malformed JSON from model — use fallback
			const fallbackSummary = title.length > 100 ? title.slice(0, 97) + '...' : title;
			await updateAiFields(env.DB, taskId, userId, fallbackSummary, 'neutral');
			await env.CACHE.delete(cacheKey.item(userId, taskId));
			console.warn(JSON.stringify({ level: 'warn', event: 'ai_json_parse_failed_using_fallback', taskId }));
			return;
		}

		const validSentiments = ['positive', 'neutral', 'negative'];
		const sentiment = validSentiments.includes(parsed.sentiment ?? '')
			? parsed.sentiment!
			: 'neutral';

		// Use AI summary if valid, otherwise fall back to title
		const summary =
			typeof parsed.summary === 'string' && parsed.summary.trim()
				? parsed.summary.trim().slice(0, 200)
				: title.slice(0, 100);  // Fix 7 — fallback instead of empty string

		await updateAiFields(env.DB, taskId, userId, summary, sentiment);
		await env.CACHE.delete(cacheKey.item(userId, taskId));
		console.log(JSON.stringify({
			level: 'info', event: 'ai_enriched', taskId, sentiment,
		}));

	} catch (err) {
		// AI enrichment is best-effort — failure must never affect task data
		// The task was already saved successfully before this function ran.
		console.error(JSON.stringify({
			level: 'error', event: 'ai_enrich_error',
			taskId, error: String(err),
		}));
	}
}
