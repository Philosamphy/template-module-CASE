-- 002_workflow_instances.sql — execution of approved templates.
-- An instance is one run of a workflow. The steps are SNAPSHOT at start time so
-- later edits or re-approval of the template never change a running instance.

CREATE TABLE IF NOT EXISTS workflow_instances (
  instance_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id      UUID NOT NULL REFERENCES workflow_templates(template_id) ON DELETE RESTRICT,
  template_name    TEXT NOT NULL CHECK (btrim(template_name) <> ''),
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  steps            JSONB NOT NULL,
  status           TEXT NOT NULL
                     CHECK (status IN ('RUNNING', 'PAUSED', 'COMPLETED', 'REJECTED', 'CANCELLED')),
  current_step     TEXT,
  cursor_index     INTEGER NOT NULL DEFAULT 0 CHECK (cursor_index >= 0),
  created_by       TEXT REFERENCES operators(operator_id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instance_steps_is_array CHECK (jsonb_typeof(steps) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_status ON workflow_instances (status);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_template ON workflow_instances (template_id);

-- One row per step that actually ran. The unique pair makes persistence
-- idempotent: a resumed LangGraph node can re-emit an event without duplicating.
CREATE TABLE IF NOT EXISTS step_runs (
  run_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id  UUID NOT NULL REFERENCES workflow_instances(instance_id) ON DELETE CASCADE,
  step_id      TEXT NOT NULL,
  step_type    TEXT NOT NULL
                 CHECK (step_type IN ('review', 'validation', 'approval', 'notification')),
  status       TEXT NOT NULL
                 CHECK (status IN ('COMPLETED', 'APPROVED', 'REJECTED', 'SIMULATED', 'FAILED')),
  performed_by TEXT REFERENCES operators(operator_id) ON DELETE SET NULL,
  result       JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (instance_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_step_runs_instance ON step_runs (instance_id, started_at);
