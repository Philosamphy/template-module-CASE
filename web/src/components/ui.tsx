import type { ReactNode } from "react";
import { ApiError } from "../api";
import type { Origin, ReviewStatus } from "../types";

export function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}
    >
      {children}
    </span>
  );
}

const ORIGIN_STYLES: Record<Origin, string> = {
  MANUAL: "bg-sky-50 text-sky-700 ring-sky-600/20",
  AI_DRAFTED: "bg-violet-50 text-violet-700 ring-violet-600/20",
};

export function OriginBadge({ origin }: { origin: Origin }) {
  return <Badge className={ORIGIN_STYLES[origin]}>{origin === "MANUAL" ? "Manual" : "AI Drafted"}</Badge>;
}

const STATUS_STYLES: Record<ReviewStatus, string> = {
  PENDING: "bg-amber-50 text-amber-700 ring-amber-600/30",
  APPROVED: "bg-emerald-50 text-emerald-700 ring-emerald-600/30",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-600/30",
};

export function StatusBadge({ status }: { status: ReviewStatus }) {
  return <Badge className={STATUS_STYLES[status]}>{status}</Badge>;
}

export function ActiveBadge({ active }: { active: boolean }) {
  return (
    <Badge
      className={
        active
          ? "bg-emerald-50 text-emerald-700 ring-emerald-600/30"
          : "bg-slate-100 text-slate-600 ring-slate-400/30"
      }
    >
      {active ? "Active" : "Inactive"}
    </Badge>
  );
}

/** Renders the server's structured validation payload: structural issues and business-rule violations. */
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const api = error instanceof ApiError ? error : null;
  const structural = api?.details.structural ?? [];
  const businessRules = api?.details.businessRules ?? [];
  const message = error instanceof Error ? error.message : "Something went wrong.";

  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <p className="font-medium">{message}</p>
      {api?.code && <p className="mt-0.5 text-xs text-rose-600">Error code: {api.code}</p>}

      {structural.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide">Structural validation</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {structural.map((issue, index) => (
              <li key={index}>
                <span className="font-mono">{issue.path}</span>: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {businessRules.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide">Business rules</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {businessRules.map((violation, index) => (
              <li key={index}>
                <span className="font-mono">{violation.rule}</span>
                {violation.stepId ? ` (step ${violation.stepId})` : ""}: {violation.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
