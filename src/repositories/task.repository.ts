// =============================================================================
// repositories/task.repository.ts
//
// WHY REWRITE:
//   Old: SELECT * FROM tasks — no user_id filter (security bug)
//        Only title + completed fields
//        No tags support
//        `as unknown as Task` unsafe casts
//
// NEW:
//   - Every query filters by user_id — tasks are always user-scoped
//   - Full field set: status, priority, due_date, completed_at, ai fields
//   - Tags fetched with a JOIN and attached to TaskResponse
//   - Explicit row mapper — no unsafe casts
//   - findAll supports filtering by status, priority, due_before, search + pagination
//   - updateAiFields: separate update for Workers AI results (Step 8)
// =============================================================================

import type { Task, TaskResponse, CreateTaskInput, UpdateTaskInput, TaskQueryParams } from "../types/task.types";

// ─── Row mappers ──────────────────────────────────────────────────────────────

function mapTaskRow(row: Record<string, unknown>): Task {
  return {
    id:           Number(row.id),
    user_id:      Number(row.user_id),
    title:        String(row.title),
    description:  row.description  != null ? String(row.description)  : null,
    status:       String(row.status)   as Task["status"],
    priority:     String(row.priority) as Task["priority"],
    due_date:     row.due_date     != null ? String(row.due_date)     : null,
    completed_at: row.completed_at != null ? String(row.completed_at) : null,
    ai_summary:   row.ai_summary   != null ? String(row.ai_summary)   : null,
    ai_sentiment: row.ai_sentiment != null ? String(row.ai_sentiment) as Task["ai_sentiment"] : null,
    created_at:   String(row.created_at),
    updated_at:   String(row.updated_at),
  };
}

// Attach resolved tags to a task — called after fetching task rows
async function attachTags(
  db:     D1Database,
  taskId: number
): Promise<TaskResponse["tags"]> {
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

  return results.map(r => ({
    id:    Number(r.id),
    name:  String(r.name),
    color: String(r.color),
  }));
}

async function toTaskResponse(db: D1Database, task: Task): Promise<TaskResponse> {
  const tags = await attachTags(db, task.id);
  return { ...task, tags };
}

// ─── findAll ──────────────────────────────────────────────────────────────────
// Builds a dynamic WHERE clause from query params.
// Uses a single parameterized query — safe against SQLi.

export interface FindAllResult {
  tasks: TaskResponse[];
  total: number;
  page:  number;
  limit: number;
}

export async function findAll(
  db:     D1Database,
  userId: number,
  params: TaskQueryParams
): Promise<FindAllResult> {
  const page  = Math.max(1, params.page  ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));
  const offset = (page - 1) * limit;

  // Build WHERE conditions dynamically — all values go through bind()
  const conditions: string[] = ["user_id = ?"];
  const bindings:   unknown[] = [userId];

  if (params.status) {
    conditions.push("status = ?");
    bindings.push(params.status);
  }

  if (params.priority) {
    conditions.push("priority = ?");
    bindings.push(params.priority);
  }

  if (params.due_before) {
    conditions.push("due_date <= ?");
    bindings.push(params.due_before);
  }

  if (params.search) {
    // LIKE search on title — wildcards added here, not from user input
    conditions.push("title LIKE ?");
    bindings.push(`%${params.search.replace(/[%_]/g, "\\$&")}%`); // escape LIKE wildcards
  }

  const where = conditions.join(" AND ");

  // Run count + data queries in parallel — one round trip
  const [countResult, { results }] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) as total FROM tasks WHERE ${where}`)
      .bind(...bindings)
      .first<{ total: number }>(),
    db
      .prepare(`
        SELECT * FROM tasks
        WHERE ${where}
        ORDER BY
          CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          CASE WHEN due_date IS NOT NULL THEN due_date ELSE '9999-12-31' END ASC,
          created_at DESC
        LIMIT ? OFFSET ?
      `)
      .bind(...bindings, limit, offset)
      .all<Record<string, unknown>>(),
  ]);

  const total = countResult?.total ?? 0;
  const tasks  = results.map(mapTaskRow);

  // Attach tags to each task — batched with Promise.all
  const tasksWithTags = await Promise.all(
    tasks.map(task => toTaskResponse(db, task))
  );

  return { tasks: tasksWithTags, total, page, limit };
}

// ─── findById ─────────────────────────────────────────────────────────────────

export async function findById(
  db:     D1Database,
  id:     number,
  userId: number
): Promise<TaskResponse | null> {
  const row = await db
    .prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<Record<string, unknown>>();

  if (!row) return null;

  const task = mapTaskRow(row);
  return toTaskResponse(db, task);
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(
  db:     D1Database,
  userId: number,
  input:  CreateTaskInput
): Promise<TaskResponse> {
  const result = await db
    .prepare(`
      INSERT INTO tasks (user_id, title, description, status, priority, due_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(
      userId,
      input.title,
      input.description ?? null,
      input.status      ?? "todo",
      input.priority    ?? "medium",
      input.due_date    ?? null,
    )
    .run();

  // WHY last_insert_rowid(): result.meta.last_row_id is unreliable in Miniflare
  const idRow = await db
    .prepare("SELECT last_insert_rowid() as id")
    .first<{ id: number }>();
  const taskId = idRow!.id;

  // Attach tags if provided
  if (input.tag_ids && input.tag_ids.length > 0) {
    await attachTagsToTask(db, taskId, input.tag_ids);
  }

  const task = await findById(db, taskId, userId);
  if (!task) throw new Error("Failed to retrieve task after insert");

  return task;
}

