import { useCallback, useEffect, useMemo, useState } from "react";
import {
  OPERATORS,
  approveTemplate,
  deactivateTemplate,
  getMe,
  getOperatorId,
  getTemplate,
  listMembers,
  listTemplates,
  setOperatorId,
  type ListFilters,
} from "./api";
import { GeneratePanel, NewTemplate } from "./components/CreatePanels";
import Members from "./components/Members";
import RunDetail from "./components/RunDetail";
import RunsView from "./components/RunsView";
import TemplateDetail from "./components/TemplateDetail";
import TemplateList from "./components/TemplateList";
import type { Me, Member, Template } from "./types";

type View =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "generate" }
  | { kind: "detail"; id: string }
  | { kind: "runs" }
  | { kind: "run"; id: string }
  | { kind: "members" };

/** Nav targets are always payload-free views ("detail"/"run" need an id). */
type NavKind = Exclude<View["kind"], "detail" | "run">;

interface NavItem {
  kind: NavKind;
  label: string;
  permission?: string;
}

const NAV: NavItem[] = [
  { kind: "list", label: "Templates" },
  { kind: "create", label: "New manual template", permission: "template:create" },
  { kind: "generate", label: "Generate with AI", permission: "template:generate" },
  { kind: "runs", label: "Runs" },
  { kind: "members", label: "Members", permission: "users:manage" },
];

export default function App() {
  const [view, setView] = useState<View>({ kind: "list" });
  const [templates, setTemplates] = useState<Template[]>([]);
  const [detail, setDetail] = useState<Template | null>(null);
  const [filters, setFilters] = useState<ListFilters>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [members, setMembers] = useState<Member[]>(OPERATORS);
  const [operator, setOperator] = useState(getOperatorId());
  const [reload, setReload] = useState(0);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  /** Permission check for *display only* — the server re-checks every action. */
  const can = useCallback(
    (permission: string) => me?.permissions.includes(permission) ?? false,
    [me],
  );

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((result) => {
        if (!cancelled) setMe(result);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught);
      });
    return () => {
      cancelled = true;
    };
  }, [operator, reload]);

  const loadMembers = useCallback(() => {
    listMembers()
      .then(setMembers)
      .catch(() => setMembers(OPERATORS));
  }, []);

  useEffect(() => {
    loadMembers();
  }, [loadMembers, operator, reload]);

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

  // Switching identity can remove access to the current view (e.g. an auditor
  // opened Members). Fall back to the list rather than showing dead controls.
  useEffect(() => {
    if (!me) return;
    const allowed: Record<View["kind"], boolean> = {
      list: true,
      create: can("template:create"),
      generate: can("template:generate"),
      detail: true,
      runs: true,
      run: true,
      members: can("users:manage"),
    };
    if (!allowed[view.kind]) setView({ kind: "list" });
  }, [me, view.kind, can]);

  const navItems = useMemo(
    () => NAV.filter((item) => !item.permission || can(item.permission)),
    [can],
  );

  // Only members with access can be "signed in as"; revoked ones stay visible in
  // the Members screen but must not be selectable identities.
  const identityOptions = useMemo(() => {
    const active = (members.length > 0 ? members : OPERATORS).filter(
      (member) => member.revokedAt === null,
    );
    const list = active.length > 0 ? active : OPERATORS;
    if (list.some((member) => member.id === operator)) return list;
    return [
      {
        id: operator,
        displayName: `${operator} — access removed`,
        email: "",
        role: me?.operator.role ?? ("operator" as const),
        revokedAt: new Date().toISOString(),
      },
      ...list,
    ];
  }, [members, operator, me]);

  const switchOperator = (id: string) => {
    setOperator(id);
    setOperatorId(id);
    setNotice(null);
    setError(null);
    setView({ kind: "list" });
  };

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
            onChange={(event) => switchOperator(event.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {identityOptions.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName} — {member.role}
              </option>
            ))}
          </select>
        </label>
      </header>

      <nav className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
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
            canApprove={can("template:approve")}
            canDeactivate={can("template:deactivate")}
          />
        )}

        {view.kind === "create" && <NewTemplate onCreated={handleCreated} />}

        {view.kind === "generate" && <GeneratePanel onCreated={handleCreated} />}

        {view.kind === "detail" && detail && (
          <TemplateDetail
            key={detail.templateId}
            template={detail}
            canEdit={can("template:edit")}
            canApprove={can("template:approve")}
            canDeactivate={can("template:deactivate")}
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

        {view.kind === "runs" && (
          <RunsView
            canStart={can("workflow:start")}
            onOpen={(id) => {
              setNotice(null);
              setView({ kind: "run", id });
            }}
            onNotice={setNotice}
          />
        )}

        {view.kind === "run" && (
          <RunDetail
            key={view.id}
            instanceId={view.id}
            canRespond={can("workflow:respond")}
            canCancel={can("workflow:cancel")}
            onNotice={setNotice}
            onBack={() => setView({ kind: "runs" })}
          />
        )}

        {view.kind === "members" && (
          <Members
            members={members}
            currentId={operator}
            onChanged={() => {
              loadMembers();
              refresh();
            }}
          />
        )}
      </main>

      <footer className="mt-8 border-t border-slate-200 pt-4 text-xs text-slate-400">
        Roles are enforced server-side: admins manage members, operators create/approve/run,
        auditors read only. The UI only mirrors the caller's permissions.
      </footer>
    </div>
  );
}
