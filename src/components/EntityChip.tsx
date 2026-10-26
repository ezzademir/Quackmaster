import { entityChip, type EntityChip as EntityChipModel } from '../utils/poCancelUi';

function chipClass(tone: EntityChipModel['tone']): string {
  switch (tone) {
    case 'untagged':
      return 'bg-amber-100 text-amber-800';
    case 'mh':
      return 'bg-sky-100 text-sky-800';
    case 'qt':
      return 'bg-violet-100 text-violet-800';
    default: {
      const _exhaustive: never = tone;
      return _exhaustive;
    }
  }
}

export function EntityChip({ code }: { code?: string | null }) {
  const chip = entityChip(code);
  return (
    <span
      data-entity-chip={chip.label}
      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${chipClass(chip.tone)}`}
    >
      {chip.label}
    </span>
  );
}
