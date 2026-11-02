import { describe, expect, it } from 'vitest';
import { parseCsv, toCsvRow } from './exportCsv';
import {
  MATERIAL_CSV_HEADERS,
  SUPPLIER_CSV_HEADERS,
  materialExportRows,
  planMaterialImport,
  planSupplierImport,
  supplierExportRows,
} from './procurementCatalogCsv';

function sheet(headers: readonly string[], rows: (string | number | null | undefined)[][]): string {
  return [toCsvRow([...headers]), ...rows.map((row) => toCsvRow(row))].join('\n');
}

const salt = { id: 'm-salt', name: 'Salt' };
const duck = { id: 'm-duck', name: 'Duck breast' };

describe('parseCsv', () => {
  it('strips a BOM and keeps quoted commas and quotes', () => {
    const parsed = parseCsv('\uFEFFName,Address\n"Acme","12, Jalan ""Main"""\r\n');
    expect(parsed).toEqual([
      ['Name', 'Address'],
      ['Acme', '12, Jalan "Main"'],
    ]);
  });
});

describe('supplier export', () => {
  it('joins linked material names with | in name order', () => {
    const rows = supplierExportRows(
      [
        {
          id: 's1',
          name: 'Acme',
          contact_person: 'Ada',
          email: null,
          phone: null,
          address: null,
          city: null,
          country: null,
          payment_terms: '30 days',
        },
      ],
      [
        { supplier_id: 's1', raw_material_id: 'm-duck' },
        { supplier_id: 's1', raw_material_id: 'm-salt' },
      ],
      [salt, duck]
    );
    expect(rows[0][0]).toBe('s1');
    expect(rows[0][SUPPLIER_CSV_HEADERS.indexOf('raw_materials')]).toBe('Duck breast|Salt');
    expect(rows[0]).toHaveLength(SUPPLIER_CSV_HEADERS.length);
  });
});

describe('planSupplierImport', () => {
  const suppliers = [{ id: 's1', name: 'Acme' }];

  it('rejects a header that does not match the template', () => {
    const plan = planSupplierImport('name,email\nAcme,a@b.co\n', suppliers, [salt]);
    expect(plan.canApply).toBe(false);
    expect(plan.fileError).toMatch(/Header row must be/);
    expect(plan.rows).toEqual([]);
  });

  it('creates a new supplier and updates a unique name match', () => {
    const csv = sheet(SUPPLIER_CSV_HEADERS, [
      ['', 'North Farm', '', '', '', '', '', '', '', 'Salt'],
      ['', 'acme', 'Ada', 'ada@acme.test', '012345', '12, Main', 'KL', 'MY', '30 days', ''],
    ]);
    const plan = planSupplierImport(csv, suppliers, [salt, duck]);
    expect(plan.fileError).toBeNull();
    expect(plan.canApply).toBe(true);
    expect(plan.rows[0]).toMatchObject({
      action: 'create',
      id: null,
      name: 'North Farm',
      materialIds: ['m-salt'],
    });
    expect(plan.rows[1]).toMatchObject({
      action: 'update',
      id: 's1',
      name: 'acme',
      materialIds: [],
      payload: { address: '12, Main', email: 'ada@acme.test' },
    });
  });

  it('updates by id when the name changes', () => {
    const csv = sheet(SUPPLIER_CSV_HEADERS, [
      ['s1', 'Acme Foods', '', '', '', '', '', '', '', 'Duck breast|Salt'],
    ]);
    const plan = planSupplierImport(csv, suppliers, [salt, duck]);
    expect(plan.canApply).toBe(true);
    expect(plan.rows[0]).toMatchObject({
      action: 'update',
      id: 's1',
      name: 'Acme Foods',
      materialIds: ['m-duck', 'm-salt'],
    });
  });

  it('does not clear the catalog when the raw_materials column was dropped', () => {
    const plan = planSupplierImport('id,name\ns1,Acme\n', [{ id: 's1', name: 'Acme' }], [salt]);
    expect(plan.fileError).toMatch(/Header row must be/);
    expect(plan.canApply).toBe(false);
  });

  it('rejects a data row that omits trailing columns instead of clearing the catalog', () => {
    const header = SUPPLIER_CSV_HEADERS.join(',');
    const plan = planSupplierImport(`${header}\ns1,Acme\n`, suppliers, [salt]);
    expect(plan.canApply).toBe(false);
    expect(plan.rows[0].action).toBe('error');
    expect(plan.rows[0].errors.join(' ')).toMatch(/missing columns/i);
    expect(plan.rows[0].materialIds).toEqual([]);
  });

  it('clears the catalog when raw_materials is blank', () => {
    const csv = sheet(SUPPLIER_CSV_HEADERS, [['s1', 'Acme', '', '', '', '', '', '', '', '']]);
    const plan = planSupplierImport(csv, suppliers, [salt]);
    expect(plan.canApply).toBe(true);
    expect(plan.rows[0].materialIds).toEqual([]);
    expect(plan.rows[0].action).toBe('update');
  });

  it('blocks apply when a material name is unknown', () => {
    const csv = sheet(SUPPLIER_CSV_HEADERS, [
      ['s1', 'Acme', '', '', '', '', '', '', '', 'Not a thing'],
    ]);
    const plan = planSupplierImport(csv, suppliers, [salt]);
    expect(plan.canApply).toBe(false);
    expect(plan.rows[0].errors.join(' ')).toMatch(/Unknown raw material "Not a thing"/);
  });

  it('errors duplicate names in the file and does not plan deletes for omitted suppliers', () => {
    const csv = sheet(SUPPLIER_CSV_HEADERS, [
      ['', 'North Farm', '', '', '', '', '', '', '', ''],
      ['', 'north farm', '', '', '', '', '', '', '', ''],
    ]);
    const plan = planSupplierImport(csv, suppliers, []);
    expect(plan.canApply).toBe(false);
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows.every((row) => row.errors.includes('Duplicate name in this file'))).toBe(true);
    expect(plan.rows.some((row) => row.id === 's1')).toBe(false);
  });

  it('errors when several existing suppliers share the name', () => {
    const csv = sheet(SUPPLIER_CSV_HEADERS, [['', 'Acme', '', '', '', '', '', '', '', '']]);
    const plan = planSupplierImport(
      csv,
      [
        { id: 's1', name: 'Acme' },
        { id: 's2', name: 'acme' },
      ],
      []
    );
    expect(plan.canApply).toBe(false);
    expect(plan.rows[0].errors).toContain('More than one existing record uses this name');
  });

  it('errors an unknown id', () => {
    const csv = sheet(SUPPLIER_CSV_HEADERS, [
      ['missing', 'Acme', '', '', '', '', '', '', '', ''],
    ]);
    const plan = planSupplierImport(csv, suppliers, []);
    expect(plan.canApply).toBe(false);
    expect(plan.rows[0].errors).toContain('Unknown id');
    expect(plan.rows[0].action).toBe('error');
  });
});

