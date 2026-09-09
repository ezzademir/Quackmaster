# Pack 1 — Auth lockdown notes

Draft PR for audit **P0** (and selected **P1**) items from `auth-rbac.md`.

## What changed

| Area | Change |
|------|--------|
| `profiles` | `CHECK (role IN ('admin','staff','pending','supervisor'))`; default `pending` |
| `handle_new_user()` | Always inserts `role='pending'`; ignores `raw_user_meta_data.role` |
| Trigger | `trg_profiles_enforce_privileged_columns` blocks non-admin changes to `role`, `assigned_outlet_id`, `password_reset_required` |
| RPC | `clear_own_password_reset_required()` — used after a successful password change |
| `pending_registrations` | Dropped **anon** INSERT policies; authenticated own-row insert remains |
| Edge `force_password_reset` | Now requires Bearer JWT + `profiles.role = 'admin'` (same pattern as `admin_set_user_password`). App UI still sets the flag via direct admin profile UPDATE / temp-password function; this Edge Function is retained but locked down. |
| `App.tsx` | Fail closed when session exists but profile is missing after load |

## HOLD

Do **not** merge or deploy until Clive signs off.
