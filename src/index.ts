import { jsonResponse } from "./utils/response";
import {
  handleGetAllTasks,
  handleGetTaskById,
  handleCreateTask,
  handleUpdateTask,
  handleDeleteTask,
} from "./controllers/task.controller";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // Health check
    if (url.pathname === "/health" && method === "GET") {
      return jsonResponse({ status: "ok" }, 200);
    }

    // Root
    if (url.pathname === "/" && method === "GET") {
      return jsonResponse(
        { message: "Cloudflare Task Manager API Running" },
        200
      );
    }

    // GET /tasks
    if (url.pathname === "/tasks" && method === "GET") {
      return handleGetAllTasks();
    }

    // POST /tasks
    if (url.pathname === "/tasks" && method === "POST") {
      return handleCreateTask(request);
    }

    // Routes with ID
    if (url.pathname.startsWith("/tasks/")) {
      const id = Number(url.pathname.split("/")[2]);

      if (isNaN(id)) {
        return jsonResponse({ error: "Invalid ID" }, 400);
      }

      if (method === "GET") {
        return handleGetTaskById(id);
      }

      if (method === "PUT") {
        return handleUpdateTask(id, request);
      }

      if (method === "DELETE") {
        return handleDeleteTask(id);
      }
    }

    return jsonResponse({ error: "Not Found" }, 404);
  },
};
