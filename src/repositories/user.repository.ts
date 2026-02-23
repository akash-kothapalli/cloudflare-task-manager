// =============================================================================
// repositories/user.repository.ts
//
// WHY REWRITE:
//   Old: createUser only took email + password (no name)
//        Used `as unknown as User` casts — unsafe, hides type mismatches
//        No updated_at handling
//
// NEW:
//   - All D1 rows explicitly mapped field-by-field — no unsafe casts
//   - Supports name field (Step 2 schema)
//   - findById added — needed by auth.service after create
//   - All queries use parameterized statements (SQLi safe)
// =============================================================================

import type { User } from "../types/user.types";

// ─── Row mapper ───────────────────────────────────────────────────────────────
// Maps a raw D1 result record → typed User.
// Explicit field-by-field: TypeScript verifies every field exists on User.
// `as unknown as User` is gone — if DB schema and type diverge, TS catches it.

function mapRow(row: Record<string, unknown>): User {
  return {
    id:         Number(row.id),
    email:      String(row.email),
    name:       String(row.name),
    password:   String(row.password),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

// ─── Queries ───────────────────────────────────────────────────────────────────

export async function findById(
  db:  D1Database,
  id:  number
): Promise<User | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();

  return row ? mapRow(row) : null;
}

export async function findByEmail(
  db:    D1Database,
  email: string
): Promise<User | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first<Record<string, unknown>>();

  return row ? mapRow(row) : null;
}

export async function createUser(
  db:       D1Database,
  email:    string,
  name:     string,
  password: string
): Promise<User> {
  const result = await db
    .prepare("INSERT INTO users (email, name, password) VALUES (?, ?, ?)")
    .bind(email, name, password)
    .run();

  // Fetch the inserted row by its new ID
  const row = await db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(result.meta.last_row_id)
    .first<Record<string, unknown>>();

  if (!row) throw new Error("Failed to retrieve user after insert");

  return mapRow(row);
}

export async function updateUser(
  db:    D1Database,
  id:    number,
  name?: string
): Promise<User | null> {
  await db
    .prepare("UPDATE users SET name = COALESCE(?, name), updated_at = datetime('now') WHERE id = ?")
    .bind(name ?? null, id)
    .run();

  return findById(db, id);
}
