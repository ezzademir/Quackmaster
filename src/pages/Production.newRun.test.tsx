// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RawMaterial, Recipe, RecipeIngredient } from '../types';

const { from } = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../utils/supabase', () => ({
  supabase: { from },
  isSupabaseConfigured: true,
}));

import { NewRunModal } from './Production';

const stamp = '2026-11-22T00:00:00.000Z';

function material(id: string, name: string): RawMaterial {
  return { id, name, unit_of_measure: 'kg', created_at: stamp, updated_at: stamp };
}

function ingredient(recipeId: string, raw: RawMaterial, qty: number): RecipeIngredient & { material: RawMaterial } {
  return {
    id: `${recipeId}-${raw.id}`,
    recipe_id: recipeId,
    raw_material_id: raw.id,
    quantity_required: qty,
    created_at: stamp,
    updated_at: stamp,
    material: raw,
  };
}

function recipe(
  id: string,
  name: string,
  ingredients: Array<RecipeIngredient & { material?: RawMaterial }>,
): Recipe & { ingredients: Array<RecipeIngredient & { material?: RawMaterial }> } {
  return {
    id,
    name,
    standard_batch_size: 10,
    batch_unit: 'kg',
    target_yield_percentage: 100,
    created_at: stamp,
    updated_at: stamp,
    ingredients,
  };
}

const chicken = material('rm-chicken', 'Chicken');
const rice = material('rm-rice', 'Rice');
const chickenRecipe = recipe('recipe-chicken', 'Chicken rice', [ingredient('recipe-chicken', chicken, 2)]);
const sauceRecipe = recipe('recipe-sauce', 'Sauce', [ingredient('recipe-sauce', rice, 1)]);
const emptyRecipe = recipe('recipe-empty', 'Empty assembly', []);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  from.mockReset();
});

function renderModal(recipes: Array<Recipe & { ingredients?: Array<RecipeIngredient & { material?: RawMaterial }> }>) {
  render(
    <NewRunModal
      recipes={recipes}
      onClose={() => {}}
      onSave={() => {}}
      profile={{ role: 'admin' }}
    />,
  );
}

describe('New production run material load', () => {
  it('does not complete from a slower recipe response', async () => {
    const slow = deferred<{ data: { raw_material_id: string; quantity_on_hand: number }[]; error: null }>();
    from.mockImplementation(() => ({
      select: () => ({
        in: (_column: string, ids: string[]) => {
          if (ids.includes('rm-chicken')) return slow.promise;
          return Promise.resolve({
            data: [{ raw_material_id: 'rm-rice', quantity_on_hand: 3 }],
            error: null,
          });
        },
      }),
    }));

    renderModal([chickenRecipe, sauceRecipe]);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'recipe-chicken' } });
    expect((screen.getByRole('button', { name: 'Loading materials…' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(select, { target: { value: 'recipe-sauce' } });
    await waitFor(() => expect(screen.getByText('Rice')).toBeTruthy());
    expect(screen.queryByText('Chicken')).toBeNull();
    expect((screen.getByRole('button', { name: 'Complete Run & Update Stock' }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      slow.resolve({ data: [{ raw_material_id: 'rm-chicken', quantity_on_hand: 8 }], error: null });
    });
    expect(screen.queryByText('Chicken')).toBeNull();
    expect(screen.getByText('Rice')).toBeTruthy();
  });

  it('drops the previous recipe when the next inventory load fails', async () => {
    from.mockImplementation(() => ({
      select: () => ({
        in: (_column: string, ids: string[]) => {
          if (ids.includes('rm-chicken')) {
            return Promise.resolve({
              data: [{ raw_material_id: 'rm-chicken', quantity_on_hand: 8 }],
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: { message: 'network' } });
        },
      }),
    }));

    renderModal([chickenRecipe, sauceRecipe]);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'recipe-chicken' } });
    await waitFor(() => expect(screen.getByText('Chicken')).toBeTruthy());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'recipe-sauce' } });
    await waitFor(() => expect(screen.getByText('Failed to load raw material inventory. Please try again.')).toBeTruthy());
    expect(screen.queryByText('Chicken')).toBeNull();
    expect(screen.queryByText('Rice')).toBeNull();
    expect((screen.getByRole('button', { name: 'Complete Run & Update Stock' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets a recipe with no ingredients complete without keeping the previous lines', async () => {
    const slow = deferred<{ data: { raw_material_id: string; quantity_on_hand: number }[]; error: null }>();
    from.mockImplementation(() => ({
      select: () => ({
        in: () => slow.promise,
      }),
    }));

    renderModal([chickenRecipe, emptyRecipe]);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'recipe-chicken' } });
    fireEvent.change(select, { target: { value: 'recipe-empty' } });
    expect((screen.getByRole('button', { name: 'Complete Run & Update Stock' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Chicken')).toBeNull();

    await act(async () => {
      slow.resolve({ data: [{ raw_material_id: 'rm-chicken', quantity_on_hand: 8 }], error: null });
    });
    expect(screen.queryByText('Chicken')).toBeNull();
  });
});
