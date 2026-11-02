import { useEffect, useState } from 'react';
import type { BomLineRow } from '../utils/costingDisplay';
import { formatRm } from '../utils/costingDisplay';
import { subRecipeLabel, supplierItemLabel } from '../utils/bomLineCost';
import { Button } from './ui';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { useBomCatalog, useBomLineCost, type BomCostLine } from './BomCostProvider';

type LinkKind = 'supplier' | 'sub-recipe';

const KINDS: { id: LinkKind; label: string }[] = [
  { id: 'supplier', label: 'Supplier Item (Ingredient)' },
  { id: 'sub-recipe', label: 'Sub-Recipe (Prep)' },
];

function badge(kind: LinkKind) {
  const label = kind === 'supplier' ? 'Vendor Item' : 'Sub-Recipe';
  const tone = kind === 'supplier' ? 'bg-stone-100 text-stone-700' : 'bg-amber-50 text-brand-800';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{label}</span>;
}

export function BomLinkReadout({ line }: { line: BomCostLine & { component_name?: string } }) {
  const { catalog } = useBomCatalog();
  const cost = useBomLineCost(line);
  const supplier = line.supplier_item_id ? catalog.supplierItems.get(line.supplier_item_id) : undefined;
  const prep = line.component_sub_recipe_id ? catalog.subRecipes.get(line.component_sub_recipe_id) : undefined;
  const kind: LinkKind | null = line.component_sub_recipe_id ? 'sub-recipe' : line.supplier_item_id ? 'supplier' : null;
  const title = supplier ? supplierItemLabel(supplier) : prep ? subRecipeLabel(prep) : 'Not linked';

  return (
    <div className="space-y-1 text-[13px] text-stone-600">
      <div className="flex flex-wrap items-center gap-2">
        {kind ? badge(kind) : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Unlinked</span>}
        <span className="text-stone-800">{title}</span>
      </div>
      <p className="tabular-nums">
        Unit cost {formatRm(cost.unitCost, 4)} · Line cost {formatRm(cost.lineTotal, 4)}
      </p>
      {cost.warning ? <p className="text-amber-800">Warning: {cost.warning}</p> : null}
    </div>
  );
}

export function BomLinkField({
  line,
  supplierItemId,
  componentSubRecipeId,
  excludeSubRecipeId,
  onChange,
}: {
  line: BomLineRow;
  supplierItemId: string;
  componentSubRecipeId: string;
  excludeSubRecipeId: string | null;
  onChange: (next: { supplier_item_id: string; component_sub_recipe_id: string }) => void;
}) {
  const { catalog, loading } = useBomCatalog();
  const linked = Boolean(supplierItemId || componentSubRecipeId);
  const [kind, setKind] = useState<LinkKind>(componentSubRecipeId ? 'sub-recipe' : 'supplier');
  const [picking, setPicking] = useState(!linked);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setKind(componentSubRecipeId ? 'sub-recipe' : 'supplier');
    setPicking(!(supplierItemId || componentSubRecipeId));
  }, [supplierItemId, componentSubRecipeId]);

  const draftLine: BomCostLine = {
    ...line,
    supplier_item_id: supplierItemId || null,
    component_sub_recipe_id: componentSubRecipeId || null,
  };
  const items = [...catalog.supplierItems.values()].sort((a, b) => supplierItemLabel(a).localeCompare(supplierItemLabel(b)));
  const preps = [...catalog.subRecipes.values()]
    .filter((prep) => prep.id !== excludeSubRecipeId)
    .sort((a, b) => a.name.localeCompare(b.name));

  function chooseSupplier(id: string) {
    onChange({ supplier_item_id: id, component_sub_recipe_id: '' });
    setOpen(false);
  }

  function choosePrep(id: string) {
    onChange({ supplier_item_id: '', component_sub_recipe_id: id });
    setOpen(false);
  }

  return (
    <div className="space-y-2 sm:col-span-2">
      {linked && !picking ? (
        <div className="space-y-2 rounded-2xl border border-stone-200 bg-white p-3">
          <BomLinkReadout line={draftLine} />
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setPicking(true)}>
              Change
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange({ supplier_item_id: '', component_sub_recipe_id: '' })}
            >
              Unlink
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full bg-black/5 p-1" data-no-swipe>
            {KINDS.map((choice) => (
              <button
                key={choice.id}
                type="button"
                aria-pressed={kind === choice.id}
                className={`min-h-9 shrink-0 rounded-full px-3 text-[13px] font-semibold ${kind === choice.id ? 'bg-white text-brand-800' : 'text-stone-500'}`}
                onClick={() => setKind(choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="secondary" className="w-full justify-start" disabled={loading}>
                {loading ? 'Loading catalogue…' : kind === 'supplier' ? 'Search supplier items' : 'Search sub-recipes'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" data-no-swipe>
              {kind === 'supplier' ? (
                <Command label="Supplier items">
                  <CommandInput placeholder="Ingredient, pack, or supplier" />
                  <CommandList>
                    <CommandEmpty>No supplier items match.</CommandEmpty>
                    <CommandGroup>
                      {items.map((item) => {
                        const label = supplierItemLabel(item);
                        return (
                          <CommandItem key={item.id} value={`${item.id} ${label}`} onSelect={() => chooseSupplier(item.id)}>
                            {label}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              ) : (
                <Command label="Sub-recipes">
                  <CommandInput placeholder="Sub-recipe name" />
                  <CommandList>
                    <CommandEmpty>No sub-recipes match.</CommandEmpty>
                    <CommandGroup>
                      {preps.map((prep) => {
                        const label = subRecipeLabel(prep);
                        return (
                          <CommandItem key={prep.id} value={`${prep.id} ${label}`} onSelect={() => choosePrep(prep.id)}>
                            {label}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              )}
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  );
}
