import { supabase } from './supabase';

export type LedgerOperation = 'insert' | 'update' | 'delete' | 'event';

interface LedgerParams {
  action: string;
  entityType: string;
  entityId: string;
  module: string;
  operation: LedgerOperation;
  referenceId?: string;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
  deltaData?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export async function writeLedgerEntry(params: LedgerParams) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return;

  await supabase.from('data_ledger').insert({
    user_id: session.user.id,
    user_email: session.user.email ?? '',
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId,
    module: params.module,
    operation: params.operation,
    reference_id: params.referenceId ?? null,
    before_data: params.beforeData ?? null,
    after_data: params.afterData ?? null,
    delta_data: params.deltaData ?? null,
    metadata: params.metadata ?? null,
  });
}
