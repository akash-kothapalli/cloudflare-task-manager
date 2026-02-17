import { Task, CreateTaskInput, UpdateTaskInput } from "../types/task.types";

let tasks: Task[] = [];
let currentId = 1;

export function getAllTasks(): Task[] {
  return tasks;
}

export function getTaskById(id: number): Task | null {
  return tasks.find(t => t.id === id) || null;
}

export function createTask(input: CreateTaskInput): Task {
  const newTask: Task = {
    id: currentId++,
    title: input.title,
    completed: false,
  };

  tasks.push(newTask);
  return newTask;
}

export function updateTask(id: number, input: UpdateTaskInput): Task | null {
  const task = tasks.find(t => t.id === id);

  if (!task) return null;

  if (input.title !== undefined) task.title = input.title;
  if (input.completed !== undefined) task.completed = input.completed;

  return task;
}

export function deleteTask(id: number): boolean {
  const index = tasks.findIndex(t => t.id === id);

  if (index === -1) return false;

  tasks.splice(index, 1);
  return true;
}
