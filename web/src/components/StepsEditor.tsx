import type { StepType, WorkflowStep } from "../types";

const STEP_TYPES: StepType[] = ["review", "validation", "approval", "notification"];

interface Props {
  steps: WorkflowStep[];
  onChange: (steps: WorkflowStep[]) => void;
  disabled?: boolean;
}

function nextId(steps: WorkflowStep[]): string {
  let index = steps.length + 1;
  const taken = new Set(steps.map((step) => step.id));
  while (taken.has(`step-${index}`)) index += 1;
  return `step-${index}`;
}

export default function StepsEditor({ steps, onChange, disabled = false }: Props) {
  const update = (index: number, patch: Partial<WorkflowStep>) => {
    onChange(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  };

  const remove = (index: number) => onChange(steps.filter((_, i) => i !== index));

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    onChange(next);
  };

  const add = () =>
    onChange([
      ...steps,
      {
        id: nextId(steps),
        name: "New step",
        type: "review",
        description: "",
      },
    ]);

  return (
    <div className="space-y-3">
      {steps.map((step, index) => (
        <div key={index} className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-8 shrink-0 text-center text-xs font-semibold text-slate-400">
              {index + 1}
            </span>
            <input
              value={step.name}
              disabled={disabled}
              onChange={(event) => update(index, { name: event.target.value })}
              placeholder="Step name"
              className="min-w-40 flex-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50"
            />
            <select
              value={step.type}
              disabled={disabled}
              onChange={(event) => update(index, { type: event.target.value as StepType })}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50"
            >
              {STEP_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <input
              value={step.id}
              disabled={disabled}
              onChange={(event) => update(index, { id: event.target.value })}
              placeholder="id"
              className="w-28 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50"
            />
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
                title="Move up"
                className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
              >
                ↑
              </button>
              <button
                type="button"
                disabled={disabled || index === steps.length - 1}
                onClick={() => move(index, 1)}
                title="Move down"
                className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
              >
                ↓
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(index)}
                title="Remove step"
                className="rounded border border-rose-200 px-2 py-1 text-xs text-rose-600 hover:bg-rose-50"
              >
                ✕
              </button>
            </div>
          </div>

          <textarea
            value={step.description}
            disabled={disabled}
            onChange={(event) => update(index, { description: event.target.value })}
            placeholder="What happens in this step?"
            rows={2}
            className="mt-2 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50"
          />

          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={step.assignedRole ?? ""}
              disabled={disabled}
              onChange={(event) => update(index, { assignedRole: event.target.value || undefined })}
              placeholder="Assigned role (optional)"
              className="rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50"
            />
            {step.type === "notification" && (
              <input
                value={step.channel ?? ""}
                disabled={disabled}
                onChange={(event) => update(index, { channel: event.target.value || undefined })}
                placeholder="Channel (email, telegram)"
                className="rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50"
              />
            )}
          </div>
        </div>
      ))}

      <button
        type="button"
        disabled={disabled}
        onClick={add}
        className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 hover:border-indigo-400 hover:text-indigo-600"
      >
        + Add step
      </button>
    </div>
  );
}
