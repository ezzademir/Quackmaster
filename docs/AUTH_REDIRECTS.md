# Authentication redirect URLs (Quackmaster)

Password recovery emails use Supabase **`resetPasswordForEmail`** with a **`redirectTo`** URL built at runtime (see [`src/utils/passwordRules.ts`](src/utils/passwordRules.ts), function `getPasswordRecoveryRedirectUrl()`).

## What to whitelist

In **Supabase Dashboard → Authentication → URL configuration**:

1. **Site URL** — your deployed app origin (e.g. `https://your-org.github.io/Quackmaster/` on GitHub Pages, or `http://localhost:5173/` for local dev).
2. **Redirect URLs** — add every URL that must receive the user after they click the email link. Include:
   - Local: `http://localhost:5173/**` (or the exact hash URL your dev server uses).
   - Production: the full hash recovery URL pattern, e.g.  
     `https://your-org.github.io/Quackmaster/#/reset-password`  
     (wildcard `**` entries are supported if your Supabase project allows them).

The app uses **Hash routing** (`#/reset-password`). The value returned by `getPasswordRecoveryRedirectUrl()` must match an allowed redirect URL or Supabase will reject the redirect.

## Operator checklist

- After changing hosting domain or base path, update **Redirect URLs** and retest **Send password reset email** from **Users**.
- Deploy the **`admin_set_user_password`** Edge Function (`supabase functions deploy admin_set_user_password`) so admins can set a temporary password from **Users**.
