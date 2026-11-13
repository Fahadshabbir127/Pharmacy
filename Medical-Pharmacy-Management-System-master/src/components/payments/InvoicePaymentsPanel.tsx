/**
 * Sales Register (Phase 7, Batch 2c): current balance and settlement status of an invoice, its payment history,
 * "Record payment" while money is owed, and ADMIN-only reversal with a mandatory reason.
 */
import React, { useState } from 'react';
import { api, PaymentRecord } from '../../lib/api';
import { InvoicePaymentModal, PaymentHistoryList, ReversePaymentModal } from './PaymentWidgets';

export const InvoicePaymentsPanel: React.FC<{ sale: { id: number; invoice_number: string; balance_due?: number | null; settlement_status?: string | null; customer_name?: string | null; grand_total: number }; isAdmin: boolean; onChanged: () => void }> = ({ sale, isAdmin, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PaymentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [reversing, setReversing] = useState<PaymentRecord | null>(null);
  const due = Number(sale.balance_due ?? 0);
  const status = sale.settlement_status || (due > 0.004 ? 'UNPAID' : 'PAID');
  const load = async () => {
    setError(null);
    try {
      const d: any = await api.getSaleDetail(sale.id);
      // reversal state of each payment comes from the customer/payment history (reversed_by)
      const list: PaymentRecord[] = (d.payments || []).map((p: any) => ({ ...p, reversed_by: (d.payments || []).find((x: any) => x.reverses_payment_id === p.id) || null }));
      setRows(list);
    } catch (e: any) { setError(e.message); }
  };
  const toggle = async () => { const next = !open; setOpen(next); if (next) await load(); };
  const changed = async () => { await load(); onChanged(); };
  return (
    <div className="px-3 sm:px-4 pb-3" data-testid={`invoice-payments-${sale.invoice_number}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`px-2 py-0.5 rounded font-bold ${status === 'PAID' ? 'bg-emerald-100 text-emerald-800' : status === 'PARTIAL' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}`} data-testid="settlement-status">Now: {status}</span>
        <span className="text-slate-600">Balance due: <strong className={due > 0.004 ? 'text-rose-700' : 'text-emerald-700'} data-testid="balance-due">Rs. {due.toFixed(2)}</strong></span>
        <button type="button" onClick={() => void toggle()} className="ml-auto px-2.5 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 font-semibold">{open ? 'Hide payments' : 'Payments'}</button>
        {due > 0.004 && (
          <button type="button" onClick={() => setPaying(true)} className="px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-bold">Record payment</button>
        )}
      </div>
      {open && (
        <div className="mt-2 rounded-xl border border-slate-700 bg-slate-900 overflow-x-auto">
          {error ? <div className="p-3 text-rose-300 text-xs">{error}</div> : rows === null ? <div className="p-3 text-slate-400 text-xs">Loading...</div> : (
            <PaymentHistoryList payments={rows} canReverse={isAdmin} onReverse={setReversing} showAllocations={false} />
          )}
        </div>
      )}
      {paying && <InvoicePaymentModal sale={{ id: sale.id, invoice_number: sale.invoice_number, balance_due: due, customer_name: sale.customer_name }} onClose={(c) => { setPaying(false); if (c) { setOpen(true); void changed(); } }} />}
      {reversing && <ReversePaymentModal payment={reversing} onClose={(c) => { setReversing(null); if (c) void changed(); }} />}
    </div>
  );
};
