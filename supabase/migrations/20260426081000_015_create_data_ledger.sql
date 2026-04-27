/*
  # Create Immutable Data Ledger

  1. New table
    - `data_ledger` append-only ledger for business data mutations
  2. Security
    - authenticated users can insert ledger rows
    - admins can read all rows
    - no update/delete policies (immutable)
*/

CREATE TABLE IF NOT EXISTS data_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email text NOT NULL DEFAULT '',
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL DEFAULT '',
  module text NOT NULL DEFAULT '',
  operation text NOT NULL CHECK (operation IN ('insert', 'update', 'delete', 'event')),
  reference_id text,
  before_data jsonb,
  after_data jsonb,
  delta_data jsonb,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE data_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can insert ledger rows"
  ON data_ledger FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Admins can view all ledger rows"
  ON data_ledger FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

CREATE INDEX IF NOT EXISTS idx_data_ledger_created_at ON data_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_ledger_entity ON data_ledger(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_data_ledger_reference ON data_ledger(reference_id);
