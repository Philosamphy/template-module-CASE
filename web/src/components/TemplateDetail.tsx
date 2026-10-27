import { useState } from "react";
import { approveTemplate, deactivateTemplate, rejectTemplate, updateTemplate } from "../api";
import type { Template, WorkflowStep } from "../types";
import StepsEditor from "./StepsEditor";
import { ActiveBadge, ErrorBox, OriginBadge, StatusBadge } from "./ui";

interface Props {
  template: Template;
  isApprover: boolean;
  onUpdated: (template: Template) => void;
  onDeactivated: (template: Template) => void;
  onBack: () => void;
}

const STEP_TYPE_STYLES: Record<string, string> = {
  review: "border-sky-200 bg-sky-50 text-sky-700",
  validation: "border-amber-200 bg-amber-50 text-amber-700",
  approval: "border-emerald-200 bg-emerald-50 text-emerald-700",
  notification: "border-violet-200 bg-violet-50 text-violet-700",
};

export default function TemplateDetail({
  template,
  isApprover,
  onUpdated,
  onDeactivated,
  onBack,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(template.name);
  const [steps, setSteps] = useState<WorkflowStep[]>(template.steps);
  const [comments, setComments] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const canEdit = template.reviewStatus !== "APPROVED";

  const run = async (action: () => Promise<Template>) => {
    setBusy(true);
    setError(null);
    try {
      onUpdated(await action());
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(() => updateTemplate(template.templateId, { name, steps }));

  const startEdit = () => {
    setName(template.name);
    setSteps(template.steps);
    setError(null);
    setEditing(true);
  };

  const reject = async () => {
    if (!comments.trim()) {
      setError(new Error("A rejection reason is required."));
      return;
    }
    await run(() => rejectTemplate(template.templateId, comments.trim()));
    setComments("");
  };

  const deactivate = async () => {
    setBusy(true);
    setError(null);
    try {
      onDeactivated(await deactivateTemplate(template.templateId));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-slate-500 hover:text-slate-700"
      >
        ← Back to templates
      </button>

      <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">{template.name}</h2>
            <p className="mt-1 font-mono text-xs text-slate-400">{template.templateId}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <OriginBadge origin={template.origin} />
            <StatusBadge status={template.reviewStatus} />
            <ActiveBadge active={template.isActive} />
          </div>
        </div>

        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Version</dt>
            <dd className="text-slate-700">v{template.version}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Created by</dt>
            <dd className="text-slate-700">{template.createdBy ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Last decision</dt>
            <dd className="text-slate-700">
              {template.reviewedBy ? `${template.reviewedBy} · ${template.reviewStatus}` : "No decision yet"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Updated</dt>
            <dd className="text-slate-700">{new Date(template.updatedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </header>

      <ErrorBox error={error} />

      {/* Review decision panel — only rendered for approvers looking at a PENDING template.
          The server enforces the same rule independently. */}
      {template.reviewStatus === "PENDING" && isApprover && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h3 className="text-sm font-semibold text-amber-900">Review decision</h3>
          <p className="mt-1 text-sm text-amber-800">
            Validation runs again on the server before any decision is recorded.
          </p>
          <textarea
            value={comments}
            onChange={(event) => setComments(event.target.value)}
            rows={2}
            placeholder="Comments (required for rejection)"
            className="mt-3 w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => approveTemplate(template.templateId, comments.trim() || undefined))}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
            >
              Approve & activate
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={reject}
              className="rounded-lg border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
            >
              Reject
            </button>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Steps ({template.steps.length})</h3>
          {canEdit && !editing && (
            <button
              type="button"
              onClick={startEdit}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              Edit
            </button>
          )}
        </div>

        {editing ? (
          <div className="space-y-4">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <StepsEditor steps={steps} onChange={setSteps} disabled={busy} />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={save}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
              >
                {busy ? "Saving…" : "Save & revalidate"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <ol className="space-y-3">
            {template.steps.map((step, index) => (
              <li key={step.id} className="flex gap-3 rounded-lg border border-slate-200 p-3">
                <span className="w-6 shrink-0 text-sm font-semibold text-slate-400">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800">{step.name}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        STEP_TYPE_STYLES[step.type] ?? "border-slate-200 bg-slate-50 text-slate-600"
                      }`}
                    >
                      {step.type}
                    </span>
                    <span className="font-mono text-xs text-slate-400">{step.id}</span>
                    {step.assignedRole && (
                      <span className="text-xs text-slate-500">role: {step.assignedRole}</span>
                    )}
                    {step.channel && <span className="text-xs text-slate-500">via {step.channel}</span>}
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
        )}

        {!canEdit && !editing && (
          <p className="mt-3 text-xs text-slate-500">
            Approved templates are locked. Create a new version if changes are needed.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700">Review history</h3>
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {(template.reviews ?? []).map((review) => (
            <li key={review.reviewId} className="flex flex-wrap items-center gap-3 py-2">
              <StatusBadge status={review.status} />
              <span className="text-slate-600">{review.reviewedBy ?? "system"}</span>
              <span className="text-xs text-slate-400">
                {new Date(review.createdAt).toLocaleString()}
              </span>
              {review.comments && <span className="text-slate-500">“{review.comments}”</span>}
            </li>
          ))}
          {(template.reviews ?? []).length === 0 && (
            <li className="py-2 text-slate-500">No review records.</li>
          )}
        </ul>
      </section>

      {template.isActive && (
        <button
          type="button"
          disabled={busy}
          onClick={deactivate}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60"
        >
          Deactivate template
        </button>
      )}
    </article>
  );
}
