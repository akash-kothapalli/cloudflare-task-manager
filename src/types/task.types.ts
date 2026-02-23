// =============================================================================
// task.types.ts
// Strict TypeScript types for the task domain.
//
// Naming convention:
//   Task        — the raw DB row as returned by D1 (all fields, exact DB types)
//   TaskResponse — what the API sends to clients (tags included, no internals)
//   Create*Input — validated payload to create a new record
//   Update*Input — validated payload to partially update a record
// =============================================================================

// ─── String union types ────────────────────────────────────────────────────────
// Using `type` literals instead of plain `string` means TypeScript will catch
// any typo at compile time: status = "complet" will be a type error.

export type TaskStatus   = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low'  | 'medium'       | 'high' | 'critical';
export type AISentiment  = 'positive' | 'neutral'  | 'negative';

// ─── Allowed values as runtime arrays ─────────────────────────────────────────
// Used in controllers for request validation — single source of truth.
// "as const" makes the array readonly and typed as a tuple of literals.

export const TASK_STATUSES:   readonly TaskStatus[]   = ['todo', 'in_progress', 'done', 'cancelled'] as const;
export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'critical']        as const;
export const AI_SENTIMENTS:   readonly AISentiment[]  = ['positive', 'neutral', 'negative']          as const;

// ─── DB row — exactly what D1 returns ─────────────────────────────────────────
// - All timestamps are TEXT in D1 (SQLite stores datetimes as strings)
// - Nullable columns use `| null`, not `?` — D1 returns null, not undefined
// - Readonly<> prevents accidental mutation of a row after fetching

export type Task = Readonly<{
  id:           number;
  user_id:      number;
  title:        string;
  description:  string | null;
  status:       TaskStatus;
  priority:     TaskPriority;
  due_date:     string | null;   // ISO-8601 date string e.g. "2026-03-15"
  completed_at: string | null;   // ISO-8601 datetime, set when status → done
  ai_summary:   string | null;
  ai_sentiment: AISentiment | null;
  created_at:   string;
  updated_at:   string;
}>;

// ─── Tag DB row ────────────────────────────────────────────────────────────────
export type Tag = Readonly<{
  id:         number;
  user_id:    number;
  name:       string;
  color:      string;   // hex e.g. "#6366f1"
  created_at: string;
}>;

// ─── API response shape ────────────────────────────────────────────────────────
// What GET /tasks and GET /tasks/:id return to the client.
// Extends Task but adds resolved tags (not just IDs).

export type TaskResponse = Task & {
  tags: Pick<Tag, 'id' | 'name' | 'color'>[];
};

// ─── Inputs ───────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title:        string;                   // required
  description?: string;                  // optional
  status?:      TaskStatus;              // defaults to 'todo'
  priority?:    TaskPriority;            // defaults to 'medium'
  due_date?:    string;                  // optional ISO-8601 date
  tag_ids?:     number[];                // optional: attach existing tag IDs
}

export interface UpdateTaskInput {
  title?:       string;
  description?: string | null;           // null = clear the description
  status?:      TaskStatus;
  priority?:    TaskPriority;
  due_date?:    string | null;           // null = clear the due date
  tag_ids?:     number[];                // replaces all existing tags on the task
}

// ─── Query / filter params ────────────────────────────────────────────────────
export interface TaskQueryParams {
  status?:    TaskStatus;
  priority?:  TaskPriority;
  due_before?: string;    // ISO-8601 date — tasks due on or before this date
  search?:    string;     // partial match on title
  page?:      number;     // default 1
  limit?:     number;     // default 20, max 100
}

// ─── Tag inputs ───────────────────────────────────────────────────────────────
export interface CreateTagInput {
  name:   string;
  color?: string;   // hex colour, defaults to '#6366f1'
}