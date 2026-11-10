import type { ErrorDetails, InstanceDetail, Me, Member, Template, WorkflowInstance } from "./types";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8000";

/** Dev identity switcher fallback, matching the operators seeded by the migration. */
export const OPERATORS: Member[] = [
  {
    id: "ops-admin",
    displayName: "Aisyah (Admin)",
    email: "aisyah@workspace.local",
    role: "admin",
    revokedAt: null,
  },
  {
    id: "ops-operator",
    displayName: "Aiman (Operator)",
    email: "aiman@workspace.local",
    role: "operator",
    revokedAt: null,
  },
  {
    id: "ops-auditor",
    displayName: "Chong (Auditor)",
    email: "chong@workspace.local",
    role: "auditor",
    revokedAt: null,
  },
];

const OPERATOR_STORAGE_KEY = "template-module.operator";

/** Seeded operator identity used before anything is chosen. */
const DEFAULT_OPERATOR_ID = "ops-operator";

export function getOperatorId(): string {
  return localStorage.getItem(OPERATOR_STORAGE_KEY) ?? DEFAULT_OPERATOR_ID;
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

/* ---------------- members (roles) ---------------- */

/** Who the caller is, and what the server says they may do. */
export async function getMe(): Promise<Me> {
  return request<Me>("/api/operators/me");
}

/** The operator directory — names and roles, for the identity switcher. */
export async function listMembers(): Promise<Member[]> {
  const payload = await request<{ operators: Member[] }>("/api/operators");
  return payload.operators;
}

/**
 * Admin only (users:manage): whitelist an email as operator or auditor.
 * Inviting a previously revoked email restores that same member.
 */
export async function addMember(body: {
  email: string;
  displayName?: string;
  role: "operator" | "auditor";
}): Promise<Member> {
  const payload = await request<{ operator: Member }>("/api/operators", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return payload.operator;
}

/**
 * Admin only (users:manage): remove a member's access. The member record and
 * all of their history stay in place for auditing.
 */
export async function revokeMember(id: string): Promise<Member> {
  const payload = await request<{ operator: Member }>(
    `/api/operators/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  return payload.operator;
}

/** Admin only (users:manage): switch a member between operator and auditor. */
export async function setMemberRole(
  id: string,
  role: "operator" | "auditor",
): Promise<Member> {
  const payload = await request<{ operator: Member }>(
    `/api/operators/${encodeURIComponent(id)}/role`,
    { method: "PATCH", body: JSON.stringify({ role }) },
  );
  return payload.operator;
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

/* ---------------- workflow runs (execution) ---------------- */

export interface InstanceListFilters {
  status?: string;
  template_id?: string;
}

export async function listInstances(
  filters: InstanceListFilters = {},
): Promise<WorkflowInstance[]> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const query = params.toString();
  const payload = await request<{ instances: WorkflowInstance[] }>(
    `/api/instances${query ? `?${query}` : ""}`,
  );
  return payload.instances;
}

export async function getInstance(id: string): Promise<InstanceDetail> {
  return request<InstanceDetail>(`/api/instances/${id}`);
}

export async function startInstance(body: {
  templateId: string;
  input?: Record<string, string>;
}): Promise<InstanceDetail> {
  return request<InstanceDetail>("/api/instances", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function respondInstance(
  id: string,
  body: { approved: boolean; comments?: string },
): Promise<InstanceDetail> {
  return request<InstanceDetail>(`/api/instances/${id}/respond`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function cancelInstance(id: string): Promise<InstanceDetail> {
  return request<InstanceDetail>(`/api/instances/${id}/cancel`, { method: "POST" });
}

/**
 * Opens a generated document in a new tab. The file is fetched with the
 * operator header (a plain link would drop it), then shown via a blob URL.
 */
export async function openInstanceDocument(
  instanceId: string,
  stepId: string,
): Promise<void> {
  const response = await fetch(
    `${BASE}/api/instances/${instanceId}/documents/${stepId}`,
    { headers: { "x-operator-id": getOperatorId() } },
  );

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = payload?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? `Could not open the document (${response.status}).`,
      error?.details ?? {},
    );
  }

  const url = URL.createObjectURL(await response.blob());
  const opened = window.open(url, "_blank", "noopener");
  if (!opened) {
    URL.revokeObjectURL(url);
    throw new ApiError(
      0,
      "POPUP_BLOCKED",
      "The browser blocked the document tab — allow popups for this site and try again.",
      {},
    );
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
