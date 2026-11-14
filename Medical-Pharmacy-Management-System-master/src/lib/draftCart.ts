/**
 * POS draft cart: an unsaved cart kept on this computer so it can be resumed after the app or the
 * window was closed. It is NOT a sale and never reaches the server; resuming it only refills the cart.
 *
 * Rules (POS draft recovery fix):
 * - One draft per store and signed-in user, under `khushi_pos_draft_cart:<storeId>:<userId>`.
 *   The store and user are also stored inside the draft and must match; another user's or store's
 *   draft is never offered.
 * - Only product ids, quantities and discounts are stored. Prices and stock are always taken from the
 *   current catalogue when the draft is resumed.
 * - Expiry policy: a draft older than DRAFT_MAX_AGE_HOURS is removed when its owner opens the POS, and
 *   the cashier is told what was removed. (Prices and stock change and the customer has normally left.)
 * - Legacy drafts (`khushi_pos_draft_cart`, from before this fix) record no user or store, so their owner
 *   cannot be verified: they are never shown to anyone and are removed, with a notice.
 */
import type { CartItem, Customer, Product, User } from '../types';
import { priceLine } from '../../shared/pricing';

export const LEGACY_DRAFT_KEY = 'khushi_pos_draft_cart';
export const DRAFT_KEY_PREFIX = 'khushi_pos_draft_cart:';
/** Expiry policy (see above). Change here to configure. */
export const DRAFT_MAX_AGE_HOURS = 24;
const MAX_QUANTITY = 100_000;

export interface DraftOwner { storeId: string; userId: number }
export interface DraftLine { productId: number; productName: string; quantity: number; discountPercent: number }
export interface DraftCart {
  version: 2;
  storeId: string;
  userId: number;
  savedAt: string;
  customerId: number | null;
  customerName: string | null;
  discountPercent: number;
  lines: DraftLine[];
}

/** The small part of Storage that is used (a fake can be passed in tests). */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStorage = (): DraftStorage | null => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};

export function draftOwnerOf(user: Pick<User, 'id' | 'tenant_id'> | null | undefined): DraftOwner | null {
  if (!user || !Number.isInteger(user.id) || user.id <= 0) return null;
  return { storeId: user.tenant_id == null ? 'none' : String(user.tenant_id), userId: user.id };
}

export const draftKey = (o: DraftOwner) => `${DRAFT_KEY_PREFIX}${o.storeId}:${o.userId}`;

export function saveDraftCart(owner: DraftOwner, cart: CartItem[], customer: Pick<Customer, 'id' | 'name'> | null, discountPercent: number,
  now: Date = new Date(), kv: DraftStorage | null = defaultStorage()): void {
  if (!kv || !cart.length) return;
  const draft: DraftCart = {
    version: 2,
    storeId: owner.storeId,
    userId: owner.userId,
    savedAt: now.toISOString(),
    customerId: customer?.id ?? null,
    customerName: customer?.name ?? null,
    discountPercent: Number(discountPercent) || 0,
    lines: cart.map((it) => ({ productId: it.product.id, productName: it.product.name, quantity: it.quantity, discountPercent: Number(it.discount_percent) || 0 })),
  };
  try { kv.setItem(draftKey(owner), JSON.stringify(draft)); } catch (e) { console.error('Failed to save the draft cart', e); }
}

export function clearDraftCart(owner: DraftOwner, kv: DraftStorage | null = defaultStorage()): void {
  try { kv?.removeItem(draftKey(owner)); } catch { /* nothing to clear */ }
}

export type DraftInspection =
  | { status: 'none' }
  | { status: 'ok'; draft: DraftCart }
  | { status: 'expired'; draft: DraftCart }
  | { status: 'invalid'; reason: string };

function isDraftShape(d: any): d is DraftCart {
  return d && d.version === 2 && typeof d.storeId === 'string' && Number.isInteger(d.userId) && typeof d.savedAt === 'string'
    && Array.isArray(d.lines) && d.lines.length > 0 && d.lines.every((l: any) => l && typeof l === 'object');
}

/**
 * Looks at this owner's draft and the legacy draft WITHOUT changing anything (safe to call during render).
 * Ownership is checked twice: by the key and by the store/user recorded inside the draft.
 */
export function inspectDraft(owner: DraftOwner | null, now: Date = new Date(), kv: DraftStorage | null = defaultStorage()):
  { own: DraftInspection; legacyPresent: boolean } {
  let legacyPresent = false;
  try { legacyPresent = !!kv?.getItem(LEGACY_DRAFT_KEY); } catch { /* storage unavailable */ }
  if (!owner || !kv) return { own: { status: 'none' }, legacyPresent };
  let raw: string | null = null;
  try { raw = kv.getItem(draftKey(owner)); } catch { return { own: { status: 'none' }, legacyPresent }; }
  if (!raw) return { own: { status: 'none' }, legacyPresent };
  let d: any;
  try { d = JSON.parse(raw); } catch { return { own: { status: 'invalid', reason: 'it could not be read' }, legacyPresent }; }
  if (!isDraftShape(d)) return { own: { status: 'invalid', reason: 'it is incomplete' }, legacyPresent };
  if (d.storeId !== owner.storeId || d.userId !== owner.userId) return { own: { status: 'invalid', reason: 'it belongs to a different user or store' }, legacyPresent };
  const saved = Date.parse(d.savedAt);
  if (!Number.isFinite(saved)) return { own: { status: 'invalid', reason: 'its save time is unreadable' }, legacyPresent };
  if (now.getTime() - saved > DRAFT_MAX_AGE_HOURS * 3600_000) return { own: { status: 'expired', draft: d }, legacyPresent };
  return { own: { status: 'ok', draft: d }, legacyPresent };
}

