/**
 * Discount authorization (Phase 7, Batch 1, decision E2).
 *
 * A STAFF cashier may give at most the store's staff discount limit (default 0 %). Anything higher needs an
 * ADMIN to authorize it at the counter: the admin signs in on the cashier's screen, states the maximum % and
 * a reason, and the host issues a short-lived, single-use grant bound to that cashier. The sale consumes it.
 *
 * Grants live only in the host's memory: they expire after 10 minutes and do not survive a host restart
 * (the cashier simply asks again). They are never written to disk and never sent to another computer
 * except as the opaque token in the cashier's own sale request.
 */
import crypto from 'node:crypto';

export interface DiscountGrant {
  cashierUserId: number;
  authorizedByUserId: number;
  authorizedByName: string;
  tenantId: number;
  maxPercent: number;
  reason: string;
  expiresAt: number;
  used: boolean;
}

export type GrantCheck = { ok: true; grant: DiscountGrant } | { ok: false; code: string; error: string };

export class DiscountAuthorizations {
  private grants = new Map<string, DiscountGrant>();
  constructor(private readonly ttlMs = 10 * 60_000, private readonly now = () => Date.now()) {}

  issue(g: Omit<DiscountGrant, 'expiresAt' | 'used'>): { token: string; expiresAt: string } {
    this.sweep();
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = this.now() + this.ttlMs;
    this.grants.set(token, { ...g, expiresAt, used: false });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Validate without consuming (used by the price preview and before the sale is written). */
  check(token: unknown, cashierUserId: number, tenantId: number, neededPercent: number): GrantCheck {
    const g = typeof token === 'string' ? this.grants.get(token) : undefined;
    if (!g) return { ok: false, code: 'DISCOUNT_AUTH_INVALID', error: 'The discount authorization is not valid (it may have expired or the server restarted). Ask an administrator to authorize it again.' };
    if (g.used) return { ok: false, code: 'DISCOUNT_AUTH_USED', error: 'This discount authorization has already been used for another sale.' };
    if (g.expiresAt <= this.now()) return { ok: false, code: 'DISCOUNT_AUTH_EXPIRED', error: 'The discount authorization has expired. Ask an administrator to authorize it again.' };
    if (g.cashierUserId !== cashierUserId || g.tenantId !== tenantId) return { ok: false, code: 'DISCOUNT_AUTH_INVALID', error: 'This discount authorization was given to another cashier.' };
    if (neededPercent > g.maxPercent + 1e-9) return { ok: false, code: 'DISCOUNT_AUTH_TOO_LOW', error: `The authorization allows up to ${g.maxPercent}% discount; this sale uses ${neededPercent}%.` };
    return { ok: true, grant: g };
  }

  consume(token: string): void {
    const g = this.grants.get(token);
    if (g) g.used = true;
  }

  private sweep() {
    const t = this.now();
    for (const [k, g] of this.grants) if (g.expiresAt <= t || g.used) this.grants.delete(k);
  }
}

/** Store discount limits (settings), clamped to 0..100; the staff limit never exceeds the admin limit. */
export function discountLimits(read: (key: string) => string | undefined): { staff: number; admin: number } {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v === undefined || v === '' || !Number.isFinite(n) ? d : Math.min(100, Math.max(0, n));
  };
  const admin = num(read('pos_admin_max_discount_percent'), 100);
  const staff = Math.min(num(read('pos_staff_max_discount_percent'), 0), admin);
  return { staff, admin };
}
