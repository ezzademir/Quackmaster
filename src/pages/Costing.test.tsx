// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const auth = vi.hoisted(() => ({ isAdmin: true }));
const tables = vi.hoisted(() => ({
  data: {} as Record<string, unknown[]>,
  insert: vi.fn<(payload: unknown) => Promise<{ error: { message: string } | null }>>(),
  writes: [] as Array<{ table: string; payload: unknown }>,
}));

function builder(rows: unknown[], table = '') {
  const api = {
    select: () => api,
    order: () => api,
    eq: () => api,
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    insert: (payload: unknown) => tables.insert(payload),
    update: (payload: unknown) => {
      tables.writes.push({ table, payload });
      return api;
    },
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null }),
  };
  return api;
}

vi.mock('../utils/auth', () => ({
  useAuth: () => ({ isAdmin: auth.isAdmin }),
}));

vi.mock('../utils/supabase', () => ({
  supabase: {
    from: (name: string) => builder(tables.data[name] ?? [], name),
  },
}));

import { Costing } from './Costing';

const nasi = {
  kind: 'dish',
  id: 'd1',
  entity_code: 'QT',
  name: 'Nasi Ayam',
  status: 'active',
  source_sheet: 'P- Nasi Ayam',
  selling_price_ex_sst_rm: '12',
  line_count: 2,
  incomplete_lines: 0,
  cost_complete: true,
  food_cost_rm: '0.7249',
  known_cost_rm: '0.7249',
};

const laksa = {
  ...nasi,
  id: 'd2',
  entity_code: 'MH',
  name: 'Laksa',
  cost_complete: false,
  food_cost_rm: null,
  known_cost_rm: '1.5000',
  incomplete_lines: 1,
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  auth.isAdmin = true;
  tables.insert.mockReset();
  tables.insert.mockResolvedValue({ error: null });
  tables.writes = [];
  tables.data = {
    v_recipe_cost: [nasi, laksa, { ...nasi, id: 's1', kind: 'sub-recipe', name: 'Sambal' }],
    v_dish_cogs: [{ menu_item_id: 'd1', cogs_dine_in_pct: '20', cogs_takeaway_pct: '25', food_cost_pct: '6' }],
    v_cost_drift: [],
    v_price_flags_open: [
      {
        id: 7,
        item_name: 'Beras',
        procurement_tag: 'quackteow',
        price_rm: '40',
        unit_cost_rm: '0.04',
        previous_unit_cost_rm: '0.03',
        pct_change: '33.33',
        source: 'receipt',
        entered_at: '2026-10-20T02:00:00.000Z',
        note: null,
      },
    ],
    menu_items: [{ wastage_pct: '5', servings: '1', notes: null, packaging_rule: 'both', pkg_dine_in_rm: '0.10', pkg_takeaway_rm: '0.40' }],
    bom_lines: [
      {
        id: 'line-1',
        component_name: 'Chicken',
        qty: '150',
        unit: 'g',
        base_qty: '150',
        line_cost_rm: '0.50',
        cost_complete: true,
        price_basis: 'list',
        status: 'active',
        issues: null,
        shared_ingredient: false,
      },
    ],
  };
});

