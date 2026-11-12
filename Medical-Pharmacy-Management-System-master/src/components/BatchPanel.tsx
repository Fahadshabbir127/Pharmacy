/**
 * Phase 6: the batches of one product (status, quantities, prices, supplier), each batch's history,
 * and ADMIN corrections of a batch's number / dates / sale price (audited, a reason is required).
 * Quantities are never edited here: they change only through sales, purchases and stock adjustments.
 */
import React, { useEffect, useState } from 'react';
import { X, History, Edit3, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { Product, ProductBatch } from '../types';

const STATUS_STYLE: Record<string, string> = {
  EXPIRED: 'bg-rose-950 text-rose-300 border-rose-800',
  EXPIRING_SOON: 'bg-amber-950 text-amber-300 border-amber-800',
  NO_EXPIRY: 'bg-slate-800 text-slate-300 border-slate-600',
  OK: 'bg-emerald-950 text-emerald-300 border-emerald-800',
  EMPTY: 'bg-slate-900 text-slate-500 border-slate-700',
};
const STATUS_LABEL: Record<string, string> = { EXPIRED: 'Expired', EXPIRING_SOON: 'Expiring soon', NO_EXPIRY: 'No expiry', OK: 'OK', EMPTY: 'Empty' };
const SOURCE_LABEL: Record<string, string> = { MIGRATION: 'Carried over', OPENING: 'Opening stock', PURCHASE: 'Purchase', ADJUSTMENT: 'Adjustment', VOID_RESTORE: 'Voided sale' };

export const BatchPanel: React.FC<{ product: Product; canCorrect: boolean; onClose: () => void; onChanged?: () => void }> = ({ product, canCorrect, onClose, onChanged }) => {
  const [batches, setBatches] = useState<ProductBatch[]>([]);
  const [today, setToday] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ batch: ProductBatch; events: any[] } | null>(null);
  const [editing, setEditing] = useState<ProductBatch | null>(null);
  const [form, setForm] = useState({ batch_number: '', mfg_date: '', expiry_date: '', sale_price: 0, reason: '' });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.getProductBatches(product.id, showEmpty);
      setBatches(r.batches);
      setToday(r.today);
    } catch (e: any) {
      setError(e.message || 'Could not load batches');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [product.id, showEmpty]);

  const openHistory = async (b: ProductBatch) => {
    try {
      const h = await api.getBatchHistory(b.id);
      setHistory({ batch: h.batch, events: h.events });
    } catch (e: any) {
      setError(e.message);
    }
  };
  const startEdit = (b: ProductBatch) => {
    setEditing(b);
    setForm({ batch_number: b.batch_number || '', mfg_date: b.mfg_date || '', expiry_date: b.expiry_date || '', sale_price: b.sale_price, reason: '' });
  };
  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      await api.correctBatch(editing.id, {
        batch_number: form.batch_number, mfg_date: form.mfg_date || null, expiry_date: form.expiry_date || null, sale_price: Number(form.sale_price), reason: form.reason,
      });
      setEditing(null);
      await load();
      onChanged?.();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const total = batches.reduce((s, b) => s + b.qty_on_hand, 0);
  const sellable = batches.filter((b) => b.sellable).reduce((s, b) => s + b.qty_on_hand, 0);

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-labelledby="batch-panel-title">
      <div className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-4xl w-full p-5 space-y-3 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 id="batch-panel-title" className="font-bold text-base text-white">Batches: <span className="text-emerald-400">{product.name}</span></h3>
          <button type="button" onClick={onClose} aria-label="Close batches" className="p-1 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="text-xs text-slate-400 flex flex-wrap gap-4 items-center">
          <span>Total stock: <strong className="text-white">{total}</strong></span>
          <span>Sellable: <strong className="text-emerald-400" data-testid="batch-panel-sellable">{sellable}</strong></span>
          <span>Expired: <strong className="text-rose-400">{total - sellable}</strong></span>
          <span>Pharmacy date: {today}</span>
          <label className="flex items-center gap-1 ml-auto"><input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} /> show empty batches</label>
          <button type="button" onClick={() => void load()} className="p-1 text-slate-400 hover:text-white" title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
        </div>
        {error && <div className="text-xs bg-rose-950 border border-rose-800 text-rose-200 p-2 rounded">{error}</div>}
        {loading ? <div className="text-xs text-slate-400 p-6 text-center">Loading batches...</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="batch-table">
              <thead className="text-slate-400 uppercase text-[10px] border-b border-slate-800">
                <tr>
                  <th className="py-2 px-2">Sold order</th><th className="py-2 px-2">Batch</th><th className="py-2 px-2">Mfg</th><th className="py-2 px-2">Expiry</th>
                  <th className="py-2 px-2">Status</th><th className="py-2 px-2 text-right">On hand</th><th className="py-2 px-2 text-right">Cost / Sale</th>
                  <th className="py-2 px-2">Supplier</th><th className="py-2 px-2">Source</th><th className="py-2 px-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {batches.length === 0 && <tr><td colSpan={10} className="py-6 text-center text-slate-500">No batches with stock.</td></tr>}
                {batches.map((b, i) => (
                  <tr key={b.id} data-testid="batch-row">
                    <td className="py-2 px-2 text-slate-500">{b.sellable ? i + 1 : '-'}</td>
                    <td className="py-2 px-2 font-mono text-white">{b.batch_number || '-'}</td>
                    <td className="py-2 px-2">{b.mfg_date || '-'}</td>
                    <td className="py-2 px-2">{b.expiry_date || (b.expiry_raw ? <span title="Original text could not be read">{b.expiry_raw} (?)</span> : '-')}</td>
                    <td className="py-2 px-2"><span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${STATUS_STYLE[b.status]}`}>{STATUS_LABEL[b.status]}</span></td>
                    <td className="py-2 px-2 text-right font-bold text-white">{b.qty_on_hand}</td>
                    <td className="py-2 px-2 text-right">Rs. {b.purchase_price} / Rs. {b.sale_price}</td>
                    <td className="py-2 px-2">{b.supplier_name || '-'}</td>
                    <td className="py-2 px-2 text-slate-400">{SOURCE_LABEL[b.source] || b.source}</td>
                    <td className="py-2 px-2 text-right whitespace-nowrap">
                      <button type="button" onClick={() => void openHistory(b)} className="p-1 text-slate-300 hover:text-white" title="History"><History className="w-3.5 h-3.5" /></button>
                      {canCorrect && <button type="button" onClick={() => startEdit(b)} className="p-1 text-emerald-400 hover:text-emerald-300" title="Correct batch details"><Edit3 className="w-3.5 h-3.5" /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[10px] text-slate-500">Sales take stock from the batch that expires first (FEFO). Expired batches are never sold; batches without an expiry date are sold last. Quantities change only through sales, purchases and stock adjustments.</p>

        {history && (
          <div className="border border-slate-700 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <strong>History of batch {history.batch.batch_number || `#${history.batch.id}`}</strong>
              <button type="button" onClick={() => setHistory(null)} className="text-slate-400 hover:text-white">Close history</button>
            </div>
            <table className="w-full text-xs">
              <tbody>
                {history.events.map((ev, i) => (
                  <tr key={i} className="border-t border-slate-800">
                    <td className="py-1 pr-2 text-slate-400">{String(ev.date || '').replace('T', ' ').slice(0, 19)}</td>
                    <td className="py-1 pr-2 font-semibold">{SOURCE_LABEL[ev.type] || ev.type}</td>
                    <td className={`py-1 pr-2 text-right font-mono ${ev.quantity < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{ev.quantity > 0 ? '+' : ''}{ev.quantity}</td>
                    <td className="py-1 text-slate-400">{ev.reference?.invoice_number || ''} {ev.detail || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {editing && (
          <form onSubmit={saveEdit} className="border border-emerald-800 rounded-xl p-3 grid grid-cols-2 gap-2 text-xs">
            <div className="col-span-2 font-bold">Correct batch details (quantity cannot be changed here)</div>
            <label>Batch number<input className="w-full bg-slate-800 p-2 rounded border border-slate-700" value={form.batch_number} onChange={(e) => setForm({ ...form, batch_number: e.target.value })} /></label>
            <label>Sale price (Rs.)<input type="number" min="0" step="0.01" className="w-full bg-slate-800 p-2 rounded border border-slate-700" value={form.sale_price} onChange={(e) => setForm({ ...form, sale_price: Number(e.target.value) })} /></label>
            <label>Manufacturing date<input type="date" className="w-full bg-slate-800 p-2 rounded border border-slate-700" value={form.mfg_date} onChange={(e) => setForm({ ...form, mfg_date: e.target.value })} /></label>
            <label>Expiry date<input type="date" className="w-full bg-slate-800 p-2 rounded border border-slate-700" value={form.expiry_date} onChange={(e) => setForm({ ...form, expiry_date: e.target.value })} /></label>
            <label className="col-span-2">Reason for the correction*<input required className="w-full bg-slate-800 p-2 rounded border border-slate-700" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. typing mistake on receipt" /></label>
            <div className="col-span-2 flex gap-2">
              <button type="submit" className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 px-3 rounded-lg">Save correction</button>
              <button type="button" onClick={() => setEditing(null)} className="bg-slate-800 text-slate-300 py-1.5 px-3 rounded-lg">Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
