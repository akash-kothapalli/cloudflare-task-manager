// =============================================================================
// utils/validation.ts  — NEW FILE
// APPROACH:
//   - Pure functions, no side effects
//   - Returns typed Result<T> — either { ok: true, value } or { ok: false, error }
//   - No throwing — caller decides how to handle the error
// =============================================================================

import {
  TASK_STATUSES,
  TASK_PRIORITIES,
  type TaskStatus,
  type TaskPriority,
  type CreateTaskInput,
  type UpdateTaskInput,
  type CreateTagInput,
} from "../types/task.types";

import type { RegisterInput, LoginInput } from "../types/user.types";

// ─── Result type ──────────────────────────────────────────────────────────────
// Using a discriminated union instead of throwing keeps validation pure.

export type ValidationResult<T> =
  | { ok: true;  value: T }
  | { ok: false; error: string };

// ─── Primitive helpers ────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isValidEmail(email: string): boolean {
  // RFC-5321 simplified — catches the vast majority of bad emails
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function isValidDate(dateStr: string): boolean {
  // Must be ISO-8601 date: YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

function isValidHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

// ─── Auth validation ──────────────────────────────────────────────────────────

export function validateRegisterInput(
  body: unknown
): ValidationResult<RegisterInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const b = body as Record<string, unknown>;

  if (!isNonEmptyString(b.email))    return { ok: false, error: "email is required" };
  if (!isValidEmail(b.email))        return { ok: false, error: "email format is invalid" };
  if (!isNonEmptyString(b.name))     return { ok: false, error: "name is required" };
  if (b.name.trim().length > 100)    return { ok: false, error: "name must be 100 characters or less" };
  if (!isNonEmptyString(b.password)) return { ok: false, error: "password is required" };
  if (b.password.length < 8)         return { ok: false, error: "password must be at least 8 characters" };
  if (b.password.length > 128)       return { ok: false, error: "password must be 128 characters or less" };

  return {
    ok: true,
    value: {
      email:    b.email.trim().toLowerCase(),
      name:     b.name.trim(),
      password: b.password,
    },
  };
}

export function validateLoginInput(
  body: unknown
): ValidationResult<LoginInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const b = body as Record<string, unknown>;

  if (!isNonEmptyString(b.email))    return { ok: false, error: "email is required" };
  if (!isNonEmptyString(b.password)) return { ok: false, error: "password is required" };

  return {
    ok: true,
    value: {
      email:    b.email.trim().toLowerCase(),
      password: b.password,
    },
  };
}

// ─── Task validation ──────────────────────────────────────────────────────────

export function validateCreateTaskInput(
  body: unknown
): ValidationResult<CreateTaskInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const b = body as Record<string, unknown>;

  if (!isNonEmptyString(b.title))  return { ok: false, error: "title is required" };
  if (b.title.trim().length > 255) return { ok: false, error: "title must be 255 characters or less" };

  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string") return { ok: false, error: "description must be a string" };
    if (b.description.length > 5000)       return { ok: false, error: "description must be 5000 characters or less" };
  }

  if (b.status !== undefined) {
    if (!TASK_STATUSES.includes(b.status as TaskStatus)) {
      return { ok: false, error: `status must be one of: ${TASK_STATUSES.join(", ")}` };
    }
  }

  if (b.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(b.priority as TaskPriority)) {
      return { ok: false, error: `priority must be one of: ${TASK_PRIORITIES.join(", ")}` };
    }
  }

  if (b.due_date !== undefined && b.due_date !== null) {
    if (typeof b.due_date !== "string" || !isValidDate(b.due_date)) {
      return { ok: false, error: "due_date must be a valid ISO-8601 date (YYYY-MM-DD)" };
    }
  }

  if (b.tag_ids !== undefined) {
    if (!Array.isArray(b.tag_ids) || !b.tag_ids.every((id) => typeof id === "number")) {
      return { ok: false, error: "tag_ids must be an array of numbers" };
    }
  }

  return {
    ok: true,
    value: {
      title:       b.title.trim(),
      description: typeof b.description === "string" ? b.description.trim() : undefined,
      status:      b.status      as TaskStatus   | undefined,
      priority:    b.priority    as TaskPriority | undefined,
      due_date:    typeof b.due_date === "string" ? b.due_date : undefined,
      tag_ids:     Array.isArray(b.tag_ids) ? b.tag_ids as number[] : undefined,
    },
  };
}

