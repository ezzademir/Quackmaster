import { describe, expect, it } from 'vitest';
import { canViewPosCompare, isViewerAllowedPath, storehubActionAllowed } from './roles';

describe('canViewPosCompare', () => {
  it('allows admin and viewer only', () => {
    expect(canViewPosCompare('admin')).toBe(true);
    expect(canViewPosCompare(' Viewer ')).toBe(true);
    for (const r of ['staff', 'supervisor', 'pending', '', null, undefined]) expect(canViewPosCompare(r)).toBe(false);
  });
});

describe('isViewerAllowedPath', () => {
  it('confines viewer to POS compare', () => {
    expect(isViewerAllowedPath('/pos-compare')).toBe(true);
    expect(isViewerAllowedPath('/required-password-reset')).toBe(true);
    for (const p of ['/', '/users', '/settings', '/ledger', '/stock-take', '/sales']) expect(isViewerAllowedPath(p)).toBe(false);
  });
});

describe('storehubActionAllowed', () => {
  it('admin may run every action', () => {
    for (const a of ['status', 'catalog', 'report', 'sync']) expect(storehubActionAllowed('admin', a)).toBe(true);
  });
  it('viewer gets read actions but never sync', () => {
    for (const a of ['status', 'catalog', 'report']) expect(storehubActionAllowed('viewer', a)).toBe(true);
    expect(storehubActionAllowed('viewer', 'sync')).toBe(false);
    expect(storehubActionAllowed('viewer', 'anything')).toBe(false);
  });
  it('other roles get nothing', () => {
    for (const r of ['staff', 'supervisor', 'pending', '']) expect(storehubActionAllowed(r, 'report')).toBe(false);
  });
});
