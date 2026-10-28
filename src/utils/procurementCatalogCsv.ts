import { parseCsv } from './exportCsv';
import { validateRawMaterial, validateSupplier } from './validation';

export const SUPPLIER_CSV_HEADERS = [
  'id',
  'name',
  'contact_person',
  'email',
  'phone',
  'address',
  'city',
  'country',
  'payment_terms',
  'raw_materials',
] as const;

export const MATERIAL_CSV_HEADERS = [
  'id',
  'name',
  'description',
  'unit_of_measure',
  'cost_price',
  'reorder_level',
] as const;

export interface SupplierCsvSource {
  id: string;
  name: string;
  contact_person?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  payment_terms?: string | null;
}

export interface MaterialCsvSource {
  id: string;
  name: string;
  description?: string | null;
  unit_of_measure: string;
  cost_price?: number | string | null;
  reorder_level?: number | string | null;
}

export interface SupplierMaterialLinkRef {
  supplier_id: string;
  raw_material_id: string;
}

export interface CatalogNameRef {
  id: string;
  name: string;
}

export type CatalogRowAction = 'create' | 'update' | 'error';

export interface SupplierImportPayload {
  name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  payment_terms: string | null;
}

export interface SupplierImportPlanRow {
  line: number;
  action: CatalogRowAction;
  errors: string[];
  id: string | null;
  name: string;
  payload: SupplierImportPayload;
  materialIds: string[];
}

export interface MaterialImportPayload {
  name: string;
  description: string | null;
  unit_of_measure: string;
  cost_price: number | null;
  reorder_level: number;
}

export interface MaterialImportPlanRow {
  line: number;
  action: CatalogRowAction;
  errors: string[];
  id: string | null;
  name: string;
  payload: MaterialImportPayload;
}

export interface CatalogImportPlan<T> {
  fileError: string | null;
  rows: T[];
  canApply: boolean;
}

const EMPTY_FILE = 'The file is empty.';
const NO_DATA_ROWS = 'The file has no data rows.';
const DUPLICATE_NAME = 'Duplicate name in this file';
const AMBIGUOUS_NAME = 'More than one existing record uses this name';
const UNKNOWN_ID = 'Unknown id';
const SAME_RECORD = 'More than one row updates the same record';
const EXTRA_COLUMNS = 'This row has more columns than the header.';
const MISSING_COLUMNS =
  'This row is missing columns. Keep every template column, even when a cell is blank.';

export function catalogNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function textCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function headerError(actual: string[], expected: readonly string[]): string | null {
  const norm = actual.map((cell) => cell.trim().toLowerCase());
  if (norm.length === expected.length && norm.every((cell, index) => cell === expected[index])) {
    return null;
  }
  return `Header row must be: ${expected.join(', ')}`;
}

interface ParsedRecord {
  line: number;
  cells: string[];
}

function readTable(
  text: string,
  expected: readonly string[]
): { fileError: string } | { records: ParsedRecord[] } {
  const table = parseCsv(text);
  const meaningful = table.filter((row) => row.some((cell) => cell.trim() !== ''));
  if (meaningful.length === 0) return { fileError: EMPTY_FILE };

  const mismatch = headerError(meaningful[0], expected);
  if (mismatch) return { fileError: mismatch };

  const headerIndex = table.indexOf(meaningful[0]);
  const records: ParsedRecord[] = [];
  for (let i = headerIndex + 1; i < table.length; i += 1) {
    const cells = table[i];
    if (cells.every((cell) => cell.trim() === '')) continue;
    records.push({ line: i + 1, cells });
  }
  if (records.length === 0) return { fileError: NO_DATA_ROWS };
  return { records };
}

function indexById<T extends { id: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) map.set(row.id.trim().toLowerCase(), row);
  return map;
}

