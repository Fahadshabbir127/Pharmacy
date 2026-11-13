/**
 * Payment history, reversal (ADMIN, reason required) and invoice payment windows (Phase 7, Batch 2c).
 * Historical payments are never edited or deleted: a reversal is a new record; the original stays visible.
 */
import React, { useState } from 'react';
import { X, RefreshCw, CheckCircle, AlertTriangle, Undo2 } from 'lucide-react';
import { api, PAYMENT_METHOD_OPTIONS, methodLabel, PaymentRecord, InvoicePaymentResult } from '../../lib/api';
import { usePaymentAttempt } from '../../lib/usePaymentAttempt';

const KIND: Record<string, string> = {
  SALE_TENDER: 'Paid at sale', CUSTOMER_PAYMENT: 'Customer payment', INVOICE_PAYMENT: 'Invoice payment',
  CARRIED_OVER_SALE: 'Paid at sale (carried over)', CARRIED_OVER_CUSTOMER: 'Customer payment (carried over)', REVERSAL: 'Reversal',
};
const target = (a: { target: string; invoice_number: string | null; carried_over_id: number | null }) =>
  a.target === 'SALE' ? `Invoice ${a.invoice_number}` : a.target === 'OPENING_BALANCE' ? 'Opening balance' : `Carried-over #${a.carried_over_id}`;

const Unconfirmed: React.FC<{ error: string | null }> = ({ error }) => (
  <div role="alert" data-testid="payment-unconfirmed" className="p-2.5 rounded-xl bg-amber-950/70 border border-amber-700 text-amber-200 flex items-start gap-2 text-xs">
    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
    <span>NOT CONFIRMED: the connection was lost; the server may or may not have saved this ({error}). "Retry" is safe: it cannot be recorded twice.</span>
  </div>
);