/** Removes what inspectDraft() found unusable: an expired or invalid own draft, and any legacy draft. Idempotent. */
export function removeUnusableDrafts(owner: DraftOwner | null, found: { own: DraftInspection; legacyPresent: boolean }, kv: DraftStorage | null = defaultStorage()): void {
  try {
    if (found.legacyPresent) kv?.removeItem(LEGACY_DRAFT_KEY);
    if (owner && (found.own.status === 'expired' || found.own.status === 'invalid')) kv?.removeItem(draftKey(owner));
  } catch { /* storage unavailable */ }
}

export type RestoreResult =
  | { ok: true; cart: CartItem[]; customer: Customer | null; discountPercent: number; notices: string[] }
  | { ok: false; error: string };

const validPercent = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;

/**
 * Rebuilds the cart from a draft using the CURRENT catalogue and customers (current price, tax and stock).
 * Missing, archived, expired and out-of-stock products are left out, quantities above the sellable stock are
 * reduced, duplicate lines are merged - each with a notice. Nothing is sent to the server.
 */
export function restoreDraftCart(draft: DraftCart, ctx: {
  products: Product[];
  customers: Customer[];
  sellableOf: (p: Product) => number;
  expiredOnly: (p: Product) => boolean;
}): RestoreResult {
  const notices: string[] = [];
  // merge duplicate lines (same product) in first-seen order
  const merged = new Map<number, DraftLine>();
  for (const l of draft.lines) {
    const name = typeof l.productName === 'string' && l.productName ? l.productName : `product #${l.productId}`;
    if (!Number.isInteger(l.productId) || l.productId <= 0) { notices.push(`A line with an unknown product was left out.`); continue; }
    if (!Number.isInteger(l.quantity) || l.quantity <= 0 || l.quantity > MAX_QUANTITY) { notices.push(`"${name}" was left out (invalid quantity).`); continue; }
    const prev = merged.get(l.productId);
    if (prev) { prev.quantity += l.quantity; notices.push(`"${name}" appeared twice; the quantities were combined.`); }
    else merged.set(l.productId, { ...l, productName: name });
  }
  const cart: CartItem[] = [];
  for (const l of merged.values()) {
    const p = ctx.products.find((x) => x.id === l.productId);
    if (!p) { notices.push(`"${l.productName}" is no longer in the medicine list (removed or archived) and was left out.`); continue; }
    if (ctx.expiredOnly(p)) { notices.push(`"${p.name}" was left out: all remaining stock has expired.`); continue; }
    const sellable = ctx.sellableOf(p);
    if (!(sellable > 0)) { notices.push(`"${p.name}" is out of stock and was left out.`); continue; }
    let qty = l.quantity;
    if (qty > sellable) { notices.push(`"${p.name}": only ${sellable}${p.unit ? ` ${p.unit}` : ''} in stock now; quantity reduced from ${qty} to ${sellable}.`); qty = sellable; }
    let disc = l.discountPercent;
    if (!validPercent(disc)) { notices.push(`"${p.name}": the saved line discount was invalid and was set to 0%.`); disc = 0; }
    const price = Number(p.sale_price) || 0;
    const gst = Number(p.gst_rate) || 0;
    cart.push({
      product: p,
      quantity: qty,
      unit_price: price,
      discount_percent: disc,
      discount_amount: 0,
      gst_percent: gst,
      gst_amount: 0,
      subtotal: priceLine({ quantity: qty, unitPrice: price, discountPercent: disc, gstPercent: gst }).subtotal,
    });
  }
  if (!cart.length) {
    return { ok: false, error: `The saved cart could not be restored: none of its items can be sold now. ${notices.join(' ')}`.trim() };
  }
  let customer: Customer | null = null;
  if (draft.customerId != null) {
    customer = ctx.customers.find((c) => c.id === draft.customerId) ?? null;
    if (!customer) notices.push(`The customer saved with this cart (${draft.customerName || `#${draft.customerId}`}) was not found, so the cart was restored as a walk-in sale. Select the customer again before payment if needed.`);
  }
  let discountPercent = draft.discountPercent;
  if (!validPercent(discountPercent)) { notices.push('The saved bill discount was invalid and was set to 0%.'); discountPercent = 0; }
  return { ok: true, cart, customer, discountPercent, notices };
}
