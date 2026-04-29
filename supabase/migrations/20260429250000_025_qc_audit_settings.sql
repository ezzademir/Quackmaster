/*
  # QC audit parameters (singleton row)

  Admins configure min/max yield bands and allowable variance from recipe target.
  All authenticated users may read (production completion uses these values).
*/

CREATE TABLE public.qc_audit_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  min_yield_percentage numeric(6, 2) NOT NULL DEFAULT 85,
  max_yield_percentage numeric(6, 2) NOT NULL DEFAULT 110,
  allowable_variance numeric(6, 2) NOT NULL DEFAULT 5,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT qc_audit_min_max CHECK (min_yield_percentage < max_yield_percentage),
  CONSTRAINT qc_audit_min_range CHECK (min_yield_percentage >= 0 AND min_yield_percentage <= 200),
  CONSTRAINT qc_audit_max_range CHECK (max_yield_percentage >= 0 AND max_yield_percentage <= 200),
  CONSTRAINT qc_audit_variance_range CHECK (allowable_variance >= 0 AND allowable_variance <= 100)
);

ALTER TABLE public.qc_audit_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.qc_audit_settings (id) VALUES (1);

CREATE POLICY "Authenticated users can read QC audit settings"
  ON public.qc_audit_settings FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can insert QC audit settings"
  ON public.qc_audit_settings FOR INSERT
  TO authenticated
  WITH CHECK (public.is_profiles_admin());

CREATE POLICY "Admins can update QC audit settings"
  ON public.qc_audit_settings FOR UPDATE
  TO authenticated
  USING (public.is_profiles_admin())
  WITH CHECK (public.is_profiles_admin());