describe('planMaterialImport', () => {
  it('creates a new material and updates a unique name, with empty cost and reorder defaults', () => {
    const csv = `\uFEFF${sheet(MATERIAL_CSV_HEADERS, [
      ['', 'Pepper', 'Ground', 'kg', '', ''],
      ['', 'salt', 'Coarse', 'kg', '4.5', '0'],
    ])}`;
    const plan = planMaterialImport(csv, [{ id: 'm-salt', name: 'Salt' }]);
    expect(plan.canApply).toBe(true);
    expect(plan.rows[0]).toMatchObject({
      action: 'create',
      name: 'Pepper',
      payload: { cost_price: null, reorder_level: 10, unit_of_measure: 'kg' },
    });
    expect(plan.rows[1]).toMatchObject({
      action: 'update',
      id: 'm-salt',
      payload: { cost_price: 4.5, reorder_level: 0, description: 'Coarse' },
    });
  });

  it('rejects a bad email on suppliers and a missing unit on materials', () => {
    const supplierCsv = sheet(SUPPLIER_CSV_HEADERS, [
      ['', 'North Farm', '', 'not-an-email', '', '', '', '', '', ''],
    ]);
    const supplierPlan = planSupplierImport(supplierCsv, [], []);
    expect(supplierPlan.canApply).toBe(false);
    expect(supplierPlan.rows[0].errors.join(' ')).toMatch(/email/i);

    const materialCsv = sheet(MATERIAL_CSV_HEADERS, [['', 'Pepper', '', '', '2', '5']]);
    const materialPlan = planMaterialImport(materialCsv, []);
    expect(materialPlan.canApply).toBe(false);
    expect(materialPlan.rows[0].errors.join(' ')).toMatch(/Unit of measure/);
  });

  it('exports reorder level 10 when the stored value is missing', () => {
    const rows = materialExportRows([
      {
        id: 'm1',
        name: 'Salt',
        description: null,
        unit_of_measure: 'kg',
        cost_price: null,
        reorder_level: null,
      },
    ]);
    expect(rows[0][MATERIAL_CSV_HEADERS.indexOf('reorder_level')]).toBe('10');
    expect(rows[0][MATERIAL_CSV_HEADERS.indexOf('cost_price')]).toBe('');
    expect(MATERIAL_CSV_HEADERS).not.toContain('weighted_avg_unit_cost');
  });

  it('reports an empty file and a header-only file', () => {
    expect(planMaterialImport('', []).fileError).toBe('The file is empty.');
    expect(planMaterialImport(MATERIAL_CSV_HEADERS.join(','), []).fileError).toBe(
      'The file has no data rows.'
    );
  });
});