export function validateUpdateTaskInput(
  body: unknown
): ValidationResult<UpdateTaskInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const b = body as Record<string, unknown>;

  // At least one field must be present
  const allowed = ["title", "description", "status", "priority", "due_date", "tag_ids"];
  const provided = allowed.filter((k) => k in b);
  if (provided.length === 0) {
    return { ok: false, error: `At least one field required: ${allowed.join(", ")}` };
  }

  if (b.title !== undefined) {
    if (!isNonEmptyString(b.title))  return { ok: false, error: "title must be a non-empty string" };
    if (b.title.trim().length > 255) return { ok: false, error: "title must be 255 characters or less" };
  }

  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string") return { ok: false, error: "description must be a string" };
    if (b.description.length > 5000)       return { ok: false, error: "description must be 5000 characters or less" };
  }

  if (b.status !== undefined) {
    if (!TASK_STATUSES.includes(b.status as TaskStatus)) {
      return { ok: false, error: `status must be one of: ${TASK_STATUSES.join(", ")}` };
    }
  }

  if (b.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(b.priority as TaskPriority)) {
      return { ok: false, error: `priority must be one of: ${TASK_PRIORITIES.join(", ")}` };
    }
  }

  if (b.due_date !== undefined && b.due_date !== null) {
    if (typeof b.due_date !== "string" || !isValidDate(b.due_date)) {
      return { ok: false, error: "due_date must be a valid ISO-8601 date (YYYY-MM-DD)" };
    }
  }

  if (b.tag_ids !== undefined) {
    if (!Array.isArray(b.tag_ids) || !b.tag_ids.every((id) => typeof id === "number")) {
      return { ok: false, error: "tag_ids must be an array of numbers" };
    }
  }

  return {
    ok: true,
    value: {
      title:       typeof b.title === "string" ? b.title.trim() : undefined,
      description: b.description === null ? null
                    : typeof b.description === "string" ? b.description.trim()
                    : undefined,
      status:      b.status   as TaskStatus   | undefined,
      priority:    b.priority as TaskPriority | undefined,
      due_date:    b.due_date === null ? null
                    : typeof b.due_date === "string" ? b.due_date
                    : undefined,
      tag_ids:     Array.isArray(b.tag_ids) ? b.tag_ids as number[] : undefined,
    },
  };
}

// ─── Tag validation ───────────────────────────────────────────────────────────

export function validateCreateTagInput(
  body: unknown
): ValidationResult<CreateTagInput> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const b = body as Record<string, unknown>;

  if (!isNonEmptyString(b.name))  return { ok: false, error: "name is required" };
  if (b.name.trim().length > 50)  return { ok: false, error: "name must be 50 characters or less" };

  if (b.color !== undefined) {
    if (typeof b.color !== "string" || !isValidHexColor(b.color)) {
      return { ok: false, error: "color must be a valid hex color (e.g. #6366f1)" };
    }
  }

  return {
    ok: true,
    value: {
      name:  b.name.trim().toLowerCase(),
      color: typeof b.color === "string" ? b.color : undefined,
    },
  };
}

// ─── Query param parsing ──────────────────────────────────────────────────────

export function parsePositiveInt(
  value: string | null,
  defaultValue: number,
  max?: number
): number {
  if (!value) return defaultValue;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) return defaultValue;
  if (max !== undefined && n > max) return max;
  return n;
}
