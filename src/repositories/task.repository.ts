// =============================================================================
// repositories/task.repository.ts
//
//   Every query filters by user_id — tasks are always user-scoped.
//
//   KEY CHANGE —  N+1 query eliminated in findAll()
//   -------------------------------------------------------
//   BEFORE: for each of N tasks, attachTags() fired a separate SQL query.
//           20 tasks = 21 total DB round trips (1 task query + 20 tag queries).
//   AFTER:  one extra query fetches ALL tags for ALL tasks using IN (...).
//           JavaScript then groups them by task_id in memory.
//           20 tasks = 2 total DB round trips always, regardless of page size.
//
//   attachTags() is kept unchanged — still used by findById() which fetches
//   exactly one task, so N+1 does not apply there.
//
//    tag_id filter added to findAll() — sidebar tag click wires to this.
// =============================================================================

import type { Task, TaskResponse, CreateTaskInput, UpdateTaskInput, TaskQueryParams } from '../types/task.types';

// ─── Row mappers ──────────────────────────────────────────────────────────────
// Explicit field-by-field mapping — no unsafe `as TaskResponse` cast.
// Every field is explicitly converted from D1's unknown type to the correct TS type.

function mapTaskRow(row: Record<string, unknown>): Task {
	return {
		id:           Number(row.id),
		user_id:      Number(row.user_id),
		title:        String(row.title),
		description:  row.description  != null ? String(row.description)  : null,
		status:       String(row.status)   as Task['status'],
		priority:     String(row.priority) as Task['priority'],
		due_date:     row.due_date     != null ? String(row.due_date)     : null,
		completed_at: row.completed_at != null ? String(row.completed_at) : null,
		ai_summary:   row.ai_summary   != null ? String(row.ai_summary)   : null,
		ai_sentiment: row.ai_sentiment != null ? (String(row.ai_sentiment) as Task['ai_sentiment']) : null,
		created_at:   String(row.created_at),
		updated_at:   String(row.updated_at),
	};
}

// ─── attachTags ───────────────────────────────────────────────────────────────
// Fetches tags for a SINGLE task — used only by findById().
// WHY kept separate: findById() fetches one task so there is no N+1 risk.
// One task always needs exactly one tag query — that is correct and efficient.
// Do NOT use this inside findAll() — that uses batchAttachTags() instead.

async function attachTags(db: D1Database, taskId: number): Promise<TaskResponse['tags']> {
	const { results } = await db
		.prepare(`
			SELECT t.id, t.name, t.color
			FROM tags t
			JOIN task_tags tt ON tt.tag_id = t.id
			WHERE tt.task_id = ?
			ORDER BY t.name ASC
		`)
		.bind(taskId)
		.all<Record<string, unknown>>();

	return results.map((r) => ({
		id:    Number(r.id),
		name:  String(r.name),
		color: String(r.color),
	}));
}

// ─── toTaskResponse ───────────────────────────────────────────────────────────
// Used by findById() only — attaches tags to a single fetched task.

async function toTaskResponse(db: D1Database, task: Task): Promise<TaskResponse> {
	const tags = await attachTags(db, task.id);
	return { ...task, tags };
}

// ─── batchAttachTags ──────────────────────────────────────────────────────────
// THE FIX FOR N+1 — used by findAll() only.
//
// HOW IT WORKS:
//   1. Collect all task IDs from the current page into one array.
//   2. Run ONE SQL query: SELECT ... WHERE task_id IN (id1, id2, id3, ...)
//      This returns every tag row for every task on the page in one shot.
//   3. Build a Map<taskId, Tag[]> in JavaScript memory — no extra DB calls.
//   4. Return the Map so findAll() can do O(1) lookup per task.
//
// WHY IN (...) is safe here:
//   The task IDs come from our own previous DB query result (mapTaskRow),
//   not from user input. They are always integers. No SQL injection risk.
//   We still use parameterised bindings (the .bind(...taskIds) call) as
//   best practice — D1 handles the placeholder expansion.

