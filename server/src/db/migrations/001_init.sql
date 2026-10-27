-- 001_init.sql — workflow template module schema.
-- Idempotent: safe to re-run. Applied by `npm run migrate` (and on server start
-- unless AUTO_MIGRATE=false).

CREATE TABLE IF NOT EXISTS operators (
  operator_id   TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL CHECK (display_name <> ''),
  role          TEXT NOT NULL CHECK (role IN ('operator', 'approver')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_templates (
  template_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (btrim(name) <> ''),
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  steps         JSONB NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('MANUAL', 'AI_DRAFTED')),
  is_active     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    TEXT REFERENCES operators(operator_id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT steps_is_array CHECK (jsonb_typeof(steps) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_workflow_templates_origin ON workflow_templates (origin);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_active ON workflow_templates (is_active);

-- Append-only review history. The template's current review status is the status
-- of its most recent row; origin (how it was made) and status (what humans
-- decided) are deliberately kept in different places.
CREATE TABLE IF NOT EXISTS template_reviews (
  review_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID NOT NULL REFERENCES workflow_templates(template_id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by   TEXT REFERENCES operators(operator_id) ON DELETE SET NULL,
  comments      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_template_reviews_template
  ON template_reviews (template_id, created_at DESC);

-- Seed development operators. Replace with your own identity provider mapping.
INSERT INTO operators (operator_id, display_name, role) VALUES
  ('ops-operator', 'Aiman (Operator)', 'operator'),
  ('ops-approver', 'Bagus (Approver)', 'approver')
ON CONFLICT (operator_id) DO NOTHING;
