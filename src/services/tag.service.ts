// =============================================================================
// services/tag.service.ts
// Business logic for tag management.
// =============================================================================

import * as tagRepo from '../repositories/tag.repository';
import { AppError } from '../middleware/error-handler';
import type { Tag, CreateTagInput } from '../types/task.types';

export async function getUserTags(db: D1Database, userId: number): Promise<Tag[]> {
	return tagRepo.findAllByUser(db, userId);
}

export async function createTag(db: D1Database, userId: number, input: CreateTagInput): Promise<Tag> {
	try {
		return await tagRepo.create(db, userId, input);
	} catch (err) {
		// D1 will throw on UNIQUE(user_id, name) violation
		const message = err instanceof Error ? err.message : '';
		if (message.includes('UNIQUE')) {
			throw AppError.conflict(`Tag "${input.name}" already exists`);
		}
		throw err;
	}
}

export async function deleteTag(db: D1Database, userId: number, id: number): Promise<void> {
	const deleted = await tagRepo.remove(db, id, userId);
	if (!deleted) {
		throw AppError.notFound(`Tag ${id} not found`);
	}
}
