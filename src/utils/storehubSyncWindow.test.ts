import { describe, expect, it } from 'vitest';
import {
  addIsoDays,
  autoSyncWindowFrom,
} from '../../supabase/functions/sync_storehub_sales/window.ts';

describe('autoSyncWindowFrom', () => {
  it('keeps yesterday in range once last_success_to has advanced to today', () => {
    expect(autoSyncWindowFrom('2026-09-09', '2026-09-09')).toBe('2026-09-08');
  });

  it('does not widen a gap that already includes yesterday', () => {
    expect(autoSyncWindowFrom('2026-09-06', '2026-09-09')).toBe('2026-09-06');
  });

  it('uses a 7-day lookback when last_success_to is empty', () => {
    expect(autoSyncWindowFrom(null, '2026-09-09')).toBe('2026-09-03');
    expect(autoSyncWindowFrom('  ', '2026-09-09')).toBe('2026-09-03');
  });

  it('crosses month boundaries when overlapping yesterday', () => {
    expect(autoSyncWindowFrom('2026-09-01', '2026-09-01')).toBe('2026-08-31');
  });
});

describe('addIsoDays', () => {
  it('adds calendar days in UTC without local TZ drift', () => {
    expect(addIsoDays('2026-09-08', 1)).toBe('2026-09-09');
    expect(addIsoDays('2026-09-08', -1)).toBe('2026-09-07');
  });
});