export const PaymentHistoryList: React.FC<{ payments: PaymentRecord[]; canReverse: boolean; onReverse: (p: PaymentRecord) => void; showAllocations?: boolean }> = ({ payments, canReverse, onReverse, showAllocations = true }) => {
  if (!payments.length) return <div className="py-8 text-center text-slate-500 text-xs">No payments recorded.</div>;
  return (
    <table className="w-full text-left text-xs text-slate-300" data-testid="payment-history">
      <thead className="bg-slate-800 text-slate-400 uppercase font-mono text-[10px]">
        <tr><th className="py-2 px-2">Date</th><th className="py-2 px-2">Type</th><th className="py-2 px-2">Method</th><th className="py-2 px-2 text-right">Amount</th><th className="py-2 px-2">Details</th><th className="py-2 px-2 text-right"> </th></tr>
      </thead>
      <tbody className="divide-y divide-slate-800/60">
        {payments.map((p) => {
          const reversed = !!p.reversed_by;
          return (
            <tr key={p.id} data-testid="payment-row" className={reversed ? 'opacity-60' : ''}>
              <td className="py-2 px-2 whitespace-nowrap">{String(p.received_at).slice(0, 16)}</td>
              <td className="py-2 px-2">{KIND[p.kind] || p.kind}{p.direction === 'OUT' && <span className="ml-1 text-rose-300">(money out)</span>}</td>
              <td className="py-2 px-2">{methodLabel(p.method, p.method_detail)}{p.reference ? <div className="text-[10px] text-slate-500">Ref {p.reference}</div> : null}</td>
              <td className={`py-2 px-2 text-right font-bold ${p.direction === 'OUT' ? 'text-rose-300' : 'text-emerald-300'}`}>{p.direction === 'OUT' ? '-' : ''}Rs. {Number(p.amount).toFixed(2)}
                {p.change_given ? <div className="text-[10px] font-normal text-slate-400">cash Rs. {Number(p.cash_tendered).toFixed(2)}, change Rs. {Number(p.change_given).toFixed(2)}</div> : null}
              </td>
              <td className="py-2 px-2 text-[11px]">
                {p.applied_to_this_invoice !== undefined && <div>Applied to this invoice: Rs. {Number(p.applied_to_this_invoice).toFixed(2)}</div>}
                {showAllocations && (p.allocations || []).map((a) => (
                  <div key={a.id} className={a.kind === 'RELEASE' ? 'text-rose-300' : ''}>{a.kind === 'RELEASE' ? 'Released' : 'Settled'} {target(a)}: Rs. {Number(a.amount).toFixed(2)}{a.source === 'ADVANCE' ? ' (advance)' : ''}</div>
                ))}
                {p.reason && <div className="text-rose-300">Reason: {p.reason}</div>}
                {reversed && <div className="text-rose-300 font-semibold" data-testid="reversed-badge">REVERSED: {p.reversed_by!.reason}</div>}
              </td>
              <td className="py-2 px-2 text-right">
                {canReverse && p.direction === 'IN' && !reversed && (
                  <button type="button" onClick={() => onReverse(p)} className="px-2 py-1 rounded bg-rose-950/70 text-rose-200 border border-rose-800 text-[11px] font-semibold flex items-center gap-1 ml-auto" title="Reverse this payment (administrator)">
                    <Undo2 className="w-3 h-3" /> Reverse
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

export const ReversePaymentModal: React.FC<{ payment: PaymentRecord; onClose: (changed: boolean) => void }> = ({ payment, onClose }) => {
  const attempt = usePaymentAttempt<Awaited<ReturnType<typeof api.reversePayment>>>();
  const [reason, setReason] = useState('');
  const r = attempt.result;
  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4" role="dialog" aria-labelledby="rev-title">
      <div className="bg-slate-900 border border-rose-900 text-slate-100 rounded-2xl max-w-md w-full p-6 space-y-3 shadow-2xl text-xs" data-testid="reverse-modal">
        <div className="flex items-center justify-between">
          <h3 id="rev-title" className="font-bold text-base text-white">Reverse payment #{payment.id}</h3>
          <button type="button" aria-label="Close reversal" onClick={() => onClose(attempt.state === 'done')} disabled={attempt.busy} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="bg-slate-800/70 border border-slate-700 rounded-xl p-3">Rs. {Number(payment.amount).toFixed(2)} by {methodLabel(payment.method, payment.method_detail)} on {String(payment.received_at).slice(0, 16)}{payment.invoice_number ? `, invoice ${payment.invoice_number}` : ''}.</div>
        {r ? (
          <>
            <div className="text-emerald-300 font-bold flex items-center gap-2" data-testid="reverse-result"><CheckCircle className="w-4 h-4" /> Payment reversed{r.replayed ? ' (already reversed by this request)' : ''}.</div>
            <div>The original record is kept; a reversal record was added. {r.new_balance !== null && r.new_balance !== undefined ? `Customer balance now Rs. ${Number(r.new_balance).toFixed(2)}.` : ''}</div>
            <button type="button" onClick={() => onClose(true)} className="w-full bg-slate-700 text-white font-bold py-2 rounded-xl">Done</button>
          </>
        ) : (
          <>
            <p className="text-slate-300">The payment is not deleted or edited. A reversal record is added, the invoices it paid become owed again, and the customer's balance goes back up. This cannot be undone.</p>
            <label className="block font-semibold text-slate-300">Reason (required)
              <input type="text" aria-label="Reversal reason" maxLength={300} value={reason} disabled={attempt.busy || attempt.state === 'unknown'} onChange={(e) => setReason(e.target.value)} className="mt-1 w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700" />
            </label>
            {attempt.state === 'unknown' && <Unconfirmed error={attempt.error} />}
            {attempt.state === 'failed' && <div role="alert" className="p-2.5 rounded-xl bg-rose-950/70 border border-rose-800 text-rose-200">Not reversed: {attempt.error}</div>}
            <button type="button" data-testid="confirm-reverse" disabled={!reason.trim() || attempt.busy} onClick={() => void attempt.submit((txn) => api.reversePayment(payment.id, reason.trim(), txn))}
              className="w-full bg-rose-700 hover:bg-rose-600 text-white font-bold py-2.5 rounded-xl disabled:opacity-50">{attempt.busy ? 'Reversing...' : attempt.state === 'unknown' ? 'Retry (same reversal)' : 'Reverse payment'}</button>
          </>
        )}
      </div>
    </div>
  );
};

export const InvoicePaymentModal: React.FC<{ sale: { id: number; invoice_number: string; balance_due: number; customer_name?: string | null }; onClose: (changed: boolean) => void }> = ({ sale, onClose }) => {
  const attempt = usePaymentAttempt<InvoicePaymentResult>();
  const [amount, setAmount] = useState<string>(String(sale.balance_due));
  const [method, setMethod] = useState('CASH');
  const [wallet, setWallet] = useState('EasyPaisa');
  const [reference, setReference] = useState('');
  const amt = Number(amount);
  const valid = Number.isFinite(amt) && amt > 0 && Math.abs(amt * 100 - Math.round(amt * 100)) < 1e-6;
  const tooMuch = valid && amt > sale.balance_due + 0.004;
  const r = attempt.result;
  const locked = attempt.busy || attempt.state === 'unknown';
  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4" role="dialog" aria-labelledby="inv-pay-title">
      <div className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-md w-full p-6 space-y-3 shadow-2xl text-xs" data-testid="invoice-payment-modal">
        <div className="flex items-center justify-between">
          <h3 id="inv-pay-title" className="font-bold text-base text-white">Record payment: {sale.invoice_number}</h3>
          <button type="button" aria-label="Close invoice payment" onClick={() => onClose(attempt.state === 'done')} disabled={attempt.busy} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex justify-between bg-slate-800/60 border border-slate-700 rounded-xl p-2.5"><span>{sale.customer_name || 'Walk-in customer'}: still owed on this invoice</span><strong className="text-rose-300">Rs. {Number(sale.balance_due).toFixed(2)}</strong></div>
        {r ? (
          <>
            <div className="text-emerald-300 font-bold flex items-center gap-2" data-testid="payment-result"><CheckCircle className="w-4 h-4" /> Payment recorded{r.replayed ? ' (already saved earlier - not recorded twice)' : ''}.</div>
            <div className="bg-slate-800/70 border border-slate-700 rounded-xl p-3 space-y-1">
              <div className="flex justify-between"><span>Amount</span><strong>Rs. {r.amount.toFixed(2)} ({methodLabel(r.method)})</strong></div>
              <div className="flex justify-between"><span>Invoice balance now</span><strong data-testid="invoice-balance-after">Rs. {Number(r.balance_due).toFixed(2)} ({r.settlement_status})</strong></div>
              {r.new_balance !== null && <div className="flex justify-between"><span>Customer balance now</span><strong>Rs. {Number(r.new_balance).toFixed(2)}</strong></div>}
            </div>
            <button type="button" onClick={() => onClose(true)} className="w-full bg-emerald-600 text-white font-bold py-2 rounded-xl">Done</button>
          </>
        ) : (
          <>
            <label className="block font-semibold text-slate-300">Amount (Rs.)
              <input type="number" min="0.01" step="0.01" aria-label="Invoice payment amount" value={amount} disabled={locked} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full bg-slate-800 text-white font-bold p-2.5 rounded-xl border border-slate-700" />
            </label>
            {tooMuch && <div className="text-rose-300">More than this invoice owes (Rs. {Number(sale.balance_due).toFixed(2)}).</div>}
            <div className="grid grid-cols-2 gap-2">
              <label className="block font-semibold text-slate-300">Method
                <select aria-label="Invoice payment method" value={method} disabled={locked} onChange={(e) => setMethod(e.target.value)} className="mt-1 w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700">
                  {PAYMENT_METHOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              {method === 'MOBILE_WALLET' ? (
                <label className="block font-semibold text-slate-300">Wallet
                  <select aria-label="Invoice payment wallet" value={wallet} disabled={locked} onChange={(e) => setWallet(e.target.value)} className="mt-1 w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700"><option>EasyPaisa</option><option>JazzCash</option></select>
                </label>
              ) : <div />}
            </div>
            <label className="block font-semibold text-slate-300">Reference (optional)
              <input type="text" maxLength={100} aria-label="Invoice payment reference" value={reference} disabled={locked} onChange={(e) => setReference(e.target.value)} className="mt-1 w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700" />
            </label>
            {attempt.state === 'unknown' && <Unconfirmed error={attempt.error} />}
            {attempt.state === 'failed' && <div role="alert" data-testid="payment-error" className="p-2.5 rounded-xl bg-rose-950/70 border border-rose-800 text-rose-200">Payment not saved: {attempt.error}</div>}
            <button type="button" data-testid="record-invoice-payment" disabled={!valid || tooMuch || attempt.busy}
              onClick={() => void attempt.submit((txn) => api.recordInvoicePayment(sale.id, { amount: amt, method, method_detail: method === 'MOBILE_WALLET' ? wallet : undefined, reference: reference.trim() || undefined }, txn))}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl flex items-center justify-center gap-2 disabled:opacity-50">
              {attempt.busy ? <><RefreshCw className="w-4 h-4 animate-spin" /> Saving...</> : attempt.state === 'unknown' ? 'Retry (same payment)' : 'Record Payment'}
            </button>
            <div className="text-[10px] text-slate-500 font-mono">Transaction {attempt.txnId}</div>
          </>
        )}
      </div>
    </div>
  );
};
