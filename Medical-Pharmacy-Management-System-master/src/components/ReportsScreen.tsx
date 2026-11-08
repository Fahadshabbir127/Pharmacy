import { exportToExcel } from '../lib/excel';
import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { DashboardStats } from '../types';
import { 
  BarChart3, 
  TrendingUp, 
  DollarSign, 
  AlertTriangle, 
  Clock, 
  Calendar, 
  Download, 
  RefreshCw,
  Package,
  ArrowUpRight
} from 'lucide-react';

export const ReportsScreen: React.FC = () => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [salesReport, setSalesReport] = useState<any[]>([]);
  const [topProducts, setTopProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [groupBy, setGroupBy] = useState<'daily' | 'monthly' | 'yearly'>('daily');

  // Date Filters
  const [startDate, setStartDate] = useState<string>(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  );
  const [endDate, setEndDate] = useState<string>(
    new Date().toISOString().split('T')[0]
  );

  useEffect(() => {
    fetchReportData();
  }, [startDate, endDate, groupBy]);

  const fetchReportData = async () => {
    try {
      setLoading(true);
      const [dashStats, sReport, topProds] = await Promise.all([
        api.getDashboardStats(),
        api.getSalesReport(startDate, endDate, groupBy),
        api.getTopProducts()
      ]);
      setStats(dashStats);
      setSalesReport(sReport);
      setTopProducts(topProds);
    } catch (err) {
      console.error('Error fetching report data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleExportSalesReportExcel = () => {
    if (salesReport.length === 0) return;
    const headers = ['Date', 'Total Orders', 'Gross Sales (Rs.)', 'Discounts (Rs.)', 'Net Revenue (Rs.)', 'Net Profit (Rs.)'];
    const rows = salesReport.map(r => [
      r.date,
      r.total_orders,
      r.total_sales,
      r.total_discounts,
      r.grand_total,
      r.profit || 0
    ]);
    exportToExcel([headers, ...rows], `Khushi_Sales_Report_${startDate}_to_${endDate}`);
  };

  return (
    <div className="p-2 sm:p-4 md:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-6">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-white flex items-center space-x-2">
            <BarChart3 className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400 shrink-0" />
            <span>Store Sales, Profit & Stock Analytics</span>
          </h2>
          <p className="text-xs text-slate-400">
            Real-time financial metrics, COGS profit margins, fast/slow moving products, and tax breakdown.
          </p>
        </div>

        <div className="flex items-center space-x-2 w-full sm:w-auto justify-end">
          <button
            onClick={handleExportSalesReportExcel}
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-3 py-2 rounded-xl border border-slate-700 flex items-center space-x-1.5"
          >
            <Download className="w-4 h-4" />
            <span>Export Excel (.xlsx)</span>
          </button>
          <button
            onClick={fetchReportData}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* KPI Cards Grid */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          
          <div className="bg-slate-900 p-4 rounded-2xl border border-slate-800 shadow-lg space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
              <span>Today's Sales (روزانہ فروخت)</span>
              <TrendingUp className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-bold text-white">
              Rs. {stats.todaySalesTotal.toFixed(2)}
            </div>
            <div className="text-[11px] text-emerald-400 font-semibold flex items-center justify-between">
              <span>{stats.todaySalesCount} Invoices</span>
              <span>Profit: Rs. {stats.todayGrossProfit.toFixed(0)}</span>
            </div>
          </div>

          <div className="bg-slate-900 p-4 rounded-2xl border border-slate-800 shadow-lg space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
              <span>Monthly Sales (ماہانہ فروخت)</span>
              <DollarSign className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-bold text-emerald-400">
              Rs. {stats.monthSalesTotal.toFixed(2)}
            </div>
            <div className="text-[11px] text-emerald-300 font-semibold flex items-center justify-between">
              <span>{stats.monthSalesCount} Invoices</span>
              <span>Profit: Rs. {stats.monthGrossProfit.toFixed(0)}</span>
            </div>
          </div>

          <div className="bg-slate-900 p-4 rounded-2xl border border-slate-800 shadow-lg space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
              <span>Yearly Sales (سالانہ فروخت)</span>
              <BarChart3 className="w-4 h-4 text-blue-400" />
            </div>
            <div className="text-2xl font-bold text-blue-400">
              Rs. {stats.yearSalesTotal.toFixed(2)}
            </div>
            <div className="text-[11px] text-blue-300 font-semibold flex items-center justify-between">
              <span>{stats.yearSalesCount} Invoices</span>
              <span>Profit: Rs. {stats.yearGrossProfit.toFixed(0)}</span>
            </div>
          </div>

          <div className="bg-slate-900 p-4 rounded-2xl border border-slate-800 shadow-lg space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
              <span>Total Udhar Owed (ادھار رقم)</span>
              <AlertTriangle className="w-4 h-4 text-rose-400" />
            </div>
            <div className="text-2xl font-bold text-rose-400">
              Rs. {stats.totalUdharBalance.toFixed(2)}
            </div>
            <div className="text-[11px] text-rose-300 font-semibold">
              Customer balance receivable
            </div>
          </div>

        </div>
      )}

      {/* Date Filter Bar & Sales Trend */}
      <div className="bg-slate-900 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-3 border-b border-slate-800">
          <h3 className="font-bold text-white text-sm flex items-center space-x-2">
            <Calendar className="w-4 h-4 text-emerald-400" />
            <span>Sales Revenue Breakdown ({groupBy.toUpperCase()})</span>
          </h3>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center space-x-1.5">
              <span className="text-slate-400 font-semibold">Report View:</span>
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as 'daily' | 'monthly' | 'yearly')}
                className="bg-emerald-950 text-emerald-200 font-bold p-2 rounded-xl border border-emerald-700 focus:outline-none focus:border-emerald-500"
              >
                <option value="daily">Daily Breakdown (روزانہ)</option>
                <option value="monthly">Monthly Summary (ماہانہ)</option>
                <option value="yearly">Yearly Summary (سالانہ)</option>
              </select>
            </div>

            <div className="flex items-center space-x-2">
              <span className="text-slate-400">From:</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-slate-800 text-white p-2 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex items-center space-x-2">
              <span className="text-slate-400">To:</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-slate-800 text-white p-2 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>
        </div>

        {/* Daily/Monthly/Yearly Sales Breakdown Table */}
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-800 text-slate-400 uppercase font-mono">
              <tr>
                <th className="py-2.5 px-4">{groupBy === 'monthly' ? 'Month' : groupBy === 'yearly' ? 'Year' : 'Date'}</th>
                <th className="py-2.5 px-4 text-center hidden sm:table-cell">Orders Count</th>
                <th className="py-2.5 px-4 text-right hidden md:table-cell">Gross Sales</th>
                <th className="py-2.5 px-4 text-right hidden lg:table-cell">Discounts</th>
                <th className="py-2.5 px-4 text-right">Net Revenue</th>
                <th className="py-2.5 px-4 text-right text-emerald-400 font-bold">Net Profit (منافع)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {salesReport.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-500">
                    No sales recorded for the selected date range.
                  </td>
                </tr>
              ) : (
                salesReport.map((row, idx) => (
                  <tr key={idx} className="hover:bg-slate-800/40">
                    <td className="py-2.5 px-4 font-mono text-slate-200">
                      <div>{row.date}</div>
                      <div className="sm:hidden text-[10px] text-slate-400">
                        {row.total_orders} Orders
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-center font-bold text-emerald-400 hidden sm:table-cell">{row.total_orders}</td>
                    <td className="py-2.5 px-4 text-right hidden md:table-cell">Rs. {row.total_sales.toFixed(2)}</td>
                    <td className="py-2.5 px-4 text-right text-rose-400 hidden lg:table-cell">- Rs. {row.total_discounts.toFixed(2)}</td>
                    <td className="py-2.5 px-4 text-right font-bold text-white">Rs. {row.grand_total.toFixed(2)}</td>
                    <td className="py-2.5 px-4 text-right font-bold text-emerald-400 bg-emerald-950/30">Rs. {(row.profit || 0).toFixed(2)}</td>
                  </tr>
                ))
              )}
            </tbody>
            {salesReport.length > 0 && (
              <tfoot className="bg-slate-800/90 font-bold text-white border-t-2 border-slate-700">
                <tr>
                  <td className="py-3 px-4 text-slate-300">TOTAL ({salesReport.length} Periods)</td>
                  <td className="py-3 px-4 text-center text-emerald-400 hidden sm:table-cell">
                    {salesReport.reduce((acc, r) => acc + (r.total_orders || 0), 0)} Orders
                  </td>
                  <td className="py-3 px-4 text-right hidden md:table-cell">
                    Rs. {salesReport.reduce((acc, r) => acc + (r.total_sales || 0), 0).toFixed(2)}
                  </td>
                  <td className="py-3 px-4 text-right text-rose-400 hidden lg:table-cell">
                    - Rs. {salesReport.reduce((acc, r) => acc + (r.total_discounts || 0), 0).toFixed(2)}
                  </td>
                  <td className="py-3 px-4 text-right text-white">
                    Rs. {salesReport.reduce((acc, r) => acc + (r.grand_total || 0), 0).toFixed(2)}
                  </td>
                  <td className="py-3 px-4 text-right text-emerald-400 bg-emerald-950/60 font-black">
                    Rs. {salesReport.reduce((acc, r) => acc + (r.profit || 0), 0).toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Top Fast-Moving Medicines Section */}
      <div className="bg-slate-900 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
        <h3 className="font-bold text-white text-sm flex items-center space-x-2 pb-2 border-b border-slate-800">
          <Package className="w-4 h-4 text-emerald-400" />
          <span>Top Fast-Moving Medicines (پُرفروش ادویات)</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {topProducts.map((tp, idx) => (
            <div key={idx} className="bg-slate-800/60 p-3.5 rounded-xl border border-slate-700/80 flex items-center justify-between text-xs">
              <div>
                <div className="font-bold text-white text-sm flex items-center space-x-2">
                  <span className="w-5 h-5 rounded-full bg-emerald-950 text-emerald-400 font-mono text-[10px] flex items-center justify-center border border-emerald-800">
                    #{idx + 1}
                  </span>
                  <span>{tp.name}</span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Total Units Sold: <span className="font-bold text-emerald-400">{tp.total_qty_sold} {tp.unit}s</span>
                </div>
              </div>

              <div className="text-right">
                <div className="font-bold text-white text-sm">Rs. {(Number(tp.total_revenue) || 0).toFixed(2)}</div>
                <div className="text-[10px] text-slate-500">Revenue Generated</div>
              </div>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
};
