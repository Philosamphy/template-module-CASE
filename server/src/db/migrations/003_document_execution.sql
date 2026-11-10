-- 003_document_execution.sql — real execution with case data.
-- Idempotent: safe to re-run. Applied by `npm run migrate` (and on server start
-- unless AUTO_MIGRATE=false).

-- Case data supplied when an instance starts. Document steps render their
-- output from this input.
ALTER TABLE workflow_instances
  ADD COLUMN IF NOT EXISTS input JSONB NOT NULL DEFAULT '{}'::jsonb;

-- New step type: steps that actually produce a document from the instance
-- input during execution.
ALTER TABLE step_runs DROP CONSTRAINT IF EXISTS step_runs_step_type_check;
ALTER TABLE step_runs ADD CONSTRAINT step_runs_step_type_check
  CHECK (step_type IN ('review', 'validation', 'approval', 'notification', 'document'));
