/** Matches Register / Auth validation. */
export const MIN_PASSWORD_LENGTH = 6;

/** Full URL for `resetPasswordForEmail` `redirectTo`. Add to Supabase → Authentication → URL configuration → Redirect URLs. */
export function getPasswordRecoveryRedirectUrl(): string {
  const root = `${window.location.origin}${window.location.pathname}`.replace(/#.*$/, '');
  const normalized = root.endsWith('/') ? root.slice(0, -1) : root;
  return `${normalized}/#/reset-password`;
}
