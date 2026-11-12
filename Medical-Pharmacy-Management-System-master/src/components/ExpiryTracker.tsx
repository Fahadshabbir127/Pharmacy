/**
 * Phase 6: expiry tracker - batches with stock that have expired, expire within N days, or have no expiry.
 */
import React, { useEffect, useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

type Report = Awaited<ReturnType<typeof api.getExpiryReport>>;

const Section: React.FC<{ title: string; tone: string; rows: Report['expired']; testId: string }> = ({ title, tone, rows, testId }) => (
  <div className="space-y-1">
    <h4 className={`text-xs font-bold ${tone}`}>{title} ({rows.length})</h4>
    {rows.length === 0 ? <div className="text-[11px] text-slate-500">None.</div> : (
      <table className="w-full text-xs" data-testid={testId}>
        <thead className="text-[10px] uppercase text-slate-500"><tr><th className="text-left py-1">Medicine</th><th className="text-left">Batch</th><th className="text-left">Expiry</th><th className="text-right">Qty</th><th className="text-right">Cost value</th><th className="text-left pl-2">Supplier</th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id} className="border-t border-slate-800">
              <td className="py-1 text-white">{b.product_name}</td>
              <td className="font-mono">{b.batch_number || '-'}</td>
              <td>{b.expiry_date || '-'}</td>
              <td className="text-right font-bold">{b.qty_on_hand} {b.unit}</td>
              <td className="text-right">Rs. {(b.qty_on_hand * (b.purchase_price || 0)).toFixed(2)}</td>
              <td className="pl-2 text-slate-400">{(b as any).supplier_name || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

export const ExpiryTracker: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [days, setDays] = useState(90);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try { setReport(await api.getExpiryReport(days)); } catch (e: any) { setError(e.message || 'Could not load the expiry report'); }
  };
  useEffect(() => { void load(); }, [days]);

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-labelledby="expiry-tracker-title">
      <div className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-4xl w-full p-5 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 id="expiry-tracker-title" className="font-bold text-base text-white">Expiry tracker</h3>
          <button type="button" onClick={onClose} aria-label="Close expiry tracker" className="p-1 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400">Expiring within</span>
          {[30, 60, 90, 180].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} className={`px-2 py-1 rounded-lg border ${days === d ? 'bg-amber-900 border-amber-700 text-amber-100 font-bold' : 'border-slate-700 text-slate-300'}`}>{d} days</button>
          ))}
          <button type="button" onClick={() => void load()} className="p-1 text-slate-400 hover:text-white" title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
          {report && <span className="ml-auto text-slate-500">Pharmacy date: {report.today}</span>}
        </div>
        {error && <div className="text-xs bg-rose-950 border border-rose-800 text-rose-200 p-2 rounded">{error}</div>}
        {report && (
          <>
            <div className="text-xs bg-rose-950/60 border border-rose-900 rounded-lg p-2">
              Expired stock still on the shelf: <strong>{report.totals.expiredUnits}</strong> unit(s), cost value <strong>Rs. {report.totals.expiredValue.toFixed(2)}</strong>. It cannot be sold; write it off with Stock Adjustment → Deduct → reason "Expired".
            </div>
            <Section title="Expired (cannot be sold)" tone="text-rose-400" rows={report.expired} testId="expiry-expired" />
            <Section title={`Expiring within ${report.days} days`} tone="text-amber-400" rows={report.expiring} testId="expiry-expiring" />
            <Section title="No expiry date recorded (sold last)" tone="text-slate-300" rows={report.noExpiry} testId="expiry-none" />
          </>
        )}
      </div>
    </div>
  );
};
