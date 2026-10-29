import { useMemo, useState } from 'react';
import { Upload } from 'lucide-react';
import { Modal } from '../Modal';
import { Button } from '../ui';
import { supabase } from '../../utils/supabase';
import { writeLedgerEntry } from '../../utils/ledger';
import { retryWithBackoff } from '../../utils/errorHandling';
import {
  planMaterialImport,
  planSupplierImport,
  syncSupplierMaterialLinks,
  type CatalogNameRef,
  type MaterialImportPlanRow,
  type SupplierImportPlanRow,
} from '../../utils/procurementCatalogCsv';

type CatalogKind = 'suppliers' | 'materials';

class ImportWriteError extends Error {
  readonly wrote: boolean;

  constructor(message: string, wrote: boolean) {
    super(message);
    this.name = 'ImportWriteError';
    this.wrote = wrote;
  }
}

function rowNote(row: SupplierImportPlanRow | MaterialImportPlanRow): string {
  if ('materialIds' in row) {
    if (row.materialIds.length === 0) return 'Catalog cleared';
    const count = row.materialIds.length;
    return `${count} linked material${count === 1 ? '' : 's'}`;
  }
  const cost = row.payload.cost_price == null ? 'no cost price' : `MYR ${row.payload.cost_price}`;
  const unit = row.payload.unit_of_measure || '—';
  return `${unit} · ${cost} · reorder ${row.payload.reorder_level}`;
}

function actionLabel(action: SupplierImportPlanRow['action']): string {
  switch (action) {
    case 'create':
      return 'Add';
    case 'update':
      return 'Update';
    case 'error':
      return 'Error';
    default: {
      const unexpected: never = action;
      return unexpected;
    }
  }
}

async function applySupplierRows(
  rows: SupplierImportPlanRow[],
  onProgress: (label: string) => void
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    onProgress(`Saving ${row.name || 'supplier'} (${index + 1} of ${rows.length})`);
    let supplierId = '';
    try {
      switch (row.action) {
        case 'create': {
          const { data, error } = await retryWithBackoff(
            async () => await supabase.from('suppliers').insert(row.payload).select('id').single()
          );
          const createdId = data && typeof data === 'object' && 'id' in data ? String(data.id) : '';
          if (error || !createdId) {
            throw new ImportWriteError(error?.message ?? `Could not add supplier on row ${row.line}.`, created + updated > 0);
          }
          supplierId = createdId;
          created += 1;
          break;
        }
        case 'update': {
          if (!row.id) {
            throw new ImportWriteError(`Missing id on row ${row.line}.`, created + updated > 0);
          }
          const supplierRowId = row.id;
          const { error } = await retryWithBackoff(
            async () => await supabase.from('suppliers').update(row.payload).eq('id', supplierRowId)
          );
          if (error) throw new ImportWriteError(error.message, created + updated > 0);
          supplierId = row.id;
          updated += 1;
          break;
        }
        case 'error':
          throw new ImportWriteError(`Row ${row.line} has errors.`, created + updated > 0);
        default: {
          const unexpected: never = row.action;
          throw new ImportWriteError(`Unexpected action ${String(unexpected)}.`, created + updated > 0);
        }
      }

      await syncSupplierMaterialLinks(
        {
          async list(id) {
            const { data, error } = await retryWithBackoff(
              async () => await supabase.from('supplier_raw_materials').select('raw_material_id').eq('supplier_id', id)
            );
            if (error) throw new ImportWriteError(error.message, true);
            return (data ?? []).map((link) => link.raw_material_id);
          },
          async insert(id, materialIds) {
            const linkRows = materialIds.map((raw_material_id) => ({
              supplier_id: id,
              raw_material_id,
            }));
            const { error } = await retryWithBackoff(
              async () => await supabase.from('supplier_raw_materials').insert(linkRows)
            );
            if (error) throw new ImportWriteError(error.message, true);
          },
          async remove(id, materialIds) {
            const { error } = await retryWithBackoff(
              async () =>
                await supabase
                  .from('supplier_raw_materials')
                  .delete()
                  .eq('supplier_id', id)
                  .in('raw_material_id', [...materialIds])
            );
            if (error) throw new ImportWriteError(error.message, true);
          },
        },
        supplierId,
        row.materialIds
      );
    } catch (error) {
      if (error instanceof ImportWriteError) throw error;
      const message = error instanceof Error ? error.message : 'Import failed';
      throw new ImportWriteError(message, created + updated > 0);
    }
  }

  return { created, updated };
}

