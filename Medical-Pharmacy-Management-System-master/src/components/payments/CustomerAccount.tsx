/**
 * Customers module additions (Phase 7, Batch 2c): Open invoices and Payment history tabs, and the
 * administrator's balance review (Q1: confirm positive unexplained differences as carried-over balances).
 */
import React, { useEffect, useState } from 'react';
import { X, RefreshCw, CheckCircle, ShieldCheck } from 'lucide-react';
import { api, CustomerOutstanding, PaymentRecord, PaymentReconciliationReport } from '../../lib/api';
import { usePaymentAttempt } from '../../lib/usePaymentAttempt';
import { PaymentHistoryList, ReversePaymentModal } from './PaymentWidgets';

const itemLabel = (i: CustomerOutstanding['items'][number]) =>
  i.target === 'SALE' ? `Invoice ${i.invoice_number}` : i.target === 'OPENING_BALANCE' ? 'Opening balance' : `Confirmed carried-over balance #${i.carried_over_id}`;

export const OpenInvoicesTab: React.FC<{ customerId: number; refreshKey: number }> = ({ customerId, refreshKey }) => {
  const [data, setData] = useState<CustomerOutstanding | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    api.getCustomerOutstanding(customerId).then((d) => live && setData(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [customerId, refreshKey]);
  if (error) return <div className="p-4 text-rose-300 text-xs">{error}</div>;
  if (!data) return <div className="py-10 text-center text-slate-400 text-xs">Loading...</div>;
  return (
    <div className="space-y-2 text-xs" data-testid="open-invoices">
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-slate-800/70 border border-slate-700 rounded-xl p-2"><div className="text-slate-400">Owed (items below)</div><div className="font-bold text-rose-300">Rs. {data.owed.toFixed(2)}</div></div>
        <div className="bg-slate-800/70 border border-slate-700 rounded-xl p-2"><div className="text-slate-400">Customer advance</div><div className="font-bold text-sky-300" data-testid="customer-advance">Rs. {data.advance.toFixed(2)}</div></div>
        <div className="bg-slate-800/70 border border-slate-700 rounded-xl p-2"><div className="text-slate-400">Balance</div><div className="font-bold text-white">Rs. {data.stored_balance.toFixed(2)}</div></div>
      </div>
      {Math.abs(data.difference) > 0.004 && (
        <div className="p-2 rounded-xl bg-amber-950/60 border border-amber-800 text-amber-200">The balance differs from the records by Rs. {data.difference.toFixed(2)} (from before payment tracking). An administrator can review it in "Balance review".</div>
      )}
      {data.items.length === 0 ? <div className="py-6 text-center text-slate-500">Nothing is owed.</div> : (
        <table className="w-full text-left text-slate-300">
          <thead className="bg-slate-800 text-slate-400 uppercase font-mono text-[10px]"><tr><th className="py-2 px-2">Paid in this order</th><th className="py-2 px-2">Date</th><th className="py-2 px-2 text-right">Total</th><th className="py-2 px-2 text-right">Still owed</th></tr></thead>
          <tbody className="divide-y divide-slate-800/60">
            {data.items.map((i, n) => (
              <tr key={n} data-testid="open-item"><td className="py-2 px-2">{n + 1}. {itemLabel(i)}</td><td className="py-2 px-2">{String(i.date).slice(0, 10)}</td><td className="py-2 px-2 text-right">Rs. {Number(i.total).toFixed(2)}</td><td className="py-2 px-2 text-right font-bold text-rose-300">Rs. {i.due.toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export const PaymentHistoryTab: React.FC<{ customerId: number; canReverse: boolean; refreshKey: number; onChanged: () => void }> = ({ customerId, canReverse, refreshKey, onChanged }) => {
  const [rows, setRows] = useState<PaymentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reversing, setReversing] = useState<PaymentRecord | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setRows(null);
    api.getCustomerPayments(customerId).then((d) => live && setRows(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [customerId, refreshKey, tick]);
  if (error) return <div className="p-4 text-rose-300 text-xs">{error}</div>;
  if (!rows) return <div className="py-10 text-center text-slate-400 text-xs">Loading...</div>;
  return (
    <>
      <PaymentHistoryList payments={rows} canReverse={canReverse} onReverse={setReversing} />
      {reversing && <ReversePaymentModal payment={reversing} onClose={(changed) => { setReversing(null); if (changed) { setTick((t) => t + 1); onChanged(); } }} />}
    </>
  );
};

const ConfirmRow: React.FC<{ m: PaymentReconciliationReport['mismatches'][number]; onDone: () => void }> = ({ m, onDone }) => {
  const attempt = usePaymentAttempt<Awaited<ReturnType<typeof api.confirmCarriedOverBalance>>>();
  const [reason, setReason] = useState('');
  if (attempt.result) return <div className="text-emerald-300 flex items-center gap-1" data-testid="confirm-result"><CheckCircle className="w-4 h-4" /> Confirmed as carried-over balance{attempt.result.advance_applied?.length ? `; advance applied Rs. ${attempt.result.advance_applied.reduce((s: number, a: any) => s + a.amount, 0).toFixed(2)}` : ''}. <button type="button" className="underline ml-1" onClick={onDone}>Refresh</button></div>;
  return (
    <div className="flex flex-col gap-1">
      <input type="text" aria-label={`Reason for ${m.name}`} maxLength={300} placeholder="Reason (required), e.g. balance from the paper notebook" value={reason} disabled={attempt.busy} onChange={(e) => setReason(e.target.value)} className="bg-slate-800 text-white p-2 rounded-lg border border-slate-700" />
      {attempt.error && <div className="text-rose-300">{attempt.error}</div>}
      <button type="button" data-testid={`confirm-${m.customer_id}`} disabled={!reason.trim() || attempt.busy}
        onClick={() => void attempt.submit((txn) => api.confirmCarriedOverBalance(m.customer_id, m.difference, reason.trim(), txn))}
        className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold disabled:opacity-50">{attempt.busy ? 'Confirming...' : `Confirm Rs. ${m.difference.toFixed(2)} as carried-over balance`}</button>
    </div>
  );
};

/** ADMIN only: differences between stored balances and what the records explain; confirm positive ones (Q1). */
export const BalanceReviewModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [rep, setRep] = useState<PaymentReconciliationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { setRep(null); api.getPaymentReconciliation().then(setRep).catch((e) => setError(e.message)); }, [tick]);
  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-labelledby="bal-review-title">
      <div className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-4xl w-full p-6 space-y-4 shadow-2xl max-h-[92vh] overflow-y-auto text-xs" data-testid="balance-review">
        <div className="flex items-center justify-between">
          <h3 id="bal-review-title" className="font-bold text-base text-white flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-emerald-400" /> Balance review (administrator)</h3>
          <div className="flex gap-2"><button type="button" onClick={() => setTick((t) => t + 1)} className="p-1 text-slate-400 hover:text-white" title="Refresh"><RefreshCw className="w-4 h-4" /></button>
            <button type="button" aria-label="Close balance review" onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button></div>
        </div>
        <p className="text-slate-400">Customers whose stored balance is not explained by their invoices, opening balance and recorded payments (usually from before payment tracking). Nothing here changes a balance automatically. A <strong>positive</strong> difference may be confirmed as a carried-over balance (reason required, recorded in the audit log); payments then settle it right after the opening balance. <strong>Negative</strong> differences are for manual review only.</p>
        {error && <div className="text-rose-300">{error}</div>}
        {!rep ? <div className="py-8 text-center text-slate-400">Loading...</div> : (
          <>
            {rep.mismatches.length === 0 ? <div className="p-3 rounded-xl bg-emerald-950/50 border border-emerald-800 text-emerald-200">All customer balances agree with the records.</div> : (
              <table className="w-full text-left">
                <thead className="bg-slate-800 text-slate-400 uppercase font-mono text-[10px]"><tr><th className="py-2 px-2">Customer</th><th className="py-2 px-2 text-right">Stored</th><th className="py-2 px-2 text-right">Explained</th><th className="py-2 px-2 text-right">Difference</th><th className="py-2 px-2 w-[40%]">Action</th></tr></thead>
                <tbody className="divide-y divide-slate-800/60">
                  {rep.mismatches.map((m) => (
                    <tr key={m.customer_id} data-testid="mismatch-row">
                      <td className="py-2 px-2 font-semibold text-white">{m.name}</td>
                      <td className="py-2 px-2 text-right">Rs. {m.stored_balance.toFixed(2)}</td>
                      <td className="py-2 px-2 text-right">Rs. {m.explained_balance.toFixed(2)}</td>
                      <td className={`py-2 px-2 text-right font-bold ${m.difference > 0 ? 'text-amber-300' : 'text-rose-300'}`}>Rs. {m.difference.toFixed(2)}</td>
                      <td className="py-2 px-2">{m.confirmable ? <ConfirmRow m={m} onDone={() => setTick((t) => t + 1)} /> : <span className="text-rose-300">Negative difference: manual review only.</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {rep.carried_over_balances.length > 0 && (
              <div><div className="font-bold text-slate-200 mb-1">Confirmed carried-over balances</div>
                {rep.carried_over_balances.map((b: any) => <div key={b.id} className="text-slate-300">#{b.id} {b.customer_name}: Rs. {Number(b.amount).toFixed(2)}, confirmed by {b.confirmed_by_name || `#${b.confirmed_by_user_id}`} on {String(b.confirmed_at).slice(0, 16)}. Reason: {b.reason}</div>)}
              </div>
            )}
            {rep.walk_in_sales_with_due.length > 0 && <div className="text-amber-200">{rep.walk_in_sales_with_due.length} walk-in invoice(s) still show money owed (no customer holds it): {rep.walk_in_sales_with_due.map((s: any) => s.invoice_number).join(', ')}.</div>}
            {rep.migration_issues.length > 0 && (
              <details><summary className="cursor-pointer text-slate-300">Reports from the payment history upgrade ({rep.migration_issues.length})</summary>
                <ul className="mt-1 space-y-1 text-slate-400">{rep.migration_issues.map((i: any) => <li key={i.id}>{i.issue}: {i.detail}</li>)}</ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
};
