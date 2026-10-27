import { useCallback, useEffect, useMemo, useState } from "react";
import {
  OPERATORS,
  approveTemplate,
  deactivateTemplate,
  getOperatorId,
  getTemplate,
  listTemplates,
  setOperatorId,
  type ListFilters,
} from "./api";
import { GeneratePanel, NewTemplate } from "./components/CreatePanels";
import TemplateDetail from "./components/TemplateDetail";
import TemplateList from "./components/TemplateList";
import type { Template } from "./types";

type View =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "generate" }
  | { kind: "detail"; id: string };

export default function App() {
  const [view, setView] = useState<View>({ kind: "list" });
  const [templates, setTemplates] = useState<Template[]>([]);
  const [detail, setDetail] = useState<Template | null>(null);
  const [filters, setFilters] = useState<ListFilters>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [operator, setOperator] = useState(getOperatorId());
  const [reload, setReload] = useState(0);

  const isApprover = operator === "ops-approver";

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listTemplates(filters)
      .then((result) => {
        if (!cancelled) setTemplates(result);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, reload]);

  useEffect(() => {
    if (view.kind !== "detail") {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setError(null);
    getTemplate(view.id)
      .then((template) => {
        if (!cancelled) setDetail(template);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught);
      });
    return () => {
      cancelled = true;
    };
  }, [view, reload]);

  const navItems = useMemo(
    () =>
      [
        { kind: "list" as const, label: "Templates" },
        { kind: "create" as const, label: "New manual template" },
        { kind: "generate" as const, label: "Generate with AI" },
      ],
    [],
  );

  const openTemplate = (id: string) => {
    setNotice(null);
    setView({ kind: "detail", id });
  };

  const handleCreated = (template: Template) => {
    setNotice(
      `${template.name} created as ${template.origin === "AI_DRAFTED" ? "an AI draft" : "a manual template"} — pending review, inactive.`,
    );
    refresh();
    openTemplate(template.templateId);
  };

  const handleUpdated = (template: Template) => {
    setNotice(`${template.name} updated and revalidated.`);
    refresh();
  };

  const handleApprove = async (template: Template) => {
    setError(null);
    try {
      const updated = await approveTemplate(template.templateId);
      setNotice(`${updated.name} approved and activated.`);
      refresh();
    } catch (caught) {
      setError(caught);
    }
  };

  const handleDeactivate = async (template: Template) => {
    setError(null);
    try {
      const updated = await deactivateTemplate(template.templateId);
      setNotice(`${updated.name} deactivated.`);
      refresh();
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Workflow Template Console</h1>
          <p className="text-sm text-slate-500">
            Manual and AI-assisted templates · validated, reviewed, then activated
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-600">
          Signed in as
          <select
            value={operator}
            onChange={(event) => {
              setOperator(event.target.value);
              setOperatorId(event.target.value);
            }}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {OPERATORS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <nav className="mb-5 flex gap-1 border-b border-slate-200">
        {navItems.map((item) => (
          <button
            key={item.kind}
            type="button"
            onClick={() => {
              setNotice(null);
              setView({ kind: item.kind });
            }}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              view.kind === item.kind
                ? "border-indigo-600 text-indigo-700"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      {/* Each view renders its own error surface: the list, the detail panel and the
          create/generate forms each show the server's structured validation payload. */}

      <main className="flex-1">
        {view.kind === "list" && (
          <TemplateList
            templates={templates}
            loading={loading}
            error={error}
            filters={filters}
            onFiltersChange={setFilters}
            onOpen={openTemplate}
            onApprove={handleApprove}
            onDeactivate={handleDeactivate}
            onRefresh={refresh}
          />
        )}

        {view.kind === "create" && <NewTemplate onCreated={handleCreated} />}

        {view.kind === "generate" && <GeneratePanel onCreated={handleCreated} />}

        {view.kind === "detail" && detail && (
          <TemplateDetail
            key={detail.templateId}
            template={detail}
            isApprover={isApprover}
            onUpdated={handleUpdated}
            onDeactivated={(updated) => {
              setDetail(updated);
              setNotice(`${updated.name} deactivated.`);
              refresh();
            }}
            onBack={() => setView({ kind: "list" })}
          />
        )}

        {view.kind === "detail" && !detail && !error && (
          <p className="text-sm text-slate-500">Loading template…</p>
        )}
      </main>

      <footer className="mt-8 border-t border-slate-200 pt-4 text-xs text-slate-400">
        Approvals, rejections, edits and deactivation are enforced server-side; the UI only
        reflects the caller's permissions.
      </footer>
    </div>
  );
}