describe('Costing', () => {
  it('shows a complete dish cost and an incomplete dish as partial', async () => {
    render(<Costing />);
    expect(await screen.findByRole('button', { name: 'Nasi Ayam' })).toBeTruthy();
    expect(screen.getAllByText('RM 0.7249').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20.00%').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Laksa' })).toBeTruthy();
    expect(screen.getAllByText('RM 1.5000 partial').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Incomplete').length).toBeGreaterThan(0);
  });

  it('filters dishes by entity', async () => {
    render(<Costing />);
    await screen.findByRole('button', { name: 'Nasi Ayam' });
    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: 'MH' } });
    expect(screen.queryByRole('button', { name: 'Nasi Ayam' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Laksa' })).toBeTruthy();
  });

  it('opens the bill of materials for a dish', async () => {
    render(<Costing />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nasi Ayam' }));
    expect(await screen.findByText('Chicken')).toBeTruthy();
    expect(screen.getByText(/Packaging: both/)).toBeTruthy();
  });

  it('does not send a second price review while the first is in flight', async () => {
    let release: (value: { error: null }) => void = () => undefined;
    tables.insert.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<Costing />);
    fireEvent.click(await screen.findByRole('button', { name: /Price flags/ }));
    const accept = await screen.findByRole('button', { name: 'Accept Beras' });
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(tables.insert).toHaveBeenCalledTimes(1);
    release({ error: null });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept Beras' })).toBeNull());
  });

  it('tells an admin when the catalogue has not been loaded', async () => {
    tables.data = { v_recipe_cost: [], v_dish_cogs: [], v_cost_drift: [], v_price_flags_open: [] };
    render(<Costing />);
    expect(await screen.findByText('No recipes loaded')).toBeTruthy();
  });

  it('saves every field on a dish', async () => {
    render(<Costing />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nasi Ayam' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit recipe' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nasi Ayam 2.0' } });
    fireEvent.change(screen.getByLabelText('Recipe status'), { target: { value: 'KIV' } });
    fireEvent.change(screen.getByLabelText('Source sheet'), { target: { value: 'P- Nasi' } });
    fireEvent.change(screen.getByLabelText('Selling price ex SST'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Wastage %'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Servings'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Packaging rule'), { target: { value: 'takeaway only' } });
    fireEvent.change(screen.getByLabelText('Dine-in packaging RM'), { target: { value: '0.2' } });
    fireEvent.change(screen.getByLabelText('Takeaway packaging RM'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'manual' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(tables.writes).toContainEqual({
      table: 'menu_items',
      payload: {
        name: 'Nasi Ayam 2.0',
        entity_code: 'QT',
        status: 'KIV',
        source_sheet: 'P- Nasi',
        selling_price_ex_sst_rm: 15,
        wastage_pct: 8,
        servings: 2,
        packaging_rule: 'takeaway only',
        pkg_dine_in_rm: 0.2,
        pkg_takeaway_rm: 0.5,
        notes: 'manual',
      },
    });
  });

  it('saves every field on a recipe line and refuses a pending line marked complete', async () => {
    render(<Costing />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nasi Ayam' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Chicken' }));
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '180' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'GM' } });
    fireEvent.change(screen.getByLabelText('Base quantity'), { target: { value: '180' } });
    fireEvent.change(screen.getByLabelText('Line cost RM'), { target: { value: '0.8' } });
    fireEvent.change(screen.getByLabelText('Line source sheet'), { target: { value: 'P- Nasi Ayam' } });
    fireEvent.change(screen.getByLabelText('Source row'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Issues'), { target: { value: 'checked' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shared ingredient' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save line' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(tables.writes[0]).toEqual({
      table: 'bom_lines',
      payload: {
        entity_code: 'QT',
        component_name: 'Chicken',
        qty: 180,
        unit: 'GM',
        base_qty: 180,
        price_basis: 'list',
        line_cost_rm: 0.8,
        cost_complete: true,
        shared_ingredient: true,
        status: 'active',
        source_sheet: 'P- Nasi Ayam',
        source_row: 12,
        issues: 'checked',
        supplier_item_id: null,
        component_sub_recipe_id: null,
      },
    });

    tables.writes = [];
    fireEvent.click(screen.getByRole('button', { name: 'Edit Chicken' }));
    fireEvent.change(screen.getByLabelText('Price basis'), { target: { value: 'pending' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cost complete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save line' }));
    expect((await screen.findByRole('alert')).textContent).toContain('pending');
    expect(tables.writes).toEqual([]);
  });

  it('hides the screen from anyone who is not an admin', () => {
    auth.isAdmin = false;
    render(<Costing />);
    expect(screen.getByText('No access')).toBeTruthy();
    expect(screen.queryByText('Nasi Ayam')).toBeNull();
  });
});
