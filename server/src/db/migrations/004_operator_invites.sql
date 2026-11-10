-- 004_operator_invites.sql — email whitelisting and revocable access.
--
-- Admins invite people by email address. The address (or the member id) is the
-- identity used to sign in. Removing access sets `revoked_at` instead of
-- deleting the row, because templates, reviews, runs and step runs all
-- reference operators and an audit trail must keep naming the real person.

ALTER TABLE operators ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Backfill the seeded demo members with readable addresses.
UPDATE operators
   SET email = CASE operator_id
     WHEN 'ops-admin'    THEN 'aisyah@workspace.local'
     WHEN 'ops-operator' THEN 'aiman@workspace.local'
     WHEN 'ops-auditor'  THEN 'chong@workspace.local'
     WHEN 'ops-approver' THEN 'bagus@workspace.local'
     ELSE operator_id || '@workspace.local'
   END
 WHERE email IS NULL;

ALTER TABLE operators ALTER COLUMN email SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operators_email_key') THEN
    ALTER TABLE operators ADD CONSTRAINT operators_email_key UNIQUE (email);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operators_email_shape') THEN
    ALTER TABLE operators
      ADD CONSTRAINT operators_email_shape
      CHECK (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_operators_revoked ON operators (revoked_at);