async function applyMaterialRows(
  rows: MaterialImportPlanRow[],
  onProgress: (label: string) => void
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    onProgress(`Saving ${row.name || 'material'} (${index + 1} of ${rows.length})`);
    try {
      switch (row.action) {
        case 'create': {
          const { error } = await retryWithBackoff(
            async () => await supabase.from('raw_materials').insert(row.payload)
          );
          if (error) throw new ImportWriteError(error.message, created + updated > 0);
          created += 1;
          break;
        }
        case 'update': {
          if (!row.id) {
            throw new ImportWriteError(`Missing id on row ${row.line}.`, created + updated > 0);
          }
          const materialRowId = row.id;
          const { error } = await retryWithBackoff(
            async () => await supabase.from('raw_materials').update(row.payload).eq('id', materialRowId)
          );
          if (error) throw new ImportWriteError(error.message, created + updated > 0);
          updated += 1;
          break;
        }
        case 'error':
          throw new ImportWriteError(`Row ${row.line} has errors.`, created + updated > 0);
        default: {
          const unexpected: never = row.action;
          throw new ImportWriteError(`Unexpected action ${String(unexpected)}.`, created + updated > 0);
        }
      }
    } catch (error) {
      if (error instanceof ImportWriteError) throw error;
      const message = error instanceof Error ? error.message : 'Import failed';
      throw new ImportWriteError(message, created + updated > 0);
    }
  }

  return { created, updated };
}

