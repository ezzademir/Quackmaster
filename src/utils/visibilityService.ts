import { supabase } from './supabase';

export interface SalesJournalLineInput {
  product_batch: string;
  quantity_sold: number;
}

export async function postSalesJournal(params: {
  outletId: string;
  businessDate: string;
  lines: SalesJournalLineInput[];
  notes?: string;
  idempotencyKey?: string;
}): Promise<{ success: boolean; salesJournalId?: string; error?: string; idempotentReplay?: boolean }> {
  const lines = params.lines.map((l) => ({
    product_batch: l.product_batch.trim(),
    quantity_sold: l.quantity_sold,
  }));

  const { data, error } = await supabase.rpc('post_sales_journal', {
    p_outlet_id: params.outletId,
    p_business_date: params.businessDate,
    p_lines: lines,
    p_notes: params.notes ?? null,
    p_idempotency_key: params.idempotencyKey ?? null,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  const payload = data as {
    success?: boolean;
    sales_journal_id?: string;
    error?: string;
    idempotent_replay?: boolean;
  } | null;

  if (!payload?.success) {
    return {
      success: false,
      error: payload?.error ?? 'post_sales_journal failed',
    };
  }

  return {
    success: true,
    salesJournalId: payload.sales_journal_id,
    idempotentReplay: Boolean(payload.idempotent_replay),
  };
}

export async function voidSalesJournal(params: {
  salesJournalId: string;
}): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('void_sales_journal', {
    p_sales_journal_id: params.salesJournalId,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  const payload = data as { success?: boolean; error?: string } | null;

  if (!payload?.success) {
    return {
      success: false,
      error: payload?.error ?? 'void_sales_journal failed',
    };
  }

  return { success: true };
}

export async function replaceSalesJournal(params: {
  existingSalesJournalId: string;
  businessDate: string;
  lines: SalesJournalLineInput[];
  notes?: string;
  idempotencyKey?: string;
}): Promise<{ success: boolean; salesJournalId?: string; error?: string; idempotentReplay?: boolean }> {
  const lines = params.lines.map((l) => ({
    product_batch: l.product_batch.trim(),
    quantity_sold: l.quantity_sold,
  }));

  const { data, error } = await supabase.rpc('replace_sales_journal', {
    p_existing_sales_journal_id: params.existingSalesJournalId,
    p_business_date: params.businessDate,
    p_lines: lines,
    p_notes: params.notes ?? null,
    p_idempotency_key: params.idempotencyKey ?? null,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  const payload = data as {
    success?: boolean;
    sales_journal_id?: string;
    error?: string;
    idempotent_replay?: boolean;
  } | null;

  if (!payload?.success) {
    return {
      success: false,
      error: payload?.error ?? 'replace_sales_journal failed',
    };
  }

  return {
    success: true,
    salesJournalId: payload.sales_journal_id,
    idempotentReplay: Boolean(payload.idempotent_replay),
  };
}

export interface WasteLineHubInput {
  hub_inventory_id: string;
  product_batch: string;
  quantity: number;
  waste_reason: string;
}

export interface WasteLineOutletInput {
  outlet_id: string;
  product_batch: string;
  quantity: number;
  waste_reason: string;
}

export async function postWasteEvent(params: {
  locationKind: 'hub' | 'outlet';
  outletId?: string | null;
  wasteDate: string;
  lines: WasteLineHubInput[] | WasteLineOutletInput[];
  notes?: string;
  idempotencyKey?: string;
}): Promise<{ success: boolean; wasteEventId?: string; error?: string; idempotentReplay?: boolean }> {
  const { data, error } = await supabase.rpc('post_waste_event', {
    p_location_kind: params.locationKind,
    p_outlet_id: params.outletId ?? null,
    p_waste_date: params.wasteDate,
    p_lines: params.lines,
    p_notes: params.notes ?? null,
    p_idempotency_key: params.idempotencyKey ?? null,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  const payload = data as {
    success?: boolean;
    waste_event_id?: string;
    error?: string;
    idempotent_replay?: boolean;
  } | null;

  if (!payload?.success) {
    return {
      success: false,
      error: payload?.error ?? 'post_waste_event failed',
    };
  }

  return {
    success: true,
    wasteEventId: payload.waste_event_id,
    idempotentReplay: Boolean(payload.idempotent_replay),
  };
}
