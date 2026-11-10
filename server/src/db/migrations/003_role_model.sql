-- 003_role_model.sql — admin / operator / auditor.
--
-- The first model split creation (operator) from approval (approver). Operators
-- now create, edit, deactivate AND approve; admins additionally manage members;
-- auditors are strictly read-only. Existing 'approver' rows become operators —
-- they keep every capability they had, because approval moved into the operator
-- role rather than disappearing.

-- Widen the check first, so rows can be migrated into the new vocabulary.
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;

UPDATE operators SET role = 'operator' WHERE role = 'approver';

ALTER TABLE operators
  ADD CONSTRAINT operators_role_check CHECK (role IN ('admin', 'operator', 'auditor'));

-- Roster labels follow the new roles.
UPDATE operators
   SET display_name = 'Bagus (Operator)'
 WHERE operator_id = 'ops-approver' AND display_name = 'Bagus (Approver)';

-- Seed an admin (can invite and re-role members) and an auditor (read-only).
INSERT INTO operators (operator_id, display_name, role) VALUES
  ('ops-admin', 'Aisyah (Admin)', 'admin'),
  ('ops-auditor', 'Chong (Auditor)', 'auditor')
ON CONFLICT (operator_id) DO NOTHING;
