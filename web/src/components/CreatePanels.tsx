import { useState } from "react";
import { createTemplate, generateTemplate } from "../api";
import type { Template, WorkflowStep } from "../types";
import StepsEditor from "./StepsEditor";
import { ErrorBox } from "./ui";

export function NewTemplate({ onCreated }: { onCreated: (template: Template) => void }) {
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<WorkflowStep[]>([
    { id: "step-1", name: "Review Complaint", type: "review", description: "Review the submitted complaint." },
    {
      id: "step-2",
      name: "Check Required Details",
      type: "validation",
      description: "Check that the complaint contains all required information.",
    },
    {
      id: "step-3",
      name: "Obtain Approval",
      type: "approval",
      description: "Obtain approval if required by policy.",
    },
    {
      id: "step-4",
      name: "Notify Requester",
      type: "notification",
      description: "Notify the requester of the outcome.",
      channel: "email",
    },
  ]);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const template = await createTemplate({ name, steps });
      onCreated(template);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700">Template name</label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Maintenance Complaint Workflow"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-medium text-slate-700">Steps</h3>
          <span className="text-xs text-slate-400">Ordered top to bottom</span>
        </div>
        <StepsEditor steps={steps} onChange={setSteps} />
      </div>

      <ErrorBox error={error} />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Create template"}
        </button>
        <p className="text-xs text-slate-500">
          New templates start as <strong>PENDING</strong> and <strong>inactive</strong> until an approver signs off.
        </p>
      </div>
    </form>
  );
}

export function GeneratePanel({ onCreated }: { onCreated: (template: Template) => void }) {
  const [prompt, setPrompt] = useState(
    "Create a workflow for a maintenance complaint submitted in Malay. Include reviewing the complaint, checking required details, obtaining approval if needed, and notifying the requester.",
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const template = await generateTemplate(prompt);
      onCreated(template);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-800">
        The model proposes a draft only. It is validated, saved as <strong>AI_DRAFTED / PENDING /
        inactive</strong>, and cannot approve, activate or notify anything by itself.
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700">Describe the workflow</label>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={6}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      <ErrorBox error={error} />

      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60"
      >
        {busy ? "Generating with Ollama…" : "Generate draft"}
      </button>
    </form>
  );
}
