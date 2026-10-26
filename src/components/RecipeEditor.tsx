import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BomLineRow, RecipeCostRow, RecipeParent } from '../utils/costingDisplay';
import {
  PRICE_BASES,
  RECIPE_STATUSES,
  lineWrite,
  recipeWrite,
  textField,
  type LineFieldInput,
  type RecipeFieldInput,
} from '../utils/recipeEdit';
import { supabase } from '../utils/supabase';
import { Button } from './ui';

const controlClass = 'min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm text-stone-900';

function recipeDraft(recipe: RecipeCostRow, parent: RecipeParent): RecipeFieldInput {
  return {
    kind: recipe.kind,
    name: recipe.name,
    entity_code: recipe.entity_code,
    status: recipe.status,
    source_sheet: textField(recipe.source_sheet),
    selling_price: textField(recipe.selling_price_ex_sst_rm),
    wastage_pct: textField(parent.wastage_pct),
    servings: textField(parent.servings),
    packaging_rule: textField(parent.packaging_rule),
    pkg_dine_in: textField(parent.pkg_dine_in_rm),
    pkg_takeaway: textField(parent.pkg_takeaway_rm),
    yield_note: textField(parent.yield_note),
    notes: textField(parent.notes),
  };
}

function lineDraft(line: BomLineRow, fallbackEntity: string): LineFieldInput {
  return {
    entity_code: line.entity_code || fallbackEntity,
    component_name: line.component_name,
    qty: textField(line.qty),
    unit: textField(line.unit),
    base_qty: textField(line.base_qty),
    price_basis: line.price_basis,
    line_cost: textField(line.line_cost_rm),
    cost_complete: line.cost_complete,
    shared_ingredient: line.shared_ingredient,
    status: line.status,
    source_sheet: textField(line.source_sheet),
    source_row: textField(line.source_row),
    issues: textField(line.issues),
    supplier_item_id: textField(line.supplier_item_id),
    component_sub_recipe_id: textField(line.component_sub_recipe_id),
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-stone-500">{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  label,
  value,
  onChange,
  inputMode = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: 'text' | 'decimal' | 'numeric';
}) {
  return (
    <Field label={label}>
      <input className={controlClass} inputMode={inputMode} autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function AreaInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field label={label}>
      <textarea className={`${controlClass} py-2`} rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function ChoiceInput({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const choices = options.includes(value) ? options : [value, ...options];
  return (
    <Field label={label}>
      <select className={controlClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {choices.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </Field>
  );
}

function CheckInput({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm text-stone-800">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function RecipeFields({
  draft,
  entities,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: RecipeFieldInput;
  entities: string[];
  busy: boolean;
  onChange: (next: RecipeFieldInput) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const entitiesForSelect = Array.from(new Set([draft.entity_code, ...entities].filter(Boolean)));
  const set = (patch: Partial<RecipeFieldInput>) => onChange({ ...draft, ...patch });
  const kindFields = (() => {
    switch (draft.kind) {
      case 'dish':
        return (
          <>
            <TextInput label="Packaging rule" value={draft.packaging_rule} onChange={(packaging_rule) => set({ packaging_rule })} />
            <TextInput label="Dine-in packaging RM" value={draft.pkg_dine_in} inputMode="decimal" onChange={(pkg_dine_in) => set({ pkg_dine_in })} />
            <TextInput label="Takeaway packaging RM" value={draft.pkg_takeaway} inputMode="decimal" onChange={(pkg_takeaway) => set({ pkg_takeaway })} />
          </>
        );
      case 'sub-recipe':
        return <AreaInput label="Yield note" value={draft.yield_note} onChange={(yield_note) => set({ yield_note })} />;
      default: {
        const _exhaustive: never = draft.kind;
        return _exhaustive;
      }
    }
  })();

  return (
    <form
      className="space-y-3 rounded-2xl border border-stone-200 bg-stone-50 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput label="Name" value={draft.name} onChange={(name) => set({ name })} />
        <ChoiceInput label="Recipe entity" value={draft.entity_code} options={entitiesForSelect} onChange={(entity_code) => set({ entity_code })} />
        <ChoiceInput label="Recipe status" value={draft.status} options={RECIPE_STATUSES} onChange={(status) => set({ status })} />
        <TextInput label="Source sheet" value={draft.source_sheet} onChange={(source_sheet) => set({ source_sheet })} />
        <TextInput label="Selling price ex SST" value={draft.selling_price} inputMode="decimal" onChange={(selling_price) => set({ selling_price })} />
        <TextInput label="Wastage %" value={draft.wastage_pct} inputMode="decimal" onChange={(wastage_pct) => set({ wastage_pct })} />
        <TextInput label="Servings" value={draft.servings} inputMode="decimal" onChange={(servings) => set({ servings })} />
        {kindFields}
      </div>
      <AreaInput label="Notes" value={draft.notes} onChange={(notes) => set({ notes })} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          Save recipe
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function LineFields({
  line,
  entities,
  busy,
  onSubmit,
  onCancel,
}: {
  line: BomLineRow;
  entities: string[];
  busy: boolean;
  onSubmit: (draft: LineFieldInput) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<LineFieldInput>(() => lineDraft(line, line.entity_code || ''));
  const entitiesForSelect = Array.from(new Set([draft.entity_code, ...entities].filter(Boolean)));
  const set = (patch: Partial<LineFieldInput>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <form
      className="mt-2 space-y-3 rounded-2xl border border-stone-200 bg-stone-50 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput label="Component" value={draft.component_name} onChange={(component_name) => set({ component_name })} />
        <ChoiceInput label="Line entity" value={draft.entity_code} options={entitiesForSelect} onChange={(entity_code) => set({ entity_code })} />
        <ChoiceInput label="Line status" value={draft.status} options={RECIPE_STATUSES} onChange={(status) => set({ status })} />
        <ChoiceInput
          label="Price basis"
          value={draft.price_basis}
          options={PRICE_BASES}
          onChange={(price_basis) => set({ price_basis, cost_complete: price_basis === 'pending' ? false : draft.cost_complete })}
        />
        <TextInput label="Quantity" value={draft.qty} inputMode="decimal" onChange={(qty) => set({ qty })} />
        <TextInput label="Unit" value={draft.unit} onChange={(unit) => set({ unit })} />
        <TextInput label="Base quantity" value={draft.base_qty} inputMode="decimal" onChange={(base_qty) => set({ base_qty })} />
        <TextInput label="Line cost RM" value={draft.line_cost} inputMode="decimal" onChange={(line_cost) => set({ line_cost })} />
        <TextInput label="Line source sheet" value={draft.source_sheet} onChange={(source_sheet) => set({ source_sheet })} />
        <TextInput label="Source row" value={draft.source_row} inputMode="numeric" onChange={(source_row) => set({ source_row })} />
        <TextInput label="Supplier item" value={draft.supplier_item_id} onChange={(supplier_item_id) => set({ supplier_item_id })} />
        <TextInput
          label="Component sub-recipe"
          value={draft.component_sub_recipe_id}
          onChange={(component_sub_recipe_id) => set({ component_sub_recipe_id })}
        />
      </div>
      <AreaInput label="Issues" value={draft.issues} onChange={(issues) => set({ issues })} />
      <CheckInput label="Cost complete" checked={draft.cost_complete} onChange={(cost_complete) => set({ cost_complete })} />
      <CheckInput label="Shared ingredient" checked={draft.shared_ingredient} onChange={(shared_ingredient) => set({ shared_ingredient })} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          Save line
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function RecipeEditor({
  recipe,
  parent,
  lines,
  onSaved,
}: {
  recipe: RecipeCostRow;
  parent: RecipeParent | null;
  lines: BomLineRow[];
  onSaved: () => void;
}) {
  const [entities, setEntities] = useState<string[]>([]);
  const [editingRecipe, setEditingRecipe] = useState(false);
  const [draft, setDraft] = useState<RecipeFieldInput | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error: loadError } = await supabase.from('business_entities').select('code').order('code');
      if (cancelled || loadError || !data) return;
      setEntities((data as Array<{ code: string }>).map((row) => row.code));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveRecipe() {
    if (!draft || busyRef.current) return;
    const parsed = recipeWrite(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      setNotice(null);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const { error: saveError } = await supabase.from(parsed.table).update(parsed.values).eq('id', recipe.id);
    busyRef.current = false;
    setBusy(false);
    if (saveError) {
      setError(saveError.message);
      setNotice(null);
      return;
    }
    setError(null);
    setNotice('Saved');
    setEditingRecipe(false);
    onSaved();
  }

  async function saveLine(line: BomLineRow, input: LineFieldInput) {
    if (busyRef.current) return;
    const parsed = lineWrite({ ...input, entity_code: input.entity_code || recipe.entity_code });
    if (!parsed.ok) {
      setError(parsed.error);
      setNotice(null);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const { error: saveError } = await supabase.from('bom_lines').update(parsed.values).eq('id', line.id);
    busyRef.current = false;
    setBusy(false);
    if (saveError) {
      setError(saveError.message);
      setNotice(null);
      return;
    }
    setError(null);
    setNotice('Saved');
    setEditingLineId(null);
    onSaved();
  }

  return (
    <div className="space-y-3" data-no-swipe>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-stone-500">Food cost recalculates from the lines, wastage, and servings.</p>
        {notice ? <p className="text-sm text-brand-800">{notice}</p> : null}
      </div>
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {editingRecipe && draft ? (
        <RecipeFields
          draft={draft}
          entities={entities}
          busy={busy}
          onChange={setDraft}
          onSubmit={() => void saveRecipe()}
          onCancel={() => setEditingRecipe(false)}
        />
      ) : (
        <Button
          disabled={parent == null || busy}
          onClick={() => {
            if (!parent) return;
            setDraft(recipeDraft(recipe, parent));
            setEditingRecipe(true);
            setNotice(null);
            setError(null);
          }}
        >
          Edit recipe
        </Button>
      )}
      {lines.map((line) =>
        editingLineId === line.id ? (
          <LineFields
            key={line.id}
            line={{ ...line, entity_code: line.entity_code || recipe.entity_code }}
            entities={entities}
            busy={busy}
            onSubmit={(input) => void saveLine(line, input)}
            onCancel={() => setEditingLineId(null)}
          />
        ) : (
          <Button
            key={line.id}
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setEditingLineId(line.id);
              setNotice(null);
              setError(null);
            }}
          >
            {`Edit ${line.component_name}`}
          </Button>
        ),
      )}
    </div>
  );
}
