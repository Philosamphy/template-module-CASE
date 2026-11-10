import { useState } from "react";
import { addMember, revokeMember, setMemberRole } from "../api";
import type { Member, Role } from "../types";
import { Badge, ErrorBox } from "./ui";

const ROLE_STYLES: Record<Role, string> = {
  admin: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  operator: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  auditor: "bg-slate-100 text-slate-600 ring-slate-400/30",
};

const ROLE_HINT: Record<Role, string> = {
  admin: "Everything an operator can do, plus member management",
  operator: "Create, edit and approve templates · run workflows",
  auditor: "Read-only: templates, runs and documents",
};

interface Props {
  members: Member[];
  currentId: string;
  onChanged: () => void;
}

/**
 * Admin-only member management: whitelist an email as operator or auditor,
 * switch a member between those two roles, and remove someone's access.
 *
 * Removing access is a soft delete: the server stops authenticating them but
 * keeps the member row, so every template, review and run they touched still
 * names them. Inviting the same email again restores that same member.
 */
export default function Members({ members, currentId, onChanged }: Props) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [newRole, setNewRole] = useState<"operator" | "auditor">("operator");
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const member = await addMember({
        email: email.trim(),
        displayName: displayName.trim() || undefined,
        role: newRole,
      });
      setEmail("");
      setDisplayName("");
      setNote(`${member.email} now has access as ${member.role}.`);
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: Member, next: "operator" | "auditor") => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const updated = await setMemberRole(member.id, next);
      setNote(`${updated.displayName} is now ${updated.role}.`);
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (member: Member) => {
    const ok = window.confirm(
      `Remove ${member.displayName}'s access?\n\nThey will no longer be able to sign in. Their templates, reviews and runs are kept for auditing.`,
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const updated = await revokeMember(member.id);
      setNote(`${updated.displayName} no longer has access. Their history is kept.`);
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (member: Member) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const updated = await addMember({
        email: member.email,
        displayName: member.displayName,
        role: member.role === "admin" ? "operator" : member.role,
      });
      setNote(`${updated.displayName} can access the workspace again.`);
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-slate-800">Members &amp; roles</h2>
        <p className="text-xs text-slate-500">
          Admins whitelist email addresses, switch roles, and remove access. Removed members
          keep their work in the audit trail.
        </p>
      </div>

      <form onSubmit={invite} className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-5">
        <h3 className="text-sm font-semibold text-indigo-900">Invite by email</h3>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-64 flex-1 text-xs font-medium uppercase tracking-wide text-indigo-700">
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="farid.hakim@agency.gov.my"
              className="mt-1 w-full rounded-md border border-indigo-300 bg-white px-2.5 py-1.5 text-sm normal-case tracking-normal text-slate-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </label>

          <label className="min-w-48 flex-1 text-xs font-medium uppercase tracking-wide text-indigo-700">
            Name <span className="font-normal normal-case">(optional)</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Farid Hakim"
              className="mt-1 w-full rounded-md border border-indigo-300 bg-white px-2.5 py-1.5 text-sm normal-case tracking-normal text-slate-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </label>

          <label className="text-xs font-medium uppercase tracking-wide text-indigo-700">
            Role
            <select
              value={newRole}
              onChange={(event) => setNewRole(event.target.value as "operator" | "auditor")}
              className="mt-1 block rounded-md border border-indigo-300 bg-white px-2.5 py-1.5 text-sm normal-case tracking-normal text-slate-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="operator">operator</option>
              <option value="auditor">auditor</option>
            </select>
          </label>

          <button
            type="submit"
            disabled={busy || !email.includes("@")}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Invite"}
          </button>
        </div>
        <p className="mt-2 text-xs text-indigo-800">
          {ROLE_HINT[newRole]} · the address itself becomes a valid sign-in identity.
        </p>
      </form>

      {note && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {note}
        </div>
      )}
      <ErrorBox error={error} />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Access</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.map((member) => {
              const isSelf = member.id === currentId;
              const revoked = member.revokedAt !== null;

              return (
                <tr
                  key={member.id}
                  className={revoked ? "bg-slate-50/60 text-slate-500" : "hover:bg-slate-50/70"}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">
                      {member.displayName}
                      {isSelf && <span className="ml-2 text-xs text-slate-400">(you)</span>}
                    </div>
                    <div className="text-xs text-slate-500">{member.email}</div>
                    <div className="font-mono text-xs text-slate-400">{member.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className={ROLE_STYLES[member.role]}>{member.role}</Badge>
                    <div className="mt-1 text-xs text-slate-500">{ROLE_HINT[member.role]}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-2">
                      {revoked ? (
                        <>
                          <Badge className="bg-rose-50 text-rose-700 ring-rose-600/20">
                            Access removed
                          </Badge>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => restore(member)}
                            className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                          >
                            Restore access
                          </button>
                        </>
                      ) : member.role === "admin" ? (
                        <span className="text-xs text-slate-400">
                          Admin access is provisioned outside this module.
                        </span>
                      ) : (
                        <>
                          <select
                            value={member.role}
                            disabled={busy || isSelf}
                            onChange={(event) =>
                              changeRole(member, event.target.value as "operator" | "auditor")
                            }
                            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 disabled:opacity-50"
                          >
                            <option value="operator">operator</option>
                            <option value="auditor">auditor</option>
                          </select>
                          <button
                            type="button"
                            disabled={busy || isSelf}
                            onClick={() => revoke(member)}
                            className="rounded-md border border-rose-200 px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-60"
                          >
                            Remove access
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-500">
                  No members yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
