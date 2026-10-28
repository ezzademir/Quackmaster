/** Matches Register / Auth validation. */
export const MIN_PASSWORD_LENGTH = 6;

/** Full URL for `resetPasswordForEmail` `redirectTo`. Add to Supabase → Authentication → URL configuration → Redirect URLs. */
/** Where Supabase sends users after they click the sign-up confirmation link (keeps the /Quackmaster/ base path). */
export function getSignupConfirmRedirectUrl(): string {
  const root = `${window.location.origin}${window.location.pathname}`.replace(/#.*$/, '');
  const normalized = root.endsWith('/') ? root.slice(0, -1) : root;
  return `${normalized}/#/login`;
}

export function getPasswordRecoveryRedirectUrl(): string {
  const root = `${window.location.origin}${window.location.pathname}`.replace(/#.*$/, '');
  const normalized = root.endsWith('/') ? root.slice(0, -1) : root;
  return `${normalized}/#/reset-password`;
}
