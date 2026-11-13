/**
 * Record a customer payment (Phase 7, Batch 2c). The host decides everything: the preview and the final
 * allocation (opening balance -> confirmed carried-over balances -> oldest invoices -> advance) come from the
 * server. One transaction id per payment attempt; a retry after a lost connection re-sends the same id.
 */
import React, { useEffect, useState } from 'react';
import { X, RefreshCw, CheckCircle, AlertTriangle } from 'lucide-react';
import { api, PAYMENT_METHOD_OPTIONS, methodLabel, CustomerPaymentResult } from '../../lib/api';
import { usePaymentAttempt } from '../../lib/usePaymentAttempt';

const targetLabel = (a: { target: string; invoice_number: string | null; carried_over_id: number | null }) =>
  a.target === 'SALE' ? `Invoice ${a.invoice_number}` : a.target === 'OPENING_BALANCE' ? 'Opening balance' : `Carried-over balance #${a.carried_over_id}`;

export const CustomerPaymentModal: React.FC<{ customer: { id: number; name: string; current_balance: number }; onClose: (changed: boolean) => void }> = ({ customer, onClose }) => {
  const attempt = usePaymentAttempt<CustomerPaymentResult>();
  const [amount, setAmount] = useState<string>(customer.current_balance > 0 ? String(customer.current_balance) : '');
  const [method, setMethod] = useState<string>('CASH');
  const [wallet, setWallet] = useState<string>('EasyPaisa');
  const [reference, setReference] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewCustomerPayment>> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const amt = Number(amount);
  const amountValid = Number.isFinite(amt) && amt > 0 && Math.abs(amt * 100 - Math.round(amt * 100)) < 1e-6;
  const locked = attempt.state === 'done' || attempt.state === 'submitting' || attempt.state === 'unknown';

  useEffect(() => {
    if (!amountValid || locked) { setPreview(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const p = await api.previewCustomerPayment(customer.id, amt);
        if (live) { setPreview(p); setPreviewError(null); }
      } catch (e: any) { if (live) setPreviewError(e?.message || 'Preview not available'); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [amount, customer.id, locked]);

  const send = () => attempt.submit((txn) => api.recordCustomerPaymentV2(customer.id, {
    amount: amt, method, method_detail: method === 'MOBILE_WALLET' ? wallet : undefined, reference: reference.trim() || undefined, notes: notes.trim() || undefined,
  }, txn));

  const r = attempt.result;
  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-labelledby="cust-pay-title">
      <div className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl max-h-[92vh] overflow-y-auto" data-testid="customer-payment-modal">
        <div className="flex items-center justify-between">
          <h3 id="cust-pay-title" className="font-bold text-base text-white">Receive Payment: <span className="text-emerald-400">{customer.name}</span></h3>
          <button type="button" aria-label="Close payment" onClick={() => onClose(attempt.state === 'done')} disabled={attempt.busy} className="text-slate-400 hover:text-white disabled:opacity-40"><X className="w-5 h-5" /></button>
        </div>

        {r ? (
          <div className="space-y-3 text-xs" data-testid="payment-result">
            <div className="flex items-center gap-2 text-emerald-300 font-bold text-sm"><CheckCircle className="w-5 h-5" /> Payment recorded{r.replayed ? ' (already saved earlier - not recorded twice)' : ''}</div>
            <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-3 space-y-1">
              <div className="flex justify-between"><span>Amount</span><strong>Rs. {r.amount.toFixed(2)} ({methodLabel(r.method, r.method_detail)})</strong></div>
              {r.allocations.map((a, i) => <div key={i} className="flex justify-between text-slate-300"><span>Settled: {targetLabel(a)}</span><span>Rs. {a.amount.toFixed(2)}</span></div>)}
              {r.advance_remaining > 0.004 && <div className="flex justify-between text-sky-300"><span>Kept as advance</span><span>Rs. {r.advance_remaining.toFixed(2)}</span></div>}
              <div className="flex justify-between border-t border-slate-700 pt-1 font-bold"><span>New balance</span><span data-testid="payment-new-balance">Rs. {Number(r.newBalance).toFixed(2)}</span></div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => onClose(true)} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-xl">Done</button>
              <button type="button" onClick={() => { attempt.startNew(); setAmount(''); setReference(''); setNotes(''); setPreview(null); }} className="px-3 py-2 rounded-xl bg-slate-800 text-slate-200 border border-slate-700">Record another payment</button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="flex justify-between bg-slate-800/60 border border-slate-700 rounded-xl p-2.5">
              <span>Current balance</span>
              <strong className={customer.current_balance > 0 ? 'text-rose-400' : 'text-emerald-400'}>Rs. {Number(customer.current_balance).toFixed(2)}</strong>
            </div>
            <label className="block text-slate-300 font-semibold">Amount (Rs.)
              <input type="number" min="0.01" step="0.01" aria-label="Payment amount" disabled={locked} value={amount} onChange={(e) => setAmount(e.target.value)}
                className="mt-1 w-full bg-slate-800 text-white font-bold text-base p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500" />
            </label>
            {!amountValid && amount !== '' && <div className="text-rose-300">Enter an amount greater than 0 with at most 2 decimals.</div>}
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-slate-300 font-semibold">Method
                <select aria-label="Payment method" disabled={locked} value={method} onChange={(e) => setMethod(e.target.value)} className="mt-1 w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700">
                  {PAYMENT_METHOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              {method === 'MOBILE_WALLET' ? (
                <label className="block text-slate-300 font-semibold">Wallet
                  <select aria-label="Wallet" disabled={locked} value={wallet} onChange={(e) => setWallet(e.target.value)} className="mt-1 w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700">
                    <option>EasyPaisa</option><option>JazzCash</option>
                  </select>
                </label>
              ) : <div />}
            </div>
            <label className="block text-slate-300 font-semibold">Reference (optional: receipt, transaction or cheque no.)
              <input type="text" maxLength={100} aria-label="Payment reference" disabled={locked} value={reference} onChange={(e) => setReference(e.target.value)} className="mt-1 w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700" />
            </label>
            <label className="block text-slate-300 font-semibold">Notes (optional)
              <input type="text" maxLength={500} disabled={locked} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700" />
            </label>

            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-1" data-testid="payment-preview">
              <div className="text-[10px] uppercase tracking-wide text-slate-400">What this payment will settle (calculated by the pharmacy server)</div>
              {previewError && <div className="text-rose-300">{previewError}</div>}
              {!preview && !previewError && <div className="text-slate-500">Enter an amount to see the preview.</div>}
              {preview && (
                <>
                  {preview.allocations.length === 0 && <div className="text-slate-400">Nothing is owed right now.</div>}
                  {preview.allocations.map((a, i) => <div key={i} className="flex justify-between"><span>{targetLabel(a)} (owes Rs. {a.due.toFixed(2)})</span><span>Rs. {a.amount.toFixed(2)}</span></div>)}
                  {preview.advance_after > 0.004 && <div className="flex justify-between text-sky-300"><span>Kept as customer advance</span><span>Rs. {preview.advance_after.toFixed(2)}</span></div>}
                  <div className="flex justify-between border-t border-slate-700 pt-1 font-bold"><span>Balance after payment</span><span>Rs. {preview.balance_after.toFixed(2)}</span></div>
                  {preview.advance > 0.004 && <div className="text-sky-300">This customer already has an advance of Rs. {preview.advance.toFixed(2)}.</div>}
                </>
              )}
            </div>

            {attempt.state === 'unknown' && (
              <div role="alert" data-testid="payment-unconfirmed" className="p-2.5 rounded-xl bg-amber-950/70 border border-amber-700 text-amber-200 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>NOT CONFIRMED: the connection was lost; the server may or may not have saved this payment ({attempt.error}). Press "Retry" - it is safe: the same payment can never be recorded twice.</span>
              </div>
            )}
            {attempt.state === 'failed' && <div role="alert" data-testid="payment-error" className="p-2.5 rounded-xl bg-rose-950/70 border border-rose-800 text-rose-200">Payment not saved: {attempt.error}</div>}

            <button type="button" data-testid="record-payment" disabled={!amountValid || attempt.busy} onClick={() => void send()}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
              {attempt.busy ? <><RefreshCw className="w-4 h-4 animate-spin" /> Saving...</> : attempt.state === 'unknown' ? 'Retry (same payment)' : 'Record Payment'}
            </button>
            <div className="text-[10px] text-slate-500 font-mono">Transaction {attempt.txnId}</div>
          </div>
        )}
      </div>
    </div>
  );
};
