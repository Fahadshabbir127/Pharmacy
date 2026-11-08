import React, { useState } from 'react';
import { Supplier } from '../types';
import { api } from '../lib/api';
import { Printer, Mail, Send, X, FileText, CheckCircle2, ShieldCheck, Building2, Phone, MapPin, Calendar, DollarSign, Package } from 'lucide-react';

interface PurchaseItemPO {
  product_id: number;
  product_name: string;
  quantity: number;
  purchase_price: number;
  batch_number?: string;
  expiry_date?: string;
}

interface PurchaseOrderModalProps {
  supplier: Supplier;
  poNumber: string;
  items: PurchaseItemPO[];
  notes?: string;
  purchaseDate?: string;
  onClose: () => void;
}

export const PurchaseOrderModal: React.FC<PurchaseOrderModalProps> = ({
  supplier,
  poNumber,
  items,
  notes,
  purchaseDate,
  onClose
}) => {
  const [sendingEmail, setSendingEmail] = useState<boolean>(false);
  const [emailSentSuccess, setEmailSentSuccess] = useState<boolean>(false);
  const [supplierEmailInput, setSupplierEmailInput] = useState<string>(
    supplier.phone && supplier.phone.includes('@') ? supplier.phone : `order@${(supplier.company || supplier.name).toLowerCase().replace(/[^a-z0-9]/g, '')}.com`
  );
  const [customEmailSubject, setCustomEmailSubject] = useState<string>(
    `Official Purchase Order #${poNumber} - Khushi Medical Hall`
  );

  const totalPOAmount = items.reduce((sum, item) => sum + (item.quantity * item.purchase_price), 0);
  const dateFormatted = purchaseDate ? new Date(purchaseDate).toLocaleDateString('en-PK', { year: 'numeric', month: 'long', day: 'numeric' }) : new Date().toLocaleDateString('en-PK', { year: 'numeric', month: 'long', day: 'numeric' });

  const handlePrintPDF = () => {
    window.print();
  };

  const handleSendEmail = async () => {
    try {
      setSendingEmail(true);

      const itemsSummary = items.map((it, idx) => 
        `${idx + 1}. ${it.product_name} - Qty: ${it.quantity} @ Rs. ${(Number(it.purchase_price) || 0).toFixed(2)} = Rs. ${(Number(it.quantity || 0) * Number(it.purchase_price || 0)).toFixed(2)}`
      ).join('\n');

      const fullMessage = `Dear ${supplier.name} (${supplier.company || 'Distributor'}),\n\nPlease process the following official Purchase Order from Khushi Medical Hall:\n\n` +
        `PO Number: ${poNumber}\n` +
        `Order Date: ${dateFormatted}\n\n` +
        `ORDERED ITEMS:\n${itemsSummary}\n\n` +
        `TOTAL ORDER AMOUNT: Rs. ${(Number(totalPOAmount) || 0).toFixed(2)}\n` +
        (notes ? `Special Notes: ${notes}\n\n` : '\n') +
        `Kindly dispatch the shipment with delivery challan to our store address:\n` +
        `Khushi Medical Hall, Main Market, Lahore, Punjab.\n\n` +
        `Thank you,\nKhushi Medical Hall Admin`;

      await api.emailPurchaseOrder({
        supplier_id: supplier.id,
        supplier_email: supplierEmailInput,
        po_number: poNumber,
        subject: customEmailSubject,
        message: fullMessage,
        items_summary: itemsSummary
      });

      setEmailSentSuccess(true);
      setTimeout(() => setEmailSentSuccess(false), 5000);
    } catch (err: any) {
      alert(err.message || 'Failed to dispatch email purchase order');
    } finally {
      setSendingEmail(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 overflow-y-auto print:p-0 print:bg-white print:static">
      
      {/* Modal Container */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-4xl w-full text-slate-100 shadow-2xl overflow-hidden flex flex-col my-auto max-h-[92vh] print:max-h-none print:shadow-none print:border-none print:w-full print:rounded-none print:bg-white print:text-black">
        
        {/* Modal Top Control Bar (Hidden when printing) */}
        <div className="bg-slate-800/90 border-b border-slate-700/80 px-6 py-4 flex items-center justify-between print:hidden">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-emerald-600/20 text-emerald-400 rounded-xl border border-emerald-500/30">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base text-white flex items-center gap-2">
                <span>Purchase Order #{poNumber}</span>
                <span className="text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-800 px-2 py-0.5 rounded-full font-mono">
                  PDF Preview
                </span>
              </h3>
              <p className="text-xs text-slate-400">Supplier: {supplier.name} ({supplier.company || 'Distributor'})</p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={handlePrintPDF}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold flex items-center space-x-1.5 shadow-lg shadow-blue-950/50 transition"
              title="Print or Save as PDF"
            >
              <Printer className="w-4 h-4" />
              <span>Print / Download PDF</span>
            </button>

            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Email PO Banner / Control Section (Hidden when printing) */}
        <div className="bg-slate-950/80 border-b border-slate-800 px-6 py-3.5 print:hidden space-y-2">
          {emailSentSuccess && (
            <div className="p-3 bg-emerald-950/90 border border-emerald-700 rounded-xl text-xs text-emerald-200 font-medium flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Purchase Order email successfully queued & dispatched to <strong>{supplierEmailInput}</strong>!</span>
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-center gap-3">
            <div className="flex-1 w-full space-y-1">
              <label className="text-[11px] font-semibold text-slate-300 flex items-center gap-1">
                <Mail className="w-3.5 h-3.5 text-emerald-400" />
                <span>Supplier Email Address:</span>
              </label>
              <input
                type="email"
                value={supplierEmailInput}
                onChange={(e) => setSupplierEmailInput(e.target.value)}
                placeholder="supplier@company.com"
                className="w-full bg-slate-900 border border-slate-700 text-white text-xs px-3 py-1.5 rounded-xl font-mono focus:outline-none focus:border-emerald-500"
              />
            </div>

            <button
              onClick={handleSendEmail}
              disabled={sendingEmail || !supplierEmailInput}
              className="w-full sm:w-auto mt-auto px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl flex items-center justify-center space-x-2 transition shadow-lg shadow-emerald-950/50 whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{sendingEmail ? 'Sending Email...' : 'Email PO to Supplier'}</span>
            </button>
          </div>
        </div>

        {/* Printable PDF Document Sheet Body */}
        <div className="p-8 sm:p-10 overflow-y-auto bg-white text-slate-900 print:p-0 print:overflow-visible">
          
          {/* Header Section */}
          <div className="flex justify-between items-start border-b-2 border-slate-800 pb-6 mb-6">
            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 bg-emerald-800 text-white rounded-lg flex items-center justify-center font-black text-lg">
                  K
                </div>
                <div>
                  <h1 className="text-xl font-extrabold text-slate-900 tracking-tight">KHUSHI MEDICAL HALL</h1>
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Licensed Pharmaceutical Retail & Wholesale POS</p>
                </div>
              </div>
              <div className="text-xs text-slate-600 pt-2 space-y-0.5">
                <p className="flex items-center gap-1"><MapPin className="w-3 h-3 text-slate-400" /> Main Market, Lahore, Punjab, Pakistan</p>
                <p className="flex items-center gap-1"><Phone className="w-3 h-3 text-slate-400" /> Tel: 0300-0000000 / 042-35800100</p>
                <p className="text-[10px] text-slate-400 font-mono">Drug License #: PHARM-LHR-2026-9012 | NTN: 8912345-6</p>
              </div>
            </div>

            <div className="text-right space-y-1">
              <div className="inline-block bg-slate-900 text-white text-xs font-extrabold px-3 py-1 rounded tracking-wider uppercase">
                PURCHASE ORDER
              </div>
              <p className="text-sm font-extrabold text-emerald-800 font-mono">PO #: {poNumber}</p>
              <p className="text-xs text-slate-600 font-semibold">Date: {dateFormatted}</p>
              <p className="text-xs text-slate-500">Payment Terms: Net 30 Days / COD</p>
            </div>
          </div>

          {/* Supplier & Order Info Cards */}
          <div className="grid grid-cols-2 gap-6 mb-6">
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-1 text-xs">
              <h4 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-200 pb-1.5 mb-2">
                <Building2 className="w-3.5 h-3.5 text-emerald-700" />
                <span>Vendor / Supplier Details</span>
              </h4>
              <p className="font-extrabold text-slate-900 text-sm">{supplier.name}</p>
              {supplier.company && <p className="font-semibold text-emerald-800">{supplier.company}</p>}
              <p className="text-slate-600 font-mono">Phone: {supplier.phone || 'N/A'}</p>
              {supplier.address && <p className="text-slate-600">{supplier.address}</p>}
            </div>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-1 text-xs">
              <h4 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-200 pb-1.5 mb-2">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" />
                <span>Ship To Store Address</span>
              </h4>
              <p className="font-bold text-slate-900">Khushi Medical Hall - Central Store</p>
              <p className="text-slate-600">Attn: Receiving Pharmacist / Inventory Manager</p>
              <p className="text-slate-600">Main Bazaar, Lahore, Punjab, Pakistan</p>
              <p className="text-slate-600 font-mono">Store Contact: 0300-0000000</p>
            </div>
          </div>

          {/* Order Items Table */}
          <div className="border border-slate-300 rounded-xl overflow-hidden mb-6">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-800 font-mono uppercase text-[10px] border-b border-slate-300">
                <tr>
                  <th className="py-2.5 px-3">#</th>
                  <th className="py-2.5 px-3">Product Description</th>
                  <th className="py-2.5 px-3">Batch / Expiry</th>
                  <th className="py-2.5 px-3 text-center">Qty (Units)</th>
                  <th className="py-2.5 px-3 text-right">Unit Price (Rs.)</th>
                  <th className="py-2.5 px-3 text-right">Total (Rs.)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {items.map((item, index) => {
                  const subtotal = item.quantity * item.purchase_price;
                  return (
                    <tr key={index} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-mono text-slate-500 text-[11px]">{index + 1}</td>
                      <td className="py-2.5 px-3 font-bold text-slate-900">{item.product_name}</td>
                      <td className="py-2.5 px-3 font-mono text-slate-600 text-[11px]">
                        {item.batch_number || 'N/A'} {item.expiry_date ? `(Exp: ${item.expiry_date})` : ''}
                      </td>
                      <td className="py-2.5 px-3 text-center font-bold text-slate-800 font-mono">{item.quantity}</td>
                      <td className="py-2.5 px-3 text-right font-mono text-slate-700">Rs. {(Number(item.purchase_price) || 0).toFixed(2)}</td>
                      <td className="py-2.5 px-3 text-right font-bold font-mono text-slate-900">Rs. {(Number(subtotal) || 0).toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Summary & Totals */}
          <div className="flex flex-col sm:flex-row justify-between items-start gap-6 mb-8">
            <div className="flex-1 text-xs space-y-1.5 text-slate-600">
              <p className="font-bold text-slate-900 uppercase text-[10px] tracking-wider">Instructions & Notes:</p>
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 italic">
                {notes || 'Please ensure cold-chain temperature guidelines for sensitive biological items during delivery. Attach invoice and delivery challan with shipment.'}
              </div>
            </div>

            <div className="w-full sm:w-64 bg-slate-100 p-4 rounded-xl border border-slate-300 space-y-2 text-xs">
              <div className="flex justify-between text-slate-700">
                <span>Subtotal:</span>
                <span className="font-mono font-semibold">Rs. {(Number(totalPOAmount) || 0).toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-slate-700">
                <span>GST / Tax:</span>
                <span className="font-mono">Rs. 0.00</span>
              </div>
              <div className="border-t border-slate-300 pt-2 flex justify-between font-extrabold text-sm text-emerald-900">
                <span>Total Amount:</span>
                <span className="font-mono">Rs. {(Number(totalPOAmount) || 0).toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Authorization & Signatures */}
          <div className="grid grid-cols-2 gap-12 pt-8 border-t border-slate-300 text-center text-xs">
            <div>
              <div className="border-b border-slate-400 mb-1 h-12"></div>
              <p className="font-bold text-slate-800">Prepared By (Pharmacist / Staff)</p>
              <p className="text-[10px] text-slate-500">Khushi Medical Hall</p>
            </div>
            <div>
              <div className="border-b border-slate-400 mb-1 h-12"></div>
              <p className="font-bold text-slate-800">Authorized Officer / Owner Signature</p>
              <p className="text-[10px] text-slate-500">Khushi Medical Hall Stamp</p>
            </div>
          </div>

        </div>

      </div>

    </div>
  );
};
