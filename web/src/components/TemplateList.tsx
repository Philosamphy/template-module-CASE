import type { ListFilters } from "../api";
import type { Template } from "../types";
import { ActiveBadge, ErrorBox, OriginBadge, StatusBadge } from "./ui";

interface Props {
  templates: Template[];
  loading: boolean;
  error: unknown;
  filters: ListFilters;
  onFiltersChange: (filters: ListFilters) => void;
  onOpen: (id: string) => void;
  onApprove: (template: Template) => void;
  onDeactivate: (template: Template) => void;
  onRefresh: () => void;
}

export default function TemplateList({
  templates,
  loading,
  error,
  filters,
  onFiltersChange,
  onOpen,
  onApprove,
  onDeactivate,
  onRefresh,
}: Props) {
  const select =
    "rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filters.origin ?? ""}
          onChange={(event) => onFiltersChange({ ...filters, origin: event.target.value })}
          className={select}
        >
          <option value="">All origins</option>
          <option value="MANUAL">Manual</option>
          <option value="AI_DRAFTED">AI drafted</option>
        </select>

        <select
          value={filters.status ?? ""}
          onChange={(event) => onFiltersChange({ ...filters, status: event.target.value })}
          className={select}
        >
          <option value="">All review statuses</option>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </select>

        <select
          value={filters.is_active ?? ""}
          onChange={(event) => onFiltersChange({ ...filters, is_active: event.target.value })}
          className={select}
        >
          <option value="">Any activation</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>

        <button
          type="button"
          onClick={onRefresh}
          className="ml-auto rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <ErrorBox error={error} />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Template</th>
              <th className="px-4 py-3">Origin</th>
              <th className="px-4 py-3">Review status</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Steps</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  Loading templates…
                </td>
              </tr>
            )}

            {!loading && templates.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  No templates match these filters.
                </td>
              </tr>
            )}

            {templates.map((template) => (
              <tr key={template.templateId} className="hover:bg-slate-50/70">
                <td className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => onOpen(template.templateId)}
                    className="font-medium text-indigo-700 hover:underline"
                  >
                    {template.name}
                  </button>
                  <div className="text-xs text-slate-400">v{template.version}</div>
                </td>
                <td className="px-4 py-3">
                  <OriginBadge origin={template.origin} />
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={template.reviewStatus} />
                </td>
                <td className="px-4 py-3">
                  <ActiveBadge active={template.isActive} />
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {template.steps.map((step) => step.type).join(" → ")}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onOpen(template.templateId)}
                      className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100"
                    >
                      Open
                    </button>
                    {template.reviewStatus === "PENDING" && (
                      <button
                        type="button"
                        onClick={() => onApprove(template)}
                        className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-50"
                      >
                        Approve
                      </button>
                    )}
                    {template.isActive && (
                      <button
                        type="button"
                        onClick={() => onDeactivate(template)}
                        className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-100"
                      >
                        Deactivate
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
