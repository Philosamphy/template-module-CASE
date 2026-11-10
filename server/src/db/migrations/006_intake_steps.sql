-- 006_intake_steps.sql — allow `intake` steps in execution history.
--
-- An intake step pauses a run for a PDF/JPG upload and records the reading as
-- a step run. Widen the constraint added by 002/003.

ALTER TABLE step_runs DROP CONSTRAINT IF EXISTS step_runs_step_type_check;
ALTER TABLE step_runs ADD CONSTRAINT step_runs_step_type_check
  CHECK (step_type IN ('review', 'validation', 'approval', 'intake', 'notification', 'document'));
