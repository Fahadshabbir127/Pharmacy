import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { SaleHeader, User } from '../types';
import { Search, Calendar, RefreshCw, ShoppingCart, DollarSign, Package, Printer, FileText, Download } from 'lucide-react';

interface SalesScreenProps {
  currentUser?: User;
}

export const SalesScreen: React.FC<SalesScreenProps> = ({ currentUser }) => {
  const [sales, setSales] = useState<SaleHeader[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<Record<string, string>>({});
  
  const [filterType, setFilterType] = useState<'ALL' | 'DAILY' | 'WEEKLY' | 'MONTHLY'>('ALL');
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    api.getSettings().then(setSettings).catch(console.error);
  }, []);

  const fetchSales = async () => {
    setLoading(true);
    setError('');
    try {
      const today = new Date();
      let startDate = '';
      let endDate = today.toISOString().split('T')[0];

      if (filterType === 'DAILY') {
        startDate = endDate;
      } else if (filterType === 'WEEKLY') {
        const lastWeek = new Date(today);
        lastWeek.setDate(today.getDate() - 7);
        startDate = lastWeek.toISOString().split('T')[0];
      } else if (filterType === 'MONTHLY') {
        const lastMonth = new Date(today);
        lastMonth.setMonth(today.getMonth() - 1);
        startDate = lastMonth.toISOString().split('T')[0];
      }

      const data = await api.getFullSalesHistory(startDate || undefined, filterType === 'ALL' ? undefined : endDate);
      setSales(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load sales history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSales();
  }, [filterType]);

  const filteredSales = sales.filter((s) => {
    const q = searchTerm.toLowerCase();
    return (
      (s.invoice_number || '').toLowerCase().includes(q) ||
      (s.customer_name || '').toLowerCase().includes(q) ||
      s.items?.some(i => (i.product_name || '').toLowerCase().includes(q))
    );
  });

  const totalRevenue = filteredSales.reduce((acc, s) => acc + (s.grand_total || 0), 0);
  const totalItemsSold = filteredSales.reduce((acc, s) => acc + (s.items?.reduce((iAcc, item) => iAcc + item.quantity, 0) || 0), 0);
  const cashSalesTotal = filteredSales.filter(s => s.payment_status === 'PAID').reduce((acc, s) => acc + s.grand_total, 0);
  const udharSalesTotal = filteredSales.filter(s => s.payment_status !== 'PAID').reduce((acc, s) => acc + s.grand_total, 0);
  
  const totalGrossProfit = filteredSales.reduce((acc, s) => {
    const saleProfit = s.items?.reduce((iAcc, item) => {
      const cost = item.cost_price || 0;
      const profitPerItem = (item.sale_price - cost) * item.quantity;
      return iAcc + profitPerItem;
    }, 0) || 0;
    return acc + saleProfit;
  }, 0);

  const handlePrintRegisterReport = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const rowsHtml = filteredSales.map(s => `
      <tr style="border-bottom: 1px solid #e2e8f0; font-size: 11px;">
        <td style="padding: 6px;">${s.invoice_number}</td>
        <td style="padding: 6px;">${new Date(s.sale_date).toLocaleString()}</td>
        <td style="padding: 6px;">${s.customer_name || 'Walk-in'}</td>
        <td style="padding: 6px; font-weight: bold;">${s.payment_status}</td>
        <td style="padding: 6px; text-align: right; font-weight: bold;">Rs. ${(Number(s.grand_total) || 0).toFixed(2)}</td>
      </tr>
    `).join('');

    const storeDisplayName = (settings.store_name || settings.pharmacy_name || currentUser?.tenant_name || 'Khushi Medical Hall & Store').toUpperCase();

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Sale Register Statement - ${storeDisplayName}</title>
          <style>
            body { font-family: sans-serif; padding: 20px; color: #0f172a; line-height: 1.4; }
            .header { text-align: center; border-bottom: 2px solid #059669; padding-bottom: 8px; margin-bottom: 16px; }
            .title { font-size: 20px; font-weight: bold; color: #065f46; margin: 0; }
            .subtitle { font-size: 12px; color: #475569; }
            .metrics { display: flex; gap: 12px; margin-bottom: 16px; font-size: 12px; }
            .metric-box { flex: 1; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px; rounded: 6px; text-align: center; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
            th { background: #059669; color: white; text-align: left; padding: 6px; font-size: 11px; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1 class="title">${storeDisplayName}</h1>
            <div class="subtitle">Official Sales Register Audit Report (${filterType})</div>
            <div class="subtitle">Generated: ${new Date().toLocaleString()}</div>
          </div>

          <div class="metrics">
            ${currentUser?.role !== 'STAFF' ? `<div class="metric-box">Total Revenue: <br/><strong>Rs. ${(Number(totalRevenue) || 0).toFixed(2)}</strong></div>` : ''}
            ${currentUser?.role !== 'STAFF' ? `<div class="metric-box">Gross Profit: <br/><strong style="color: #059669;">Rs. ${(Number(totalGrossProfit) || 0).toFixed(2)}</strong></div>` : ''}
            <div class="metric-box">Total Invoices: <br/><strong>${filteredSales.length}</strong></div>
            <div class="metric-box">Total Items: <br/><strong>${totalItemsSold}</strong></div>
            ${currentUser?.role !== 'STAFF' ? `<div class="metric-box">Cash Invoices: <br/><strong>Rs. ${(Number(cashSalesTotal) || 0).toFixed(2)}</strong></div>` : ''}
            ${currentUser?.role !== 'STAFF' ? `<div class="metric-box">Udhar Due Sales: <br/><strong>Rs. ${(Number(udharSalesTotal) || 0).toFixed(2)}</strong></div>` : ''}
          </div>

          <table>
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Date & Time</th>
                <th>Customer</th>
                <th>Status</th>
                <th style="text-align: right;">Total (Rs.)</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>

          <script>
            window.onload = function() { window.print(); }
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-emerald-600" />
            <span>Store Sale Register & Audit Log</span>
          </h2>
          <p className="text-xs text-slate-500">Track real-time sales transactions, customer billing registers, and financial turnover</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as any)}
            className="px-3 py-2 text-xs font-bold border border-slate-300 rounded-xl focus:outline-none focus:border-emerald-500 bg-slate-50"
          >
            <option value="DAILY">Today's Register</option>
            <option value="WEEKLY">This Week's Register</option>
            <option value="MONTHLY">This Month's Register</option>
            <option value="ALL">All Time Register</option>
          </select>
          
          <div className="relative flex-1 sm:w-48">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search invoice, customer, item..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs border border-slate-300 rounded-xl focus:outline-none focus:border-emerald-500"
            />
          </div>

          <button
            onClick={handlePrintRegisterReport}
            className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-3 py-2 rounded-xl flex items-center space-x-1 shadow transition-all shrink-0"
            title="Print Sale Register Audit Statement"
          >
            <Printer className="w-4 h-4" />
            <span>Print Register</span>
          </button>
          
          <button
            onClick={fetchSales}
            className="p-2 text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 rounded-xl transition"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Register Summary Cards */}
      <div className={`grid gap-2 sm:gap-3 text-xs ${currentUser?.role === 'STAFF' ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'}`}>
        {currentUser?.role !== 'STAFF' && (
          <div className="bg-white border-l-4 border-emerald-500 p-3 rounded-r-xl shadow-sm">
            <div className="text-slate-500 font-semibold">Total Revenue</div>
            <div className="text-lg font-black text-emerald-600 mt-0.5">Rs. {(Number(totalRevenue) || 0).toFixed(2)}</div>
          </div>
        )}
        {currentUser?.role !== 'STAFF' && (
          <div className="bg-white border-l-4 border-emerald-600 p-3 rounded-r-xl shadow-sm bg-emerald-50/30">
            <div className="text-emerald-800 font-semibold flex items-center justify-between">
              <span>Gross Profit (منافع)</span>
              <DollarSign className="w-3.5 h-3.5 text-emerald-600" />
            </div>
            <div className="text-lg font-black text-emerald-700 mt-0.5">Rs. {(Number(totalGrossProfit) || 0).toFixed(2)}</div>
          </div>
        )}
        <div className="bg-white border-l-4 border-blue-500 p-3 rounded-r-xl shadow-sm">
          <div className="text-slate-500 font-semibold">Invoices / Orders</div>
          <div className="text-lg font-black text-blue-600 mt-0.5">{filteredSales.length} Invoices</div>
        </div>
        <div className="bg-white border-l-4 border-teal-500 p-3 rounded-r-xl shadow-sm">
          <div className="text-slate-500 font-semibold">Total Items Sold</div>
          <div className="text-lg font-black text-teal-600 mt-0.5">{totalItemsSold} Units</div>
        </div>
        {currentUser?.role !== 'STAFF' && (
          <div className="bg-white border-l-4 border-rose-500 p-3 rounded-r-xl shadow-sm col-span-2 sm:col-span-1">
            <div className="text-slate-500 font-semibold">Udhar Due Sales</div>
            <div className="text-lg font-black text-rose-600 mt-0.5">Rs. {(Number(udharSalesTotal) || 0).toFixed(2)}</div>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 p-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Sale Invoices List */}
      <div className="space-y-3">
        {filteredSales.map(sale => (
          <div key={sale.id} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2">
              <div className="flex items-center gap-3">
                <span className="font-bold text-slate-800 text-sm font-mono">{sale.invoice_number}</span>
                <span className="text-xs text-slate-500 flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {new Date(sale.sale_date).toLocaleString()}
                </span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  sale.payment_status === 'PAID' ? 'bg-emerald-100 text-emerald-800' :
                  sale.payment_status === 'PARTIAL' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'
                }`}>
                  {sale.payment_status}
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs font-semibold">
                <div className="text-slate-600">
                  <span className="text-slate-400 mr-1">Customer:</span>
                  <strong className="text-slate-800">{sale.customer_name || 'Walk-in Customer'}</strong>
                </div>
                <div className="text-emerald-700 text-sm">
                  <span className="text-xs text-slate-400 mr-1">Total:</span>
                  <strong>Rs. {(Number(sale.grand_total) || 0).toFixed(2)}</strong>
                </div>
              </div>
            </div>
            
            <div className="p-3 sm:p-4">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-100 font-bold uppercase text-[10px]">
                    <th className="pb-2">Product Name</th>
                    <th className="pb-2 text-right">Qty</th>
                    <th className="pb-2 text-right">Price</th>
                    <th className="pb-2 text-right">Subtotal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {sale.items?.map(item => (
                    <tr key={item.id} className="text-slate-700">
                      <td className="py-1.5 flex items-center gap-2">
                        <Package className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span className="font-semibold">{item.product_name}</span>
                      </td>
                      <td className="py-1.5 text-right font-medium">{item.quantity} {item.unit || 'Pcs'}</td>
                      <td className="py-1.5 text-right font-mono">Rs. {(Number(item.sale_price) || 0).toFixed(2)}</td>
                      <td className="py-1.5 text-right font-mono font-bold text-slate-900">Rs. {(Number(item.subtotal) || 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {filteredSales.length === 0 && !loading && (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-500 text-xs">
            No sale register records found for this period.
          </div>
        )}
      </div>
    </div>
  );
};
