import { jsonResponse } from "../utils/response";
import * as taskService from "../services/task.service";
import { CreateTaskInput, UpdateTaskInput } from "../types/task.types";

export async function handleGetAllTasks() {
  const tasks = taskService.getAllTasks();
  return jsonResponse(tasks, 200);
}

export async function handleGetTaskById(id: number) {
  const task = taskService.getTaskById(id);

  if (!task) {
    return jsonResponse({ error: "Task not found" }, 404);
  }

  return jsonResponse(task, 200);
}

export async function handleCreateTask(request: Request) {
  const body = (await request.json()) as CreateTaskInput;

  if (!body.title || typeof body.title !== "string") {
    return jsonResponse({ error: "Title is required" }, 400);
  }

  const newTask = taskService.createTask(body);
  return jsonResponse(newTask, 201);
}

export async function handleUpdateTask(id: number, request: Request) {
  const body = (await request.json()) as UpdateTaskInput;

  const updatedTask = taskService.updateTask(id, body);

  if (!updatedTask) {
    return jsonResponse({ error: "Task not found" }, 404);
  }

  return jsonResponse(updatedTask, 200);
}

export async function handleDeleteTask(id: number) {
  const deleted = taskService.deleteTask(id);

  if (!deleted) {
    return jsonResponse({ error: "Task not found" }, 404);
  }

  return jsonResponse({ message: "Task deleted" }, 200);
}
