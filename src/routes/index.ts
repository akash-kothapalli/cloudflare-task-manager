// =============================================================================
// routes/index.ts  — Central router for all API endpoints
//
//   Clean router function — pure routing only.
//   Each route:
//     1. Parses the URL + method
//     2. Extracts any path params (e.g. id)
//     3. Runs auth if required
//     4. Calls one controller function
//     5. Returns the Response
//
//   All auth is via requireAuth — not inline in routes.
// =============================================================================

import { requireAuth }         from "../middleware/auth.middleware";
import { notFound }            from "../utils/response";
import { registerController,
         loginController,
         getMeController }     from "../controllers/auth.controller";
import { handleGetAllTasks,
         handleGetTaskById,
         handleCreateTask,
         handleUpdateTask,
         handleDeleteTask }    from "../controllers/task.controller";
import { handleGetTags,
         handleCreateTag,
         handleDeleteTag }     from "../controllers/tag.controller";
import type { Env }            from "../types/env.types";

// ─── parseId ──────────────────────────────────────────────────────────────────
// Safely parse an integer from a URL path segment.
// Returns null if missing or not a valid positive integer.

function parseId(segment: string | undefined): number | null {
  if (!segment) return null;
  const n = parseInt(segment, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export async function router(request: Request, env: Env): Promise<Response> {
  const url    = new URL(request.url);
  const method = request.method;
  const path   = url.pathname;

  // Split path into segments: "/tasks/42" → ["", "tasks", "42"]
  const segments = path.split("/");
  const seg1 = segments[1]; // e.g. "auth", "tasks", "tags", "health"
  const seg2 = segments[2]; // e.g. "register", "42"

  // ── Health check ─────────────────────────────────────────────────────────────
  if (path === "/health" && method === "GET") {
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          status:    "ok",
          timestamp: new Date().toISOString(),
          version:   "1.0.0",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Auth routes (public — no token required) ──────────────────────────────
  if (seg1 === "auth") {
    if (seg2 === "register" && method === "POST") return registerController(request, env);
    if (seg2 === "login"    && method === "POST") return loginController(request, env);

    // Protected auth route
    if (seg2 === "me" && method === "GET") {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return getMeController(auth, env);
    }

    return notFound(`Auth route not found: ${method} /auth/${seg2}`);
  }

  // ── Task routes (all protected) ───────────────────────────────────────────
  if (seg1 === "tasks") {
    // Authenticate once — reused by all task handlers below
    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth; // 401

    // /tasks  (no id)
    if (!seg2) {
      if (method === "GET")  return handleGetAllTasks(request, env, auth);
      if (method === "POST") return handleCreateTask(request, env, auth);
    }

    // /tasks/:id
    const id = parseId(seg2);
    if (id === null) {
      return new Response(
        JSON.stringify({ success: false, error: { code: "BAD_REQUEST", message: "Task ID must be a positive integer" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (method === "GET")    return handleGetTaskById(id, env, auth);
    if (method === "PATCH")  return handleUpdateTask(id, request, env, auth);
    if (method === "DELETE") return handleDeleteTask(id, env, auth);
  }

  // ── Tag routes (all protected) ────────────────────────────────────────────
  if (seg1 === "tags") {
    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth;

    if (!seg2) {
      if (method === "GET")  return handleGetTags(env, auth);
      if (method === "POST") return handleCreateTag(request, env, auth);
    }

    const id = parseId(seg2);
    if (id === null) {
      return new Response(
        JSON.stringify({ success: false, error: { code: "BAD_REQUEST", message: "Tag ID must be a positive integer" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (method === "DELETE") return handleDeleteTag(id, env, auth);
  }

  return notFound(`Route not found: ${method} ${path}`);
}
