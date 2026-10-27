import { describe, expect, it } from 'vitest';
import {
  canAccessPage,
  canUseFeature,
  featuresForPages,
  parseAccessPayload,
  presetAccess,
  resolveHomePath,
} from './accessCatalog';

describe('profile access catalog', () => {
  it('keeps staff and supervisor presets aligned with the previous shells', () => {
    expect(presetAccess('staff').pages).toContain('overview');
    expect(presetAccess('staff').pages).not.toContain('pos-compare');
    expect(presetAccess('staff').features).toEqual([]);
    expect(presetAccess('supervisor').pages).toEqual(['sales', 'waste', 'stock-take']);
  });

  it('lets admins through every grantable page and feature', () => {
    expect(canAccessPage('admin', [], 'audit')).toBe(true);
    expect(canUseFeature('admin', [], 'sales.void')).toBe(true);
    expect(canUseFeature('staff', [], 'sales.void')).toBe(false);
    expect(canUseFeature('staff', ['sales.void'], 'sales.void')).toBe(true);
  });

  it('drops features for pages that are off and pairs replace with void', () => {
    expect(featuresForPages(['sales.void', 'production.plan'], ['sales'])).toEqual(['sales.void']);
    expect(featuresForPages(['sales.replace'], ['sales'])).toEqual(['sales.replace', 'sales.void']);
  });

  it('ignores unknown keys from the server', () => {
    expect(parseAccessPayload({ pages: ['sales', 'users', 3], features: ['sales.void', 'nope'] })).toEqual({
      pages: ['sales'],
      features: ['sales.void'],
    });
  });

  it('sends supervisors without a dashboard to stock take', () => {
    expect(resolveHomePath('supervisor', ['sales', 'waste', 'stock-take'])).toBe('/stock-take');
    expect(resolveHomePath('staff', ['sales'])).toBe('/sales');
    expect(resolveHomePath('staff', [])).toBeNull();
    expect(resolveHomePath('admin', [])).toBe('/');
  });
});
