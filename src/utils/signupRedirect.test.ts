import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSignupConfirmRedirectUrl } from './passwordRules';

describe('getSignupConfirmRedirectUrl', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('keeps the GitHub Pages base path and points at login', () => {
    vi.stubGlobal('window', { location: { origin: 'https://ezzademir.github.io', pathname: '/Quackmaster/' } });
    expect(getSignupConfirmRedirectUrl()).toBe('https://ezzademir.github.io/Quackmaster/#/login');
  });
  it('works without trailing slash / locally', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173', pathname: '/' } });
    expect(getSignupConfirmRedirectUrl()).toBe('http://localhost:5173/#/login');
  });
});
