import { useCallback, useEffect, useState } from "react";
import { cancelInstance, getInstance, openInstanceDocument, respondInstance } from "../api";
import type { InstanceDetail, StepRun, StepRunStatus } from "../types";
import { ErrorBox, InstanceStatusBadge } from "./ui";

interface Props {
  instanceId: string;
  /** workflow:respond / workflow:cancel, from /api/operators/me. */
  canRespond: boolean;
  canCancel: boolean;
  onBack: () => void;
  onNotice?: (message: string) => void;
}

const RUN_STATUS_LABEL: Record<StepRunStatus, string> = {
  COMPLETED: "Done",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SIMULATED: "Simulated — nothing was sent",
  FAILED: "Failed",
};

const RUN_STATUS_STYLE: Record<StepRunStatus, string> = {
  COMPLETED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  APPROVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
  SIMULATED: "border-violet-200 bg-violet-50 text-violet-700",
  FAILED: "border-rose-200 bg-rose-50 text-rose-700",
};

const TERMINAL = ["COMPLETED", "REJECTED", "CANCELLED"];

/**
 * One workflow run: the case input, the step timeline, the approval gate
 * (while PAUSED) and the document a `document` step produced.
 */
export default function RunDetail({
  instanceId,
  canRespond,
  canCancel,
  onBack,
  onNotice,
}: Props) {
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [comments, setComments] = useState("");
  const [busy, setBusy] = useState(false);
  const [docError, setDocError] = useState<unknown>(null);

  const refresh = useCallback(() => {
    setError(null);
    getInstance(instanceId)
      .then(setDetail)
      .catch((caught) => setError(caught));
  }, [instanceId]);

  useEffect(() => {
    setDetail(null);
    refresh();
  }, [refresh]);

  const respond = async (approved: boolean) => {
    if (!approved && !comments.trim()) {
      setError(new Error("A rejection reason is required."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await respondInstance(instanceId, {
        approved,
        comments: comments.trim() || undefined,
      });
      setDetail(updated);
      setComments("");
      onNotice?.(
        approved
          ? `Run ${updated.instance.status.toLowerCase()} after approval.`
          : "Run rejected at the approval gate — no later step executed.",
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await cancelInstance(instanceId);
      setDetail(updated);
      onNotice?.("Run cancelled; its history was kept.");
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const openDocument = async (stepId: string) => {
    setDocError(null);
    try {
      await openInstanceDocument(instanceId, stepId);
    } catch (caught) {
      setDocError(caught);
    }
  };

  if (!detail && !error) {
    return <p className="text-sm text-slate-500">Loading run…</p>;
  }

  const { instance, stepRuns, pendingApproval } = detail ?? {
    instance: null,
    stepRuns: [],
    pendingApproval: null,
  };
  if (!instance) {
    return <ErrorBox error={error} />;
  }

  const runsByStep = new Map<string, StepRun>(stepRuns.map((run) => [run.stepId, run]));
  const isTerminal = TERMINAL.includes(instance.status);
  const inputEntries = Object.entries(instance.input);

  return (
    <article className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-slate-500 hover:text-slate-700"
      >
        ← Back to runs
      </button>

      <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">{instance.templateName}</h2>
            <p className="mt-1 font-mono text-xs text-slate-400">{instance.instanceId}</p>
          </div>
          <InstanceStatusBadge status={instance.status} />
        </div>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Template version</dt>
            <dd className="text-slate-700">v{instance.templateVersion}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Started by</dt>
            <dd className="text-slate-700">{instance.createdBy ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-400">Started</dt>
            <dd className="text-slate-700">{new Date(instance.createdAt).toLocaleString()}</dd>
          </div>
        </dl>
      </header>

      <ErrorBox error={error} />
      <ErrorBox error={docError} />

      {/* Approval gate — mirrors the interrupt payload the graph is paused on. */}
      {pendingApproval && instance.status === "PAUSED" && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-amber-900">
              Approval gate — step {pendingApproval.stepNumber} of {pendingApproval.totalSteps}
            </h3>
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
              Waiting for a decision
            </span>
          </div>

          <div className="mt-3 rounded-lg border border-amber-200 bg-white p-4">
            <p className="font-medium text-slate-800">{pendingApproval.step.name}</p>
            <p className="mt-1 text-sm text-slate-600">{pendingApproval.step.description}</p>
            {pendingApproval.step.assignedRole && (
              <p className="mt-1 text-xs text-slate-400">
                Role: {pendingApproval.step.assignedRole}
              </p>
            )}
          </div>

          {canRespond ? (
            <>
              <textarea
                value={comments}
                onChange={(event) => setComments(event.target.value)}
                rows={2}
                placeholder="Comments (required to reject)"
                className="mt-3 w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => respond(true)}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
                >
                  Approve & continue
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => respond(false)}
                  className="rounded-lg border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
                >
                  Reject run
                </button>
              </div>
            </>
          ) : (
            <p className="mt-3 text-sm text-amber-800">
              Only an operator or an admin can answer this gate — auditors are read-only.
              Switch the identity in the header to continue.
            </p>
          )}
        </section>
      )}

      {inputEntries.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">Case input</h3>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {inputEntries.map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <dt className="w-40 shrink-0 text-slate-500">{key}</dt>
                <dd className="min-w-0 flex-1 break-words text-slate-800">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700">
          Execution timeline ({stepRuns.length} of {instance.steps.length} steps run)
        </h3>
        <ol className="mt-3 space-y-3">
          {instance.steps.map((step, index) => {
            const run = runsByStep.get(step.id);
            const isCurrent = instance.status === "PAUSED" && instance.currentStep === step.id;
            const documentFile = run?.result.file;
            const hasDocument =
              typeof documentFile === "string" && documentFile.length > 0;

            return (
              <li
                key={step.id}
                className={`flex gap-3 rounded-lg border p-3 ${
                  isCurrent ? "border-amber-300 bg-amber-50/60" : "border-slate-200"
                }`}
              >
                <span className="w-6 shrink-0 text-sm font-semibold text-slate-400">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800">{step.name}</span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
                      {step.type}
                    </span>
                    {run ? (
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs ${RUN_STATUS_STYLE[run.status]}`}
                      >
                        {RUN_STATUS_LABEL[run.status]}
                        {run.performedBy ? ` · ${run.performedBy}` : ""}
                      </span>
                    ) : isCurrent ? (
                      <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                        Waiting at this step
                      </span>
                    ) : (
                      <span className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-400">
                        Not run yet
                      </span>
                    )}
                    {hasDocument && (
                      <button
                        type="button"
                        onClick={() => openDocument(step.id)}
                        className="rounded-md border border-indigo-200 px-2.5 py-0.5 text-xs text-indigo-700 hover:bg-indigo-50"
                      >
                        Open document
                      </button>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{step.description}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {!isTerminal && canCancel && (
        <button
          type="button"
          disabled={busy}
          onClick={cancel}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60"
        >
          Cancel run
        </button>
      )}
    </article>
  );
}
