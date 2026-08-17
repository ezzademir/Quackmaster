/*
  # Allow voided sales journals

  void_sales_journal (057b) sets status = 'voided' so outlet stock can be
  restored without deleting the journal. The original check only allowed
  draft/posted/cancelled, which blocked delete and replace.
*/

ALTER TABLE public.sales_journals
  DROP CONSTRAINT IF EXISTS sales_journals_status_check;

ALTER TABLE public.sales_journals
  ADD CONSTRAINT sales_journals_status_check
  CHECK (status IN ('draft', 'posted', 'cancelled', 'voided'));
