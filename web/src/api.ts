import type { ErrorDetails, Template } from "./types";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8000";

export const OPERATORS = [
  { id: "ops-operator", label: "Aiman — Operator (create & edit)" },
  { id: "ops-approver", label: "Bagus — Approver (approve & reject)" },
] as const;

const OPERATOR_STORAGE_KEY = "template-module.operator";

export function getOperatorId(): string {
  return localStorage.getItem(OPERATOR_STORAGE_KEY) ?? OPERATORS[0].id;
}

export function setOperatorId(id: string): void {
  localStorage.setItem(OPERATOR_STORAGE_KEY, id);
}

/** Error carrying the server's structured payload so the UI can render it. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(status: number, code: string, message: string, details: ErrorDetails) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-operator-id": getOperatorId(),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? `Request failed (${response.status}).`,
      error?.details ?? {},
    );
  }
  return payload as T;
}

export interface ListFilters {
  origin?: string;
  status?: string;
  is_active?: string;
}

export async function listTemplates(filters: ListFilters = {}): Promise<Template[]> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const query = params.toString();
  const payload = await request<{ templates: Template[] }>(`/api/templates${query ? `?${query}` : ""}`);
  return payload.templates;
}

export async function getTemplate(id: string): Promise<Template> {
  const payload = await request<{ template: Template }>(`/api/templates/${id}`);
  return payload.template;
}

export async function createTemplate(body: {
  name: string;
  steps: unknown[];
}): Promise<Template> {
  const payload = await request<{ template: Template }>("/api/templates", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return payload.template;
}

export async function updateTemplate(
  id: string,
  body: { name?: string; steps?: unknown[] },
): Promise<Template> {
  const payload = await request<{ template: Template }>(`/api/templates/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return payload.template;
}

export async function generateTemplate(prompt: string): Promise<Template> {
  const payload = await request<{ template: Template }>("/api/templates/generate", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
  return payload.template;
}

export async function approveTemplate(id: string, comments?: string): Promise<Template> {
  const payload = await request<{ template: Template }>(`/api/templates/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ comments }),
  });
  return payload.template;
}

export async function rejectTemplate(id: string, comments: string): Promise<Template> {
  const payload = await request<{ template: Template }>(`/api/templates/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ comments }),
  });
  return payload.template;
}

export async function deactivateTemplate(id: string): Promise<Template> {
  const payload = await request<{ template: Template; deactivated: boolean }>(
    `/api/templates/${id}`,
    { method: "DELETE" },
  );
  return payload.template;
}
