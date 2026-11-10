import { useCallback, useEffect, useState } from "react";
import { listInstances, listTemplates, startInstance } from "../api";
import type { Template, WorkflowInstance } from "../types";
import { ErrorBox, InstanceStatusBadge } from "./ui";

interface Props {
  onOpen: (instanceId: string) => void;
  onNotice?: (message: string) => void;
  /** workflow:start — auditors can still open runs, they just cannot start one. */
  canStart: boolean;
}

interface InputRow {
  key: string;
  value: string;
}

const selectClass =
  "rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
const inputClass =
  "rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";

/**
 * Workflow runs: start one execution of an approved template with case data,
 * then open it to watch the steps and answer the approval gate.
 */
export default function RunsView({ onOpen, onNotice, canStart }: Props) {
  const [instances, setInstances] = useState<WorkflowInstance[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [showStart, setShowStart] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [rows, setRows] = useState<InputRow[]>([{ key: "", value: "" }]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    listInstances()
      .then((result) => setInstances(result))
      .catch((caught) => setError(caught))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Only APPROVED + active templates may execute — the server enforces this too.
  useEffect(() => {
    listTemplates({ status: "APPROVED", is_active: "true" })
      .then((result) => {
        setTemplates(result);
        setTemplateId((current) => current || result[0]?.templateId || "");
      })
      .catch((caught) => setError(caught));
  }, []);

  const start = async () => {
    if (!templateId) return;
    setBusy(true);
    setError(null);
    try {
      const input: Record<string, string> = {};
      rows.forEach((row) => {
        const key = row.key.trim();
        if (key) input[key] = row.value;
      });
      const detail = await startInstance({ templateId, input });
      onNotice?.(
        `Run started — ${detail.instance.templateName} is ${
          detail.instance.status === "PAUSED"
            ? `waiting at step ${detail.instance.cursorIndex + 1}`
            : detail.instance.status
        }.`,
      );
      setShowStart(false);
      setRows([{ key: "", value: "" }]);
      onOpen(detail.instance.instanceId);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const waitingLabel = (instance: WorkflowInstance): string => {
    const step = instance.steps.find((entry) => entry.id === instance.currentStep);
    return step ? `Step ${instance.cursorIndex + 1}: ${step.name}` : "—";
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-800">Workflow runs</h2>
          <p className="text-xs text-slate-500">
            Start a run with case data, watch each step, and answer approval gates.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={refresh}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Refresh
          </button>
          {canStart && (
            <button
              type="button"
              onClick={() => setShowStart((value) => !value)}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              {showStart ? "Close" : "Start run"}
            </button>
          )}
        </div>
      </div>

      {showStart && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-5">
          <h3 className="text-sm font-semibold text-indigo-900">Start a workflow run</h3>

          {templates.length === 0 ? (
            <p className="mt-2 text-sm text-indigo-800">
              No approved, active templates yet — approve one on the Templates tab first.
            </p>
          ) : (
            <>
              <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-indigo-700">
                Template
              </label>
              <select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                className={`mt-1 w-full max-w-xl ${selectClass}`}
              >
                {templates.map((template) => (
                  <option key={template.templateId} value={template.templateId}>
                    {template.name} (v{template.version})
                  </option>
                ))}
              </select>

              <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-indigo-700">
                Case input <span className="font-normal normal-case">(feeds document steps)</span>
              </label>
              <div className="mt-1 space-y-2">
                {rows.map((row, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      value={row.key}
                      placeholder="Field name, e.g. complainant"
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((entry, i) =>
                            i === index ? { ...entry, key: event.target.value } : entry,
                          ),
                        )
                      }
                      className={`w-56 ${inputClass}`}
                    />
                    <input
                      value={row.value}
                      placeholder="Value"
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((entry, i) =>
                            i === index ? { ...entry, value: event.target.value } : entry,
                          ),
                        )
                      }
                      className={`flex-1 ${inputClass}`}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setRows((current) => current.filter((_, i) => i !== index))
                      }
                      className="rounded-md border border-slate-300 px-2 text-xs text-slate-500 hover:bg-white"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setRows((current) => [...current, { key: "", value: "" }])}
                  className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-sm text-indigo-700 hover:bg-indigo-50"
                >
                  Add field
                </button>
                <button
                  type="button"
                  disabled={busy || !templateId}
                  onClick={start}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
                >
                  {busy ? "Starting…" : "Start run"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <ErrorBox error={error} />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Template</th>
              <th className="px-4 py-3">Waiting on</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && instances.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  Loading runs…
                </td>
              </tr>
            )}

            {!loading && instances.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  No runs yet.{canStart ? " Start one above." : ""}
                </td>
              </tr>
            )}

            {instances.map((instance) => (
              <tr key={instance.instanceId} className="hover:bg-slate-50/70">
                <td className="px-4 py-3">
                  <InstanceStatusBadge status={instance.status} />
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-800">{instance.templateName}</div>
                  <div className="font-mono text-xs text-slate-400">
                    {instance.instanceId.slice(0, 8)}…
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {instance.status === "PAUSED" ? waitingLabel(instance) : "—"}
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">
                  {new Date(instance.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onOpen(instance.instanceId)}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100"
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