export function CatalogImportModal({
  kind,
  suppliers,
  materials,
  onClose,
  onApplied,
  onDataChanged,
}: {
  kind: CatalogKind;
  suppliers: CatalogNameRef[];
  materials: CatalogNameRef[];
  onClose: () => void;
  onApplied: () => void;
  onDataChanged: () => void;
}) {
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState('');
  const [applyError, setApplyError] = useState('');

  const planned = useMemo(() => {
    if (csvText == null) return null;
    switch (kind) {
      case 'suppliers':
        return { kind, plan: planSupplierImport(csvText, suppliers, materials) } as const;
      case 'materials':
        return { kind, plan: planMaterialImport(csvText, materials) } as const;
      default: {
        const unexpected: never = kind;
        throw new Error(`Unexpected catalog ${String(unexpected)}`);
      }
    }
  }, [csvText, kind, suppliers, materials]);

  const title = kind === 'suppliers' ? 'Import suppliers' : 'Import raw materials';
  const help =
    kind === 'suppliers'
      ? 'Use the supplier template. Leave id blank to add a supplier. A filled id, or a unique name when id is blank, updates that supplier. List catalog materials in raw_materials, separated by |. A blank raw_materials cell clears that supplier’s links. Import new materials before the suppliers that sell them.'
      : 'Use the raw material template. Leave id blank to add a material. A filled id, or a unique name when id is blank, updates that material. An empty cost price is saved as blank. An empty reorder level is saved as 10.';

  const summary = (() => {
    if (!planned) return null;
    if (planned.plan.fileError) return planned.plan.fileError;
    const creates = planned.plan.rows.filter((row) => row.action === 'create').length;
    const updates = planned.plan.rows.filter((row) => row.action === 'update').length;
    const errors = planned.plan.rows.filter((row) => row.action === 'error').length;
    if (errors > 0) {
      return `${errors} ${errors === 1 ? 'row has errors' : 'rows have errors'}. Nothing will be saved until every row is valid.`;
    }
    return `${creates} to add, ${updates} to update.`;
  })();

  async function handleApply() {
    if (!planned || !planned.plan.canApply || applying) return;
    setApplying(true);
    setApplyError('');
    setProgress('');
    try {
      let counts: { created: number; updated: number };
      switch (planned.kind) {
        case 'suppliers':
          counts = await applySupplierRows(planned.plan.rows, setProgress);
          break;
        case 'materials':
          counts = await applyMaterialRows(planned.plan.rows, setProgress);
          break;
        default: {
          const unexpected: never = planned;
          throw new ImportWriteError(`Unexpected import ${String(unexpected)}.`, false);
        }
      }
      const entityType = planned.kind === 'suppliers' ? 'supplier' : 'raw_material';
      const entityLabel = planned.kind === 'suppliers' ? 'Supplier import' : 'Raw material import';
      await writeLedgerEntry({
        action: 'imported',
        entityType,
        entityId: 'catalog-import',
        module: 'procurement',
        operation: 'event',
        afterData: { created: counts.created, updated: counts.updated },
        metadata: {
          entity_label: entityLabel,
          created: counts.created,
          updated: counts.updated,
        },
      });
      onApplied();
    } catch (error) {
      const wrote = error instanceof ImportWriteError ? error.wrote : false;
      const message = error instanceof Error ? error.message : 'Import failed';
      setApplyError(
        wrote ? `${message} Some rows were saved before this failure. Export again before retrying.` : message
      );
      if (wrote) onDataChanged();
    } finally {
      setApplying(false);
      setProgress('');
    }
  }

  return (
    <Modal isOpen onClose={applying ? () => undefined : onClose} title={title} size="xl">
      <p className="text-sm text-gray-600">{help}</p>
      <p className="mt-2 text-sm text-gray-600">
        Rows left out of the file are not changed or deleted. If any row has an error, nothing is saved.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label htmlFor="catalog-csv-file" className={`btn-secondary cursor-pointer ${applying ? 'pointer-events-none opacity-60' : ''}`}>
          <Upload size={16} aria-hidden />
          Choose CSV
        </label>
        <input
          id="catalog-csv-file"
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          disabled={applying}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
              setCsvText(typeof reader.result === 'string' ? reader.result : '');
              setFileName(file.name);
              setApplyError('');
            };
            reader.readAsText(file);
          }}
        />
        {fileName ? <span className="text-sm text-gray-600">{fileName}</span> : null}
      </div>

      {applyError && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {applyError}
        </p>
      )}

      {summary && (
        <p className={`mt-4 text-sm ${planned?.plan.fileError || planned?.plan.canApply === false ? 'text-red-700' : 'text-gray-800'}`}>
          {summary}
        </p>
      )}
      {progress && <p className="mt-2 text-sm text-gray-500">{progress}</p>}

      {planned && planned.plan.rows.length > 0 && (
        <div className="mt-4 max-h-64 overflow-auto rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Row</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Action</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Name</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {planned.plan.rows.map((row) => (
                <tr key={`${row.line}-${row.name}`}>
                  <td className="px-3 py-2 text-gray-500">{row.line}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                        row.action === 'create'
                          ? 'bg-emerald-100 text-emerald-800'
                          : row.action === 'update'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {actionLabel(row.action)}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-medium text-gray-900">{row.name || '—'}</td>
                  <td className="px-3 py-2 text-gray-600">
                    {row.errors.length > 0 ? (
                      <ul className="list-disc space-y-1 pl-4 text-red-700">
                        {row.errors.map((error, index) => (
                          <li key={`${row.line}-${index}`}>{error}</li>
                        ))}
                      </ul>
                    ) : (
                      rowNote(row)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose} disabled={applying}>
          Cancel
        </Button>
        <Button onClick={() => void handleApply()} disabled={!planned?.plan.canApply || applying}>
          {applying ? 'Saving…' : 'Apply'}
        </Button>
      </div>
    </Modal>
  );
}
