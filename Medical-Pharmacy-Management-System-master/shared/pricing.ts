/**
 * Sale pricing (Phase 7, Batch 1) - ONE formula, used by the server (authoritative) and by the POS
 * screen (display only), so the two cannot drift apart.
 *
 * It is the formula the POS has always used (E3: unchanged GST rules), with rounding to 2 decimals:
 *   per line:  gross     = round2(quantity x unit price)
 *              lineDisc  = round2(gross x line discount % / 100)
 *              gst       = round2((gross - lineDisc) x GST % / 100)      (GST after the line discount)
 *              subtotal  = round2(gross - lineDisc + gst)
 *   bill:      total_amount   = sum(gross)
 *              item discounts = sum(lineDisc)
 *              bill discount  = round2((total_amount - item discounts) x bill discount % / 100)
 *                               (the bill discount does NOT reduce GST - as before)
 *              total_gst      = sum(gst)
 *              discount_amount = item discounts + bill discount
 *              net_amount     = total_amount - discount_amount
 *              grand_total    = max(0, round2(net_amount + total_gst))
 */

export const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

export interface PricingLineInput {
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  gstPercent: number;
}

export interface PricedLine {
  quantity: number;
  unit_price: number;
  discount_percent: number;
  gross: number;
  discount_amount: number;
  gst_percent: number;
  gst_amount: number;
  subtotal: number;
}

export interface PricedBill {
  lines: PricedLine[];
  total_amount: number;
  item_discount_amount: number;
  bill_discount_percent: number;
  bill_discount_amount: number;
  discount_amount: number;
  net_amount: number;
  total_gst: number;
  grand_total: number;
}

export function priceLine(l: PricingLineInput): PricedLine {
  const gross = round2(l.quantity * l.unitPrice);
  const discount_amount = round2((gross * l.discountPercent) / 100);
  const gst_amount = round2(((gross - discount_amount) * l.gstPercent) / 100);
  return {
    quantity: l.quantity,
    unit_price: l.unitPrice,
    discount_percent: l.discountPercent,
    gross,
    discount_amount,
    gst_percent: l.gstPercent,
    gst_amount,
    subtotal: round2(gross - discount_amount + gst_amount),
  };
}

export function priceBill(lines: PricingLineInput[], billDiscountPercent: number): PricedBill {
  const priced = lines.map(priceLine);
  const total_amount = round2(priced.reduce((s, l) => s + l.gross, 0));
  const item_discount_amount = round2(priced.reduce((s, l) => s + l.discount_amount, 0));
  const bill_discount_amount = round2(((total_amount - item_discount_amount) * billDiscountPercent) / 100);
  const total_gst = round2(priced.reduce((s, l) => s + l.gst_amount, 0));
  const discount_amount = round2(item_discount_amount + bill_discount_amount);
  const net_amount = round2(total_amount - discount_amount);
  return {
    lines: priced,
    total_amount,
    item_discount_amount,
    bill_discount_percent: billDiscountPercent,
    bill_discount_amount,
    discount_amount,
    net_amount,
    total_gst,
    grand_total: Math.max(0, round2(net_amount + total_gst)),
  };
}

/** Two money amounts are "the same" when they differ by less than half a paisa after rounding. */
export const sameMoney = (a: number, b: number): boolean => Math.abs(round2(a) - round2(b)) < 0.005;

/** A discount percentage is valid when it is a finite number from 0 to 100. */
export const validPercent = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100;