async function batchAttachTags(
	db: D1Database,
	taskIds: number[],
): Promise<Map<number, TaskResponse['tags']>> {
	// Return empty map immediately if there are no tasks — avoids invalid SQL
	// "WHERE task_id IN ()" which would be a syntax error in SQLite.
	if (taskIds.length === 0) {
		return new Map();
	}

	// Build "?, ?, ?" placeholder string — one ? per task ID.
	// D1 binds each ? to the corresponding integer from taskIds.
	const placeholders = taskIds.map(() => '?').join(', ');

	const { results } = await db
		.prepare(`
			SELECT tt.task_id, tg.id, tg.name, tg.color
			FROM task_tags tt
			JOIN tags tg ON tg.id = tt.tag_id
			WHERE tt.task_id IN (${placeholders})
			ORDER BY tg.name ASC
		`)
		.bind(...taskIds)
		.all<{ task_id: number; id: number; name: string; color: string }>();

	// Group tag rows by task_id using a Map — pure JS, zero DB calls.
	// Map<taskId → [{ id, name, color }, ...]>
	const tagsByTaskId = new Map<number, TaskResponse['tags']>();

	for (const row of results) {
		const taskId = Number(row.task_id);

		// Initialise the array for this task if we haven't seen it yet
		if (!tagsByTaskId.has(taskId)) {
			tagsByTaskId.set(taskId, []);
		}

		// Push this tag onto the task's array
		tagsByTaskId.get(taskId)!.push({
			id:    Number(row.id),
			name:  String(row.name),
			color: String(row.color),
		});
	}

	// Tasks with no tags will not appear in the Map at all.
	// findAll() uses `tagsByTaskId.get(task.id) ?? []` so they get tags: [].
	return tagsByTaskId;
}

// ─── FindAllResult ────────────────────────────────────────────────────────────

export interface FindAllResult {
	tasks: TaskResponse[];
	total: number;
	page:  number;
	limit: number;
}

// ─── findAll ──────────────────────────────────────────────────────────────────
// Builds a dynamic WHERE clause from query params — all values parameterised.
//
// Filters supported:
//   status     — exact match
//   priority   — exact match
//   due_before — tasks due on or before this ISO date
//   search     — LIKE match on title (wildcards escaped)
//   tag_id     — only tasks that have this tag attached 
//
// Performance:
//   - count + data queries run in parallel with Promise.all (one round trip)
//   - tags fetched with ONE extra query via batchAttachTags 
//   - total DB queries = 3 always, regardless of page size

