import React, { useState, useEffect } from 'react';
import { Customer, SaleHeader, LedgerEntry } from '../types';
import { api } from '../lib/api';
import { UserCheck, FileText, Phone, MapPin, Printer, RefreshCw, AlertCircle } from 'lucide-react';

export const CustomerPortalScreen: React.FC = () => {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [invoices, setInvoices] = useState<SaleHeader[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    fetchPortalData();
  }, []);

  const fetchPortalData = async () => {
    try {
      setLoading(true);
      const data = await api.getCustomerPortalData();
      setCustomer(data.customer);
      setInvoices(data.recentInvoices);
      setLedger(data.ledger);
    } catch (err) {
      console.error('Error fetching customer portal data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handlePrintStatement = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-slate-400 space-x-2">
        <RefreshCw className="w-6 h-6 animate-spin text-emerald-400" />
        <span>Loading Your Account Statement...</span>
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="p-8 text-center text-slate-400 space-y-2">
        <AlertCircle className="w-10 h-10 mx-auto text-rose-400" />
        <p className="font-bold text-white">Customer Profile Not Found</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      
      {/* Customer Header Banner */}
      <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-emerald-600 flex items-center justify-center text-white shadow-lg shadow-emerald-950/50">
            <UserCheck className="w-8 h-8" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-xl font-bold text-white">{customer.name}</h2>
              <span className="text-xs bg-emerald-950 text-emerald-400 px-2 py-0.5 rounded border border-emerald-800">
                Customer Account
              </span>
            </div>
            <div className="text-xs text-slate-400 flex items-center space-x-3 mt-1">
              <span className="flex items-center"><Phone className="w-3.5 h-3.5 mr-1" />{customer.phone}</span>
              <span>•</span>
              <span className="flex items-center"><MapPin className="w-3.5 h-3.5 mr-1" />{customer.address || 'Khushi Medical Customer'}</span>
            </div>
          </div>
        </div>

        <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 text-right space-y-0.5">
          <div className="text-xs text-slate-400 font-semibold">Total Outstanding Udhar (کل ادھار)</div>
          <div className={`text-2xl font-bold ${customer.current_balance > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
            Rs. {customer.current_balance.toFixed(2)}
          </div>
          <button
            onClick={handlePrintStatement}
            className="text-[11px] text-emerald-400 hover:text-emerald-300 font-bold flex items-center justify-end space-x-1 pt-1"
          >
            <Printer className="w-3 h-3" />
            <span>Print Account Statement</span>
          </button>
        </div>
      </div>

      {/* Account Statement Ledger */}
      <div className="bg-slate-900 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
        <h3 className="font-bold text-white text-base flex items-center space-x-2 pb-2 border-b border-slate-800">
          <FileText className="w-5 h-5 text-emerald-400" />
          <span>Ledger Statement & Udhar Transactions History</span>
        </h3>

        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-800 text-slate-400 uppercase font-mono">
              <tr>
                <th className="py-3 px-4">Date & Time</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Reference</th>
                <th className="py-3 px-4 text-right">Debit (+Udhar)</th>
                <th className="py-3 px-4 text-right">Credit (-Paid)</th>
                <th className="py-3 px-4 text-right">Balance After</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {ledger.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    No transactions recorded in your ledger statement.
                  </td>
                </tr>
              ) : (
                ledger.map(entry => (
                  <tr key={entry.id} className="hover:bg-slate-800/40">
                    <td className="py-3 px-4 font-mono text-slate-400 text-[11px]">
                      {new Date(entry.transaction_date).toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td className="py-3 px-4 font-bold">
                      <span className={`px-2 py-0.5 rounded text-[10px] ${
                        entry.type === 'SALE' ? 'bg-rose-950 text-rose-300' : 'bg-emerald-950 text-emerald-300'
                      }`}>
                        {entry.type}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono">
                      <div>{entry.reference}</div>
                      {entry.items && entry.items.length > 0 && (
                        <div className="text-[10px] text-emerald-300 mt-1 font-sans space-y-0.5 bg-slate-950/80 p-2 rounded-lg border border-slate-700/60">
                          <div className="font-bold text-[9.5px] text-slate-300 uppercase tracking-wider mb-0.5">Purchased Medicines (ادویات کا اندرا ج):</div>
                          {entry.items.map((it, idx) => (
                            <div key={idx} className="flex justify-between items-center text-[10.5px]">
                              <span>• {it.product_name} ({it.quantity} {it.unit})</span>
                              <span className="font-mono text-emerald-200">@ Rs.{it.sale_price} = Rs.{it.subtotal}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {!entry.items?.length && entry.notes && (
                        <div className="text-[10px] text-slate-400 font-sans italic mt-0.5">{entry.notes}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-rose-400">
                      {entry.debit > 0 ? `Rs. ${entry.debit}` : '-'}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-emerald-400">
                      {entry.credit > 0 ? `Rs. ${entry.credit}` : '-'}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-white">
                      Rs. {entry.balance_after.toFixed(2)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
};