function indexByName<T extends { name: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = catalogNameKey(row.name);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

interface MatchDraft {
  matchedId: string | null;
  wantsCreate: boolean;
  errors: string[];
}

function matchRecord(
  idCell: string,
  name: string,
  existingById: Map<string, { id: string }>,
  existingByName: Map<string, { id: string }[]>
): MatchDraft {
  const errors: string[] = [];
  const idKey = idCell.trim().toLowerCase();
  if (idKey) {
    const existing = existingById.get(idKey);
    if (!existing) {
      errors.push(UNKNOWN_ID);
      return { matchedId: null, wantsCreate: false, errors };
    }
    return { matchedId: existing.id, wantsCreate: false, errors };
  }

  const key = catalogNameKey(name);
  if (!key) return { matchedId: null, wantsCreate: true, errors };

  const matches = existingByName.get(key) ?? [];
  if (matches.length > 1) {
    errors.push(AMBIGUOUS_NAME);
    return { matchedId: null, wantsCreate: false, errors };
  }
  if (matches.length === 1) {
    return { matchedId: matches[0].id, wantsCreate: false, errors };
  }
  return { matchedId: null, wantsCreate: true, errors };
}

interface NameDraft {
  name: string;
  matchedId: string | null;
  errors: string[];
}

function flagDuplicateNames(drafts: NameDraft[]): void {
  const groups = new Map<string, NameDraft[]>();
  for (const draft of drafts) {
    const key = catalogNameKey(draft.name);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(draft);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (const draft of list) draft.errors.push(DUPLICATE_NAME);
  }
}

function flagTargetCollisions(drafts: NameDraft[]): void {
  const groups = new Map<string, NameDraft[]>();
  for (const draft of drafts) {
    if (!draft.matchedId) continue;
    const list = groups.get(draft.matchedId) ?? [];
    list.push(draft);
    groups.set(draft.matchedId, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (const draft of list) draft.errors.push(SAME_RECORD);
  }
}

function cellAt(cells: string[], index: number): string {
  return (cells[index] ?? '').trim();
}

function columnCountError(cellCount: number, expected: number): string | null {
  if (cellCount < expected) return MISSING_COLUMNS;
  if (cellCount > expected) return EXTRA_COLUMNS;
  return null;
}

function resolveMaterialIds(raw: string, materials: CatalogNameRef[], errors: string[]): string[] {
  const byName = indexByName(materials);
  const ids: string[] = [];
  const seen = new Set<string>();
  const tokens = raw.split('|').map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    const matches = byName.get(catalogNameKey(token)) ?? [];
    if (matches.length === 0) {
      errors.push(`Unknown raw material "${token}"`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`More than one raw material is named "${token}"`);
      continue;
    }
    if (seen.has(matches[0].id)) continue;
    seen.add(matches[0].id);
    ids.push(matches[0].id);
  }
  return ids;
}

function finishAction(errors: string[], matchedId: string | null, wantsCreate: boolean): CatalogRowAction {
  if (errors.length > 0 || (!matchedId && !wantsCreate)) return 'error';
  if (matchedId) return 'update';
  return 'create';
}

function emptyPlan<T>(fileError: string): CatalogImportPlan<T> {
  return { fileError, rows: [], canApply: false };
}

export function supplierExportRows(
  suppliers: SupplierCsvSource[],
  links: SupplierMaterialLinkRef[],
  materials: CatalogNameRef[]
): string[][] {
  const materialName = new Map(materials.map((material) => [material.id, material.name]));
  return [...suppliers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((supplier) => {
      const catalog = links
        .filter((link) => link.supplier_id === supplier.id)
        .map((link) => materialName.get(link.raw_material_id))
        .filter((name): name is string => Boolean(name))
        .sort((a, b) => a.localeCompare(b))
        .join('|');
      return [
        supplier.id,
        supplier.name,
        textCell(supplier.contact_person),
        textCell(supplier.email),
        textCell(supplier.phone),
        textCell(supplier.address),
        textCell(supplier.city),
        textCell(supplier.country),
        textCell(supplier.payment_terms),
        catalog,
      ];
    });
}

export function materialExportRows(materials: MaterialCsvSource[]): string[][] {
  return [...materials]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((material) => [
      material.id,
      material.name,
      textCell(material.description),
      material.unit_of_measure,
      textCell(material.cost_price),
      textCell(material.reorder_level ?? 10),
    ]);
}

export function planSupplierImport(
  text: string,
  suppliers: CatalogNameRef[],
  materials: CatalogNameRef[]
): CatalogImportPlan<SupplierImportPlanRow> {
  const table = readTable(text, SUPPLIER_CSV_HEADERS);
  if ('fileError' in table) return emptyPlan(table.fileError);

  const existingById = indexById(suppliers);
  const existingByName = indexByName(suppliers);
  const drafts = table.records.map((record) => {
    const errors: string[] = [];
    const supplierColumnError = columnCountError(record.cells.length, SUPPLIER_CSV_HEADERS.length);
    if (supplierColumnError) errors.push(supplierColumnError);

    const name = cellAt(record.cells, 1);
    const email = cellAt(record.cells, 3);
    const phone = cellAt(record.cells, 4);
    const supplierInput: Record<string, unknown> = { name };
    if (email) supplierInput.email = email;
    if (phone) supplierInput.phone = phone;
    const validation = validateSupplier(supplierInput);
    for (const issue of validation.errors) errors.push(issue.message);

    const match = matchRecord(cellAt(record.cells, 0), name, existingById, existingByName);
    errors.push(...match.errors);
    const materialIds = resolveMaterialIds(cellAt(record.cells, 9), materials, errors);

    return {
      line: record.line,
      name,
      matchedId: match.matchedId,
      wantsCreate: match.wantsCreate,
      errors,
      payload: {
        name,
        contact_person: blankToNull(cellAt(record.cells, 2)),
        email: blankToNull(email),
        phone: blankToNull(phone),
        address: blankToNull(cellAt(record.cells, 5)),
        city: blankToNull(cellAt(record.cells, 6)),
        country: blankToNull(cellAt(record.cells, 7)),
        payment_terms: blankToNull(cellAt(record.cells, 8)),
      },
      materialIds,
    };
  });

  flagDuplicateNames(drafts);
  flagTargetCollisions(drafts);

  const rows: SupplierImportPlanRow[] = drafts.map((draft) => ({
    line: draft.line,
    action: finishAction(draft.errors, draft.matchedId, draft.wantsCreate),
    errors: draft.errors,
    id: draft.matchedId,
    name: draft.name,
    payload: draft.payload,
    materialIds: draft.materialIds,
  }));

  return {
    fileError: null,
    rows,
    canApply: rows.every((row) => row.action !== 'error'),
  };
}

export function planMaterialImport(
  text: string,
  materials: CatalogNameRef[]
): CatalogImportPlan<MaterialImportPlanRow> {
  const table = readTable(text, MATERIAL_CSV_HEADERS);
  if ('fileError' in table) return emptyPlan(table.fileError);

  const existingById = indexById(materials);
  const existingByName = indexByName(materials);
  const drafts = table.records.map((record) => {
    const errors: string[] = [];
    const materialColumnError = columnCountError(record.cells.length, MATERIAL_CSV_HEADERS.length);
    if (materialColumnError) errors.push(materialColumnError);

    const name = cellAt(record.cells, 1);
    const unit = cellAt(record.cells, 3);
    const costRaw = cellAt(record.cells, 4);
    const reorderRaw = cellAt(record.cells, 5);
    const materialInput: Record<string, unknown> = {
      name,
      unit_of_measure: unit,
    };
    if (costRaw !== '') materialInput.cost_price = costRaw;
    if (reorderRaw !== '') materialInput.reorder_level = reorderRaw;
    const validation = validateRawMaterial(materialInput);
    for (const issue of validation.errors) errors.push(issue.message);

    const match = matchRecord(cellAt(record.cells, 0), name, existingById, existingByName);
    errors.push(...match.errors);

    const cost_price = costRaw === '' ? null : Number(costRaw);
    const reorder_level = reorderRaw === '' ? 10 : Number(reorderRaw);

    return {
      line: record.line,
      name,
      matchedId: match.matchedId,
      wantsCreate: match.wantsCreate,
      errors,
      payload: {
        name,
        description: blankToNull(cellAt(record.cells, 2)),
        unit_of_measure: unit,
        cost_price: Number.isFinite(cost_price) ? cost_price : null,
        reorder_level: Number.isFinite(reorder_level) ? reorder_level : 10,
      },
    };
  });

  flagDuplicateNames(drafts);
  flagTargetCollisions(drafts);

  const rows: MaterialImportPlanRow[] = drafts.map((draft) => ({
    line: draft.line,
    action: finishAction(draft.errors, draft.matchedId, draft.wantsCreate),
    errors: draft.errors,
    id: draft.matchedId,
    name: draft.name,
    payload: draft.payload,
  }));

  return {
    fileError: null,
    rows,
    canApply: rows.every((row) => row.action !== 'error'),
  };
}
