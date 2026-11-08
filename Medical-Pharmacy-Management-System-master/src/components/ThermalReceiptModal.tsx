import React from 'react';
import { SaleHeader, SystemSettings } from '../types';
import { Printer, X, Download, CheckCircle, Pill } from 'lucide-react';

interface ThermalReceiptModalProps {
  sale: (SaleHeader & { items?: any[] }) | null;
  settings?: SystemSettings | null;
  autoPrint?: boolean;
  onClose: () => void;
}

export const ThermalReceiptModal: React.FC<ThermalReceiptModalProps> = ({ sale, settings, autoPrint, onClose }) => {
  if (!sale) return null;

  React.useEffect(() => {
    if (autoPrint) {
      const timer = setTimeout(() => {
        window.print();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [autoPrint]);

  const storeName = settings?.store_name || 'Khushi Medical Hall';
  const storeUrduName = settings?.store_urdu_name || 'خوشی میڈیکل ہال';
  const address = settings?.address || 'Main Bazaar, Near Civil Hospital, Lahore';
  const phone = settings?.phone || '0300-1234567 / 042-35551234';
  const ntn = settings?.ntn_number || 'NTN-7894561-2';
  const footerMsg = settings?.receipt_footer || 'Get well soon! Check expiry before use. Goods once sold are not returnable without bill.';

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-6">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center space-x-2">
            <CheckCircle className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-bold text-white">Invoice / Thermal Receipt</h2>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Printable Receipt Preview Container (58mm / 80mm Style) */}
        <div 
          id="thermal-receipt-printable" 
          className="bg-white text-slate-900 p-6 rounded-xl font-mono text-xs space-y-4 shadow-inner border border-slate-200"
        >
          {/* Store Logo & Header */}
          <div className="text-center space-y-1 border-b pb-3 border-dashed border-slate-300">
            <div className="flex items-center justify-center space-x-1.5 text-slate-900 font-bold text-base">
              <Pill className="w-5 h-5 text-emerald-700" />
              <span>{storeName}</span>
            </div>
            <div className="text-sm font-sans text-emerald-800 font-bold tracking-wide">
              {storeUrduName}
            </div>
            <div className="text-[10px] text-slate-600">{address}</div>
            <div className="text-[10px] text-slate-600">Tel: {phone}</div>
            <div className="text-[10px] text-slate-500 font-semibold">{ntn}</div>
          </div>

          {/* Invoice Meta */}
          <div className="grid grid-cols-2 gap-2 text-[10px] border-b pb-2 border-dashed border-slate-300">
            <div>
              <div><span className="font-bold">Invoice #:</span> {sale.invoice_number}</div>
              <div><span className="font-bold">Date:</span> {new Date(sale.sale_date).toLocaleString()}</div>
            </div>
            <div className="text-right">
              <div><span className="font-bold">Customer:</span> {sale.customer_name || 'Walk-in Cash Customer'}</div>
              {sale.customer_phone && <div><span className="font-bold">Phone:</span> {sale.customer_phone}</div>}
              <div><span className="font-bold">Cashier:</span> {settings?.cashier_name || sale.created_by_name || 'Pharmacist Admin'}</div>
            </div>
          </div>

          {/* Items Table */}
          <table className="w-full text-left text-[10px] border-b pb-2 border-dashed border-slate-300">
            <thead>
              <tr className="border-b border-slate-200 text-slate-700">
                <th className="py-1">Item</th>
                <th className="py-1 text-center">Batch</th>
                <th className="py-1 text-center">Qty</th>
                <th className="py-1 text-right">Price</th>
                <th className="py-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sale.items && sale.items.map((item, idx) => (
                <tr key={idx}>
                  <td className="py-1 font-sans font-medium pr-1">
                    {item.product_name}
                  </td>
                  <td className="py-1 text-center text-[9px] text-slate-500">{item.batch_number || '-'}</td>
                  <td className="py-1 text-center font-bold">{item.quantity} {item.unit}</td>
                  <td className="py-1 text-right">Rs. {item.sale_price}</td>
                  <td className="py-1 text-right font-bold">Rs. {item.subtotal}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals Breakdown */}
          {(() => {
            const totalAmt = Number(sale.total_amount || sale.grand_total || 0);
            const discountAmt = Number(sale.discount_amount || sale.discount || 0);
            const totalGst = Number(sale.total_gst || sale.tax_amount || 0);
            const grandTotal = Number(sale.grand_total || 0);
            const amountPaid = Number(sale.amount_paid || sale.paid_amount || 0);
            const amountDue = Number(sale.amount_due || sale.udhar_amount || 0);
            const newBalance = sale.new_balance !== undefined && sale.new_balance !== null ? Number(sale.new_balance) : undefined;

            return (
              <>
                <div className="space-y-1 text-[11px] border-b pb-3 border-dashed border-slate-300">
                  <div className="flex justify-between">
                    <span>Subtotal Amount:</span>
                    <span>Rs. {totalAmt.toFixed(2)}</span>
                  </div>
                  {discountAmt > 0 && (
                    <div className="flex justify-between text-rose-600 font-semibold">
                      <span>Discount Offered:</span>
                      <span>- Rs. {discountAmt.toFixed(2)}</span>
                    </div>
                  )}
                  {totalGst > 0 && (
                    <div className="flex justify-between text-slate-600">
                      <span>GST Tax Total:</span>
                      <span>+ Rs. {totalGst.toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-sm text-slate-900 border-t pt-1 border-slate-300">
                    <span>Grand Total:</span>
                    <span>Rs. {grandTotal.toFixed(2)}</span>
                  </div>
                </div>

                {/* Payment Method & Udhar Balance Summary */}
                <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200 space-y-1 text-[10px]">
                  <div className="flex justify-between font-semibold">
                    <span>Payment Method:</span>
                    <span className="bg-slate-200 px-1.5 py-0.5 rounded uppercase">{sale.payment_method || 'CASH'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Amount Paid Now (نقد):</span>
                    <span className="font-bold text-emerald-700">Rs. {amountPaid.toFixed(2)}</span>
                  </div>

                  {amountDue > 0 && (
                    <div className="flex justify-between text-rose-700 font-bold border-t pt-1 border-slate-200">
                      <span>Udhar Added (ادھار):</span>
                      <span>Rs. {amountDue.toFixed(2)}</span>
                    </div>
                  )}

                  {newBalance !== undefined && newBalance > 0 && (
                    <div className="flex justify-between font-bold text-slate-900 text-xs border-t pt-1 border-slate-300">
                      <span>Total Outstanding Udhar (کل ادھار):</span>
                      <span className="text-rose-700">Rs. {newBalance.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </>
            );
          })()}

          {/* Footer Note */}
          <div className="text-center text-[9px] text-slate-500 pt-2 space-y-1">
            <p className="font-sans italic">{footerMsg}</p>
            <p className="font-sans font-semibold text-emerald-800">شفا دینے والا اللہ ہے • Thank You For Buying!</p>
          </div>
        </div>

        {/* Modal Buttons */}
        <div className="flex items-center space-x-3 pt-2">
          <button
            onClick={handlePrint}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-4 rounded-xl flex items-center justify-center space-x-2 transition-colors shadow-lg shadow-emerald-950/40"
          >
            <Printer className="w-4 h-4" />
            <span>Print ESC/POS Thermal Receipt</span>
          </button>

          <button
            onClick={onClose}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold py-2.5 px-4 rounded-xl transition-colors border border-slate-700"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
};
