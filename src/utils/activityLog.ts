import { supabase } from './supabase';
import { writeLedgerEntry } from './ledger';

type Action = 'created' | 'updated' | 'deleted' | 'received' | 'dispatched' | 'completed' | 'cancelled';

type EntityType =
  | 'supplier'
  | 'raw_material'
  | 'recipe'
  | 'purchase_order'
  | 'production_run'
  | 'outlet'
  | 'supply_order'
  | 'inventory_adjustment';

interface LogParams {
  action: Action;
  entityType: EntityType;
  entityId: string;
  entityLabel: string;
  details?: Record<string, unknown>;
}

export async function logActivity(params: LogParams) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return; // Only log when authenticated

  await supabase.from('activity_logs').insert({
    user_id: session.user.id,
    user_email: session.user.email ?? '',
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId,
    entity_label: params.entityLabel,
    details: params.details ?? null,
  });

  await writeLedgerEntry({
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    module: 'activity',
    operation: 'event',
    afterData: params.details ?? null,
  });
}
