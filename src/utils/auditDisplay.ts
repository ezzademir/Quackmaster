/** Human-readable formatting for Data Ledger rows */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ActorProfile {
  full_name: string;
  role: string;
}

export function actorDisplayName(profile: ActorProfile | undefined, email: string): string {
  const name = profile?.full_name?.trim();
  if (name) return name;
  return email?.trim() || 'Unknown user';
}

export function actorSubtitle(profile: ActorProfile | undefined, email: string): string {
  const parts: string[] = [];
  if (email?.trim()) parts.push(email.trim());
  if (profile?.role) parts.push(profile.role);
  return parts.join(' · ') || '';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function formatPrimitive(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number')
    return Number.isInteger(v) ? String(v) : String(roundSmart(v));
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string') return v.length > 180 ? `${v.slice(0, 177)}…` : v;
  if (Array.isArray(v)) return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function roundSmart(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function truncateId(id: string | undefined | null, head = 10): string {
  const s = id?.trim() ?? '';
  if (!s) return '—';
  if (s.length <= head + 3) return s;
  return `${s.slice(0, head)}…`;
}

export function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ');
}

function metaRecord(meta: unknown): Record<string, unknown> | null {
  return isPlainObject(meta) ? meta : null;
}

/** Ledger: primary “why” line */
export function ledgerPurposeLine(entry: {
  action: string;
  module: string;
  entity_type: string;
  operation: string;
  metadata: Record<string, unknown> | null;
}): string {
  const meta = metaRecord(entry.metadata);
  const label = meta?.entity_label != null && String(meta.entity_label).trim() ? String(meta.entity_label) : '';
  const reasonish =
    meta?.reason ?? meta?.cancellation_reason ?? meta?.rejection_reason;
  if (reasonish != null && String(reasonish).trim()) {
    const rs = String(reasonish);
    return label ? `${label}: ${rs}` : rs;
  }
  if (meta?.purpose != null && String(meta.purpose).trim()) {
    return label ? `${label} · ${String(meta.purpose)}` : String(meta.purpose);
  }
  if (label) return label;
  return `${humanizeKey(entry.module)} · ${humanizeKey(entry.entity_type)} (${entry.operation})`;
}

/** Ledger: human-readable value changes */
export function ledgerChangeBullets(entry: {
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  delta_data: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}): string[] {
  const lines: string[] = [];

  const delta = entry.delta_data && isPlainObject(entry.delta_data) ? entry.delta_data : null;
  const hasDelta = delta && Object.keys(delta).length > 0;

  if (hasDelta) {
    for (const [k, v] of Object.entries(delta!)) {
      lines.push(`Δ ${humanizeKey(k)}: ${formatPrimitive(v)}`);
    }
  }

  const before = entry.before_data && isPlainObject(entry.before_data) ? entry.before_data : null;
  const after = entry.after_data && isPlainObject(entry.after_data) ? entry.after_data : null;

  if (!hasDelta && (before || after)) {
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    for (const k of keys) {
      const b = before?.[k];
      const a = after?.[k];
      const same = JSON.stringify(b) === JSON.stringify(a);
      if (!same) {
        lines.push(`${humanizeKey(k)}: ${formatPrimitive(b)} → ${formatPrimitive(a)}`);
      }
    }
  }

  const meta = metaRecord(entry.metadata);
  if (meta) {
    const skip = new Set(['reason', 'purpose', 'entity_label', 'summary', 'cancellation_reason', 'rejection_reason']);
    for (const [k, v] of Object.entries(meta)) {
      if (skip.has(k)) continue;
      lines.push(`${humanizeKey(k)}: ${formatPrimitive(v)}`);
      if (lines.length >= 18) break;
    }
  }

  return lines.length ? lines : ['No stored field changes (event-only row)'];
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Resolve profile names for ledger / activity rows (admin RLS can read all profiles). */
export async function fetchActorProfilesMap(
  supabase: SupabaseClient,
  userIds: (string | null | undefined)[]
): Promise<Map<string, ActorProfile>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const map = new Map<string, ActorProfile>();
  if (ids.length === 0) return map;

  const { data, error } = await supabase.from('profiles').select('id, full_name, role').in('id', ids);

  if (error || !data) return map;

  for (const row of data as { id: string; full_name: string | null; role: string | null }[]) {
    map.set(row.id, {
      full_name: row.full_name ?? '',
      role: row.role ?? '',
    });
  }
  return map;
}
