// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EntityChip } from './EntityChip';

describe('EntityChip', () => {
  it('renders MH, QT and Untagged', () => {
    const { rerender } = render(<EntityChip code="MH" />);
    expect(screen.getByText('MH').className).toMatch(/sky/);
    rerender(<EntityChip code="qt" />);
    expect(screen.getByText('QT').className).toMatch(/violet/);
    rerender(<EntityChip code={null} />);
    const untagged = screen.getByText('Untagged');
    expect(untagged.className).toMatch(/amber/);
  });
});

describe('entity chip placements', () => {
  const files = import.meta.glob(['../pages/Procurement.tsx', './PoCancelRequestsTab.tsx'], {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>;
  const proc = Object.entries(files).find(([p]) => p.endsWith('Procurement.tsx'))?.[1] ?? '';
  const tab = Object.entries(files).find(([p]) => p.endsWith('PoCancelRequestsTab.tsx'))?.[1] ?? '';

  it('shows the chip on order rows, mobile cards, the modal header and cancellation rows', () => {
    expect(proc).toMatch(/<EntityChip code=\{order\.entity_code\} \/>/);
    expect(proc.match(/<EntityChip /g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(proc).toMatch(/Purchase Order: \{po\.order_number\}/);
    expect(proc).toMatch(/<EntityChip code=\{po\.entity_code\} \/>/);
    expect(tab).toMatch(/<EntityChip code=\{po\?\.entity_code\} \/>/);
  });
});