export async function findAll(db: D1Database, userId: number, params: TaskQueryParams): Promise<FindAllResult> {
	const page   = Math.max(1,   params.page  ?? 1);
	const limit  = Math.min(100, Math.max(1, params.limit ?? 20));
	const offset = (page - 1) * limit;

	// ── Build WHERE clause ────────────────────────────────────────────────────
	// conditions[] and bindings[] grow together — every condition gets a binding.
	// The final SQL is: WHERE condition1 AND condition2 AND ...

	const conditions: string[] = ['t.user_id = ?'];
	const bindings:   unknown[] = [userId];

	if (params.status) {
		conditions.push('t.status = ?');
		bindings.push(params.status);
	}

	if (params.priority) {
		conditions.push('t.priority = ?');
		bindings.push(params.priority);
	}

	if (params.due_before) {
		conditions.push('t.due_date <= ?');
		bindings.push(params.due_before);
	}

	if (params.search) {
		// Escape % and _ so they are treated as literals, not LIKE wildcards.
		// Then wrap in % for a contains-search.
		conditions.push('t.title LIKE ?');
		bindings.push(`%${params.search.replace(/[%_]/g, '\\$&')}%`);
	}

	// tag filter:
	// EXISTS subquery: only include tasks that have a row in task_tags for this tag_id.
	// WHY EXISTS instead of JOIN: a JOIN would multiply rows if a task has multiple tags,
	// requiring DISTINCT and complicating the count query.
	// EXISTS is cleaner, uses the existing idx_task_tags_task_id index, and has no
	// row-multiplication side effect.
	if (params.tag_id) {
		conditions.push('EXISTS (SELECT 1 FROM task_tags tt2 WHERE tt2.task_id = t.id AND tt2.tag_id = ?)');
		bindings.push(params.tag_id);
	}

	const where = conditions.join(' AND ');

	// ── Run count + data queries in parallel ──────────────────────────────────
	// Promise.all fires both queries at the same time — D1 handles concurrency.
	// This saves one full network round trip compared to running them sequentially.
	// Note: table is aliased as "t" so conditions like "t.user_id" work in both queries.

	const [countResult, { results }] = await Promise.all([
		db
			.prepare(`SELECT COUNT(*) as total FROM tasks t WHERE ${where}`)
			.bind(...bindings)
			.first<{ total: number }>(),
		db
			.prepare(`
				SELECT t.*
				FROM tasks t
				WHERE ${where}
				ORDER BY
					CASE t.priority
						WHEN 'critical' THEN 1
						WHEN 'high'     THEN 2
						WHEN 'medium'   THEN 3
						ELSE 4
					END,
					CASE WHEN t.due_date IS NOT NULL THEN t.due_date ELSE '9999-12-31' END ASC,
					t.created_at DESC
				LIMIT ? OFFSET ?
			`)
			.bind(...bindings, limit, offset)
			.all<Record<string, unknown>>(),
	]);

	const total = countResult?.total ?? 0;
	const tasks = results.map(mapTaskRow);

	// ── Batch fetch all tags — Fix 4 ──────────────────────────────────────────
	// ONE query for all tasks on this page. Returns Map<taskId, Tag[]>.
	// Then we attach tags to each task using O(1) Map.get() — no extra DB calls.
	// If tasks is empty, batchAttachTags returns an empty Map immediately.

	const tagsByTaskId = await batchAttachTags(db, tasks.map((t) => t.id));

	const tasksWithTags: TaskResponse[] = tasks.map((task) => ({
		...task,
		// If task has no tags in the Map (no rows in task_tags), default to [].
		tags: tagsByTaskId.get(task.id) ?? [],
	}));

	return { tasks: tasksWithTags, total, page, limit };
}

// ─── findById ─────────────────────────────────────────────────────────────────
// Fetches a single task by ID, scoped to userId (prevents IDOR).
// Uses toTaskResponse → attachTags — one task = one tag query = correct.

