// =============================================================================
// repositories/tag.repository.ts
//   We have a tags table (Step 2 schema) that needs CRUD.
//   Tags are per-user — every query filters by user_id.
// =============================================================================

import type { Tag, CreateTagInput } from '../types/task.types';

export interface UpdateTagInput {
	name?: string;
	color?: string;
}

function mapRow(row: Record<string, unknown>): Tag {
	return {
		id: Number(row.id),
		user_id: Number(row.user_id),
		name: String(row.name),
		color: String(row.color),
		created_at: String(row.created_at),
	};
}

export async function findAllByUser(db: D1Database, userId: number): Promise<Tag[]> {
	const { results } = await db
		.prepare('SELECT * FROM tags WHERE user_id = ? ORDER BY name ASC')
		.bind(userId)
		.all<Record<string, unknown>>();
	return results.map(mapRow);
}

export async function findById(db: D1Database, id: number, userId: number): Promise<Tag | null> {
	const row = await db
		.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.first<Record<string, unknown>>();
	return row ? mapRow(row) : null;
}

export async function create(db: D1Database, userId: number, input: CreateTagInput): Promise<Tag> {
	const color = input.color ?? '#6366f1';
	await db.prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)').bind(userId, input.name, color).run();
	const row = await db.prepare('SELECT * FROM tags WHERE id = last_insert_rowid()').first<Record<string, unknown>>();
	if (!row) throw new Error('Failed to retrieve tag after insert');
	return mapRow(row);
}

export async function update(db: D1Database, id: number, userId: number, input: UpdateTagInput): Promise<Tag | null> {
	const existing = await findById(db, id, userId);
	if (!existing) return null;

	const setClauses: string[] = [];
	const bindings: unknown[] = [];

	if (input.name !== undefined) { setClauses.push('name = ?'); bindings.push(input.name.trim()); }
	if (input.color !== undefined) { setClauses.push('color = ?'); bindings.push(input.color); }

	if (setClauses.length === 0) return existing;

	await db
		.prepare(`UPDATE tags SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`)
		.bind(...bindings, id, userId)
		.run();

	return findById(db, id, userId);
}

export async function remove(db: D1Database, id: number, userId: number): Promise<boolean> {
	const result = await db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').bind(id, userId).run();
	return (result.meta.changes ?? 0) > 0;
}
