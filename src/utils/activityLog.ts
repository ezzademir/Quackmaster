import { writeLedgerEntry, type LedgerWriteResult } from './ledger';

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

function ledgerModuleForEntity(entityType: EntityType): string {
  switch (entityType) {
    case 'supplier':
    case 'raw_material':
    case 'recipe':
    case 'purchase_order':
      return 'procurement';
    case 'production_run':
      return 'production';
    case 'outlet':
    case 'supply_order':
      return 'distribution';
    case 'inventory_adjustment':
      return 'inventory';
    default:
      return 'app';
  }
}

/**
 * Append a narrative ledger row (`operation: event`). Prefer one merged `writeLedgerEntry`
 * per mutation where you already record insert/update/delete — use this for event-only trails.
 */
export async function logActivity(params: LogParams): Promise<LedgerWriteResult> {
  return writeLedgerEntry({
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    module: ledgerModuleForEntity(params.entityType),
    operation: 'event',
    afterData: params.details ?? null,
    metadata: { entity_label: params.entityLabel },
  });
}