export async function findById(db: D1Database, id: number, userId: number): Promise<TaskResponse | null> {
	const row = await db
		.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.first<Record<string, unknown>>();

	if (!row) return null;

	const task = mapTaskRow(row);
	return toTaskResponse(db, task);
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(db: D1Database, userId: number, input: CreateTaskInput): Promise<TaskResponse> {
	await db
		.prepare(`
			INSERT INTO tasks (user_id, title, description, status, priority, due_date)
			VALUES (?, ?, ?, ?, ?, ?)
		`)
		.bind(
			userId,
			input.title,
			input.description ?? null,
			input.status      ?? 'todo',
			input.priority    ?? 'medium',
			input.due_date    ?? null,
		)
		.run();

	// WHY last_insert_rowid():
	// result.meta.last_row_id is unreliable in Miniflare (local Workers runtime).
	// Using last_insert_rowid() is the SQLite-native way and works in both
	// local dev (Miniflare) and production (D1).
	const idRow = await db.prepare('SELECT last_insert_rowid() as id').first<{ id: number }>();
	const taskId = idRow!.id;

	// Attach tags if provided — ownership-checked inside attachTagsToTask()
	if (input.tag_ids && input.tag_ids.length > 0) {
		await attachTagsToTask(db, taskId, input.tag_ids, userId);
	}

	const task = await findById(db, taskId, userId);
	if (!task) throw new Error('Failed to retrieve task after insert');

	return task;
}

// ─── update ───────────────────────────────────────────────────────────────────
// Partial update — only fields present in input are updated.
// Uses dynamic SET clause so a PATCH with only { status: "done" } does not
// accidentally clear title, description, etc.

export async function update(db: D1Database, id: number, userId: number, input: UpdateTaskInput): Promise<TaskResponse | null> {
	// Verify task exists and belongs to this user before updating
	const existing = await findById(db, id, userId);
	if (!existing) return null;

	const setClauses: string[]  = ["updated_at = datetime('now')"];
	const bindings:   unknown[] = [];

	if (input.title !== undefined) {
		setClauses.push('title = ?');
		bindings.push(input.title);
	}

	// `'description' in input` catches explicit null (clear field) vs missing key (no change)
	if ('description' in input) {
		setClauses.push('description = ?');
		bindings.push(input.description ?? null);
	}

	if (input.status !== undefined) {
		setClauses.push('status = ?');
		bindings.push(input.status);

		// Auto-set completed_at when status transitions TO done
		if (input.status === 'done' && existing.status !== 'done') {
			setClauses.push("completed_at = datetime('now')");
		}

		// Clear completed_at when status transitions AWAY from done
		if (input.status !== 'done' && existing.status === 'done') {
			setClauses.push('completed_at = NULL');
		}
	}

	if (input.priority !== undefined) {
		setClauses.push('priority = ?');
		bindings.push(input.priority);
	}

	// `'due_date' in input` catches explicit null (clear date) vs missing key (no change)
	if ('due_date' in input) {
		setClauses.push('due_date = ?');
		bindings.push(input.due_date ?? null);
	}

	// Only run UPDATE if at least one field is changing (setClauses always has updated_at)
	if (setClauses.length > 1) {
		await db
			.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`)
			.bind(...bindings, id, userId)
			.run();
	}

	// Replace tags if tag_ids was included in the PATCH body
	if (input.tag_ids !== undefined) {
		// Delete all existing tag associations for this task
		await db.prepare('DELETE FROM task_tags WHERE task_id = ?').bind(id).run();
		// Re-attach new set (ownership-checked inside attachTagsToTask)
		if (input.tag_ids.length > 0) {
			await attachTagsToTask(db, id, input.tag_ids, userId);
		}
	}

	return findById(db, id, userId);
}

// ─── remove ───────────────────────────────────────────────────────────────────
// ON DELETE CASCADE on task_tags handles cleanup automatically — no manual
// DELETE on task_tags needed here.

export async function remove(db: D1Database, id: number, userId: number): Promise<boolean> {
	const result = await db
		.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.run();

	return (result.meta.changes ?? 0) > 0;
}

// ─── updateAiFields ───────────────────────────────────────────────────────────
// Called by task.service.ts after Workers AI enrichment completes.
// Runs AFTER the HTTP response is sent (via ctx.waitUntil) — never blocks the API.
// Scoped to userId as an extra safety check even though AI only runs for the
// task owner's request.

export async function updateAiFields(
	db: D1Database,
	id: number,
	userId: number,
	aiSummary: string,
	aiSentiment: string,
): Promise<void> {
	await db
		.prepare(`
			UPDATE tasks
			SET ai_summary = ?, ai_sentiment = ?, updated_at = datetime('now')
			WHERE id = ? AND user_id = ?
		`)
		.bind(aiSummary, aiSentiment, id, userId)
		.run();
}

// ─── attachTagsToTask (private helper) ───────────────────────────────────────
// SECURITY: verifies every tag ID belongs to userId before inserting.
// WHY: without this check, a user could attach tag IDs belonging to another
// user — leaking that those tags exist (IDOR information leak).
//
// Uses INSERT OR IGNORE so duplicate tag attachments are silently skipped
// instead of throwing a UNIQUE constraint error.

async function attachTagsToTask(
	db: D1Database,
	taskId: number,
	tagIds: number[],
	userId: number,
): Promise<void> {
	if (tagIds.length === 0) return;

	// Verify ownership — only keep tag IDs that belong to this user
	const placeholders = tagIds.map(() => '?').join(', ');
	const { results } = await db
		.prepare(`SELECT id FROM tags WHERE id IN (${placeholders}) AND user_id = ?`)
		.bind(...tagIds, userId)
		.all<{ id: number }>();

	const ownedTagIds = results.map((r) => r.id);
	if (ownedTagIds.length === 0) return;

	// D1 does not support multi-row INSERT VALUES (?,?),(?,?) in one prepare.
	// db.batch() sends all statements in one HTTP round trip to D1 — efficient.
	const stmts = ownedTagIds.map((tagId) =>
		db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').bind(taskId, tagId),
	);
	await db.batch(stmts);
}