// ─── update ───────────────────────────────────────────────────────────────────

export async function update(
  db:     D1Database,
  id:     number,
  userId: number,
  input:  UpdateTaskInput
): Promise<TaskResponse | null> {

  // Check task exists and belongs to this user
  const existing = await findById(db, id, userId);
  if (!existing) return null;

  // Build SET clause dynamically — only update provided fields
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const bindings:   unknown[] = [];

  if (input.title !== undefined) {
    setClauses.push("title = ?");
    bindings.push(input.title);
  }

  if ("description" in input) {
    setClauses.push("description = ?");
    bindings.push(input.description ?? null);
  }

  if (input.status !== undefined) {
    setClauses.push("status = ?");
    bindings.push(input.status);

    // Auto-set completed_at when status transitions to "done"
    if (input.status === "done" && existing.status !== "done") {
      setClauses.push("completed_at = datetime('now')");
    }
    // Clear completed_at if moving away from "done"
    if (input.status !== "done" && existing.status === "done") {
      setClauses.push("completed_at = NULL");
    }
  }

  if (input.priority !== undefined) {
    setClauses.push("priority = ?");
    bindings.push(input.priority);
  }

  if ("due_date" in input) {
    setClauses.push("due_date = ?");
    bindings.push(input.due_date ?? null);
  }

  // Only run UPDATE if there are actual field changes
  if (setClauses.length > 1) {
    await db
      .prepare(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`)
      .bind(...bindings, id, userId)
      .run();
  }

  // Replace tags if provided
  if (input.tag_ids !== undefined) {
    await db.prepare("DELETE FROM task_tags WHERE task_id = ?").bind(id).run();
    if (input.tag_ids.length > 0) {
      await attachTagsToTask(db, id, input.tag_ids);
    }
  }

  return findById(db, id, userId);
}

// ─── remove ───────────────────────────────────────────────────────────────────

export async function remove(
  db:     D1Database,
  id:     number,
  userId: number
): Promise<boolean> {
  // ON DELETE CASCADE in schema handles task_tags cleanup automatically
  const result = await db
    .prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

// ─── updateAiFields ───────────────────────────────────────────────────────────
// Called by task.service after Workers AI enrichment completes (Step 8).
// Separate function — AI runs async, doesn't block the create response.

export async function updateAiFields(
  db:          D1Database,
  id:          number,
  userId:      number,
  aiSummary:   string,
  aiSentiment: string
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

// ─── Helper: attach tags to a task ────────────────────────────────────────────

async function attachTagsToTask(
  db:     D1Database,
  taskId: number,
  tagIds: number[]
): Promise<void> {
  // D1 doesn't support multi-row INSERT in a single prepare — use batch
  const stmts = tagIds.map(tagId =>
    db
      .prepare("INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)")
      .bind(taskId, tagId)
  );
  await db.batch(stmts);
}
