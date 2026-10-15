import { describe, expect, it } from 'vitest';
import { productionFailureDisposition } from './productionCompletionOutcome';

describe('productionFailureDisposition', () => {
  it('cancels only a run that is still in progress', () => {
    expect(
      productionFailureDisposition({ statusReadFailed: false, liveStatus: 'in_progress' })
    ).toBe('cancel_in_progress');
  });

  it('does not cancel a run the server already completed', () => {
    expect(
      productionFailureDisposition({ statusReadFailed: false, liveStatus: 'completed' })
    ).toBe('already_posted');
  });

  it('leaves the run alone when status cannot be read', () => {
    expect(
      productionFailureDisposition({ statusReadFailed: true, liveStatus: null })
    ).toBe('unknown_leave_open');
  });

  it('does not overwrite voided or cancelled runs', () => {
    expect(
      productionFailureDisposition({ statusReadFailed: false, liveStatus: 'voided' })
    ).toBe('unknown_leave_open');
    expect(
      productionFailureDisposition({ statusReadFailed: false, liveStatus: 'cancelled' })
    ).toBe('unknown_leave_open');
  });
});
