-- Link orphan bom lines without taking over a line that already has a supplier item.
--
-- Safety checks:
-- 1. A line is updated only when supplier_item_id and component_sub_recipe_id are both null.
-- 2. Tap water is the exact name WATER. WARM WATER, AIR, and Mineral Water are left alone.
-- 3. The zero-cost item is a new system row (source SYSTEM_ZERO_COST / 1), not IN HOUSE PRODUCTION.
-- 4. unit_cost_rm is generated from price 0 / 1000 ml. The price log records source 'list'.
-- 5. A sub-recipe name match is applied only when exactly one other sub-recipe matches
--    (case-insensitive, trimmed) and that sub-recipe is not the line's own parent.
-- 6. Ambiguous names are left unlinked. The migration raises if tap water is still unlinked.
-- 7. A line cannot point at a supplier item and a sub-recipe at the same time.

SELECT set_config('app.price_source', 'list', true);
SELECT set_config('app.price_note', 'system tap water zero cost', true);

INSERT INTO public.ingredients (name, base_unit, in_house, status)
SELECT 'Tap water', 'ml', true, 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ingredients
  WHERE lower(name) = 'tap water' AND base_unit = 'ml'
);

INSERT INTO public.suppliers (name, status)
SELECT 'Tap water (system)', 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM public.suppliers
  WHERE name = 'Tap water (system)'
);

INSERT INTO public.supplier_items (
  supplier_id,
  ingredient_id,
  procurement_tag,
  shared_ingredient,
  item_name,
  pack_qty,
  pack_unit,
  base_unit,
  pack_qty_base,
  price_rm,
  price_basis,
  status,
  source_list,
  source_line_no,
  notes
)
SELECT
  (SELECT id FROM public.suppliers WHERE name = 'Tap water (system)' ORDER BY created_at LIMIT 1),
  (SELECT id FROM public.ingredients WHERE lower(name) = 'tap water' AND base_unit = 'ml' ORDER BY created_at LIMIT 1),
  'merdeka_house',
  true,
  'Tap water',
  1000,
  'ml',
  'ml',
  1000,
  0,
  'list',
  'active',
  'SYSTEM_ZERO_COST',
  1,
  'System zero-cost tap water for recipe lines named WATER. Not a purchased ingredient.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.supplier_items
  WHERE source_list = 'SYSTEM_ZERO_COST' AND source_line_no = 1
)
  AND (SELECT id FROM public.suppliers WHERE name = 'Tap water (system)' ORDER BY created_at LIMIT 1) IS NOT NULL
  AND (SELECT id FROM public.ingredients WHERE lower(name) = 'tap water' AND base_unit = 'ml' ORDER BY created_at LIMIT 1) IS NOT NULL;

UPDATE public.bom_lines AS line
SET supplier_item_id = item.id,
    price_basis = CASE WHEN line.price_basis = 'pending' THEN 'list' ELSE line.price_basis END,
    line_cost_rm = COALESCE(line.line_cost_rm, 0),
    cost_complete = true
FROM public.supplier_items AS item
WHERE item.source_list = 'SYSTEM_ZERO_COST'
  AND item.source_line_no = 1
  AND line.supplier_item_id IS NULL
  AND line.component_sub_recipe_id IS NULL
  AND lower(trim(line.component_name)) = 'water';

WITH matches AS (
  SELECT line.id AS line_id, prep.id AS sub_id
  FROM public.bom_lines AS line
  JOIN public.sub_recipes AS prep
    ON lower(trim(prep.name)) = lower(trim(line.component_name))
  WHERE line.supplier_item_id IS NULL
    AND line.component_sub_recipe_id IS NULL
    AND lower(trim(line.component_name)) <> 'water'
    AND prep.id IS DISTINCT FROM line.sub_recipe_id
),
unique_matches AS (
  SELECT line_id, min(sub_id::text)::uuid AS sub_id
  FROM matches
  GROUP BY line_id
  HAVING count(*) = 1
)
UPDATE public.bom_lines AS line
SET component_sub_recipe_id = unique_matches.sub_id
FROM unique_matches
WHERE line.id = unique_matches.line_id
  AND line.supplier_item_id IS NULL
  AND line.component_sub_recipe_id IS NULL;

DO $$
DECLARE
  v_open integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.supplier_items
    WHERE source_list = 'SYSTEM_ZERO_COST' AND source_line_no = 1 AND price_rm = 0
  ) THEN
    RAISE EXCEPTION 'Tap water supplier item was not created at price 0';
  END IF;

  SELECT count(*) INTO v_open
  FROM public.bom_lines
  WHERE supplier_item_id IS NULL
    AND component_sub_recipe_id IS NULL
    AND lower(trim(component_name)) = 'water';
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'Tap water lines are still unlinked: %', v_open;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bom_lines
    WHERE supplier_item_id IS NOT NULL AND component_sub_recipe_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A bom line points at both a supplier item and a sub-recipe';
  END IF;
END $$;

ALTER TABLE public.bom_lines
  DROP CONSTRAINT IF EXISTS bom_lines_one_component;
ALTER TABLE public.bom_lines
  ADD CONSTRAINT bom_lines_one_component
  CHECK (supplier_item_id IS NULL OR component_sub_recipe_id IS NULL);
