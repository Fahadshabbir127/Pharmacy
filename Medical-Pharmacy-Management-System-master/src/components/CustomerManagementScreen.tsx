import React, { useState, useEffect } from 'react';
import { Customer, LedgerEntry } from '../types';
import { api } from '../lib/api';
import { User } from '../types';
import { 
  Users, 
  Search, 
  UserPlus, 
  DollarSign, 
  Printer, 
  FileText, 
  Phone, 
  MapPin, 
  CheckCircle,
  RefreshCw,
  X,
  Edit,
  Trash2,
  MessageSquare,
  Share2,
  Send,
  Mail,
  ExternalLink,
  Info
} from 'lucide-react';

export const CustomerManagementScreen: React.FC<{ currentUser?: User }> = ({ currentUser }) => {
  const canRegister = currentUser?.role === 'SUPER_ADMIN' || currentUser?.allowed_services?.includes('USER_REGISTER');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Selected Customer Ledger
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [loadingLedger, setLoadingLedger] = useState<boolean>(false);

  // Receive Payment Modal
  const [showPaymentModal, setShowPaymentModal] = useState<boolean>(false);
  const [payAmount, setPayAmount] = useState<string>('');
  const [payMode, setPayMode] = useState<string>('Cash');
  const [payNotes, setPayNotes] = useState<string>('');

  // Add Customer Modal
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [phone, setPhone] = useState<string>('');
  const [address, setAddress] = useState<string>('');
  const [openingBalance, setOpeningBalance] = useState<number>(0);

  // Edit Customer Modal
  const [showEditModal, setShowEditModal] = useState<boolean>(false);
  const [editName, setEditName] = useState<string>('');
  const [editPhone, setEditPhone] = useState<string>('');
  const [editAddress, setEditAddress] = useState<string>('');

  // Prewritten Message Modal
  const [showMessageModal, setShowMessageModal] = useState<boolean>(false);
  const [selectedTemplate, setSelectedTemplate] = useState<'UDHAR_REMINDER' | 'PAYMENT_RECEIPT' | 'REFILL' | 'CUSTOM'>('UDHAR_REMINDER');
  const [customText, setCustomText] = useState<string>('');
  const [settings, setSettings] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchCustomers();
    api.getSettings().then(setSettings).catch(console.error);
  }, []);

  const fetchCustomers = async (selectedIdToKeep?: number) => {
    try {
      setLoading(true);
      const data = await api.getCustomers(searchQuery);
      setCustomers(data);
      if (data.length > 0) {
        const toSelect = selectedIdToKeep ? data.find(c => c.id === selectedIdToKeep) || data[0] : (selectedCustomer ? data.find(c => c.id === selectedCustomer.id) || data[0] : data[0]);
        handleSelectCustomer(toSelect);
      } else {
        setSelectedCustomer(null);
        setLedgerEntries([]);
      }
    } catch (err) {
      console.error('Error fetching customers:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectCustomer = async (c: Customer) => {
    try {
      setSelectedCustomer(c);
      setLoadingLedger(true);
      const data = await api.getCustomerLedger(c.id);
      setLedgerEntries(data.ledger);
    } catch (err) {
      console.error('Error fetching customer ledger:', err);
    } finally {
      setLoadingLedger(false);
    }
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.addCustomer({ name, phone, address, opening_balance: openingBalance });
      setShowAddModal(false);
      setName('');
      setPhone('');
      setAddress('');
      setOpeningBalance(0);
      fetchCustomers();
    } catch (err: any) {
      alert(err.message || 'Failed to add customer');
    }
  };

  const handleOpenEditModal = () => {
    if (!selectedCustomer) return;
    setEditName(selectedCustomer.name);
    setEditPhone(selectedCustomer.phone);
    setEditAddress(selectedCustomer.address || '');
    setShowEditModal(true);
  };

  const handleSaveEditCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomer) return;
    try {
      await api.updateCustomer(selectedCustomer.id, {
        name: editName,
        phone: editPhone,
        address: editAddress
      });
      setShowEditModal(false);
      fetchCustomers(selectedCustomer.id);
    } catch (err: any) {
      alert(err.message || 'Error updating customer');
    }
  };

  const handleDeleteCustomer = async () => {
    if (!selectedCustomer) return;
    if (selectedCustomer.current_balance > 0) {
      alert(`Cannot delete customer with active Udhar debt balance of Rs. ${selectedCustomer.current_balance}. Clear balance or record payment first!`);
      return;
    }
    if (!confirm(`Are you sure you want to delete customer "${selectedCustomer.name}"? This action cannot be undone.`)) {
      return;
    }

    try {
      await api.deleteCustomer(selectedCustomer.id);
      setSelectedCustomer(null);
      fetchCustomers();
    } catch (err: any) {
      alert(err.message || 'Failed to delete customer');
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomer || !payAmount) return;
    try {
      await api.recordCustomerPayment(selectedCustomer.id, Number(payAmount), payMode, payNotes);
      setShowPaymentModal(false);
      setPayAmount('');
      setPayNotes('');
      fetchCustomers(selectedCustomer.id);
    } catch (err: any) {
      alert(err.message || 'Error recording payment');
    }
  };

  // Generate prewritten message text based on template
  const getPrewrittenMessage = () => {
    if (!selectedCustomer) return '';
    const nameStr = selectedCustomer.name;
    const balStr = (Number(selectedCustomer.current_balance) || 0).toFixed(2);
    const storeStr = settings.store_name || 'Khushi Medical Hall';

    let tmpl = '';
    if (selectedTemplate === 'UDHAR_REMINDER') {
      tmpl = settings.msg_template_udhar_reminder || `محترم {name} صاحب! خوشی میڈیکل ہال پر آپ کا بقیہ ادھار رقم Rs. {balance} ہے۔ برائے مہربانی اپنا ادھار کھاتہ جلد از جلد صاف فرمائیں۔ شکریہ! - Khushi Medical Hall`;
    } else if (selectedTemplate === 'PAYMENT_RECEIPT') {
      tmpl = settings.msg_template_payment_receipt || `محترم {name}! خوشی میڈیکل ہال میں آپ کی طرف سے رقم موصول ہو گئی ہے۔ آپ کا بقیہ کھاتہ Rs. {balance} ہے۔ شکریہ! - Khushi Medical Hall`;
    } else if (selectedTemplate === 'REFILL') {
      tmpl = settings.msg_template_refill || `Dear {name}, your regular medicine prescription stock at Khushi Medical Hall may be finishing soon. Visit us today for fresh refill & discounts! - Khushi Medical Hall`;
    } else {
      return customText || `Dear ${nameStr}, greeting from ${storeStr}!`;
    }

    return tmpl
      .replace(/{name}/g, nameStr)
      .replace(/{balance}/g, balStr)
      .replace(/{store_name}/g, storeStr);
  };

  const getCleanPhoneForWhatsApp = (phoneStr: string) => {
    let clean = phoneStr.replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) {
      clean = '92' + clean.slice(1);
    }
    return clean;
  };

  const handleSendWhatsApp = () => {
    if (!selectedCustomer) return;
    const cleanPhone = getCleanPhoneForWhatsApp(selectedCustomer.phone);
    const msg = getPrewrittenMessage();
    const url = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
  };

  const handleSendSMSApp = () => {
    if (!selectedCustomer) return;
    const msg = getPrewrittenMessage();
    const url = `sms:${selectedCustomer.phone}?body=${encodeURIComponent(msg)}`;
    window.open(url, '_self');
  };

  const handlePrintCustomerLedger = () => {
    if (!selectedCustomer) return;

    const entriesHtml = ledgerEntries.map(entry => {
      const itemsHtml = entry.items && entry.items.length > 0
        ? `<div style="margin-top: 4px; padding: 6px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 11px;">
            <strong style="color: #047857; display: block; margin-bottom: 3px;">Purchased Items (خریدی گئی ادویات):</strong>
            <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
              ${entry.items.map(it => `
                <tr style="border-bottom: 1px dashed #e2e8f0;">
                  <td style="padding: 2px 0; color: #1e293b;">• ${it.product_name} (${it.quantity} ${it.unit || 'Pcs'})</td>
                  <td style="padding: 2px 0; text-align: right; font-family: monospace; color: #0f766e;">@ Rs. ${it.sale_price} = Rs. ${it.subtotal}</td>
                </tr>
              `).join('')}
            </table>
           </div>`
        : '';

      const noteHtml = (!entry.items || entry.items.length === 0) && entry.notes
        ? `<div style="font-size: 11px; color: #64748b; font-style: italic; margin-top: 2px;">Note: ${entry.notes}</div>`
        : '';

      const txDate = entry.transaction_date || entry.created_at;
      const entryType = entry.type || entry.entry_type || 'SALE';
      const refText = entry.reference || entry.description || '-';
      const debitVal = Number(entry.debit || 0);
      const creditVal = Number(entry.credit || 0);
      const amtVal = Number(entry.amount || 0);

      let amtDisplay = '-';
      if (debitVal > 0) {
        amtDisplay = `<span style="color: #dc2626;">+ Rs. ${debitVal.toFixed(2)}</span>`;
      } else if (creditVal > 0) {
        amtDisplay = `<span style="color: #16a34a;">- Rs. ${creditVal.toFixed(2)}</span>`;
      } else if (amtVal !== 0) {
        amtDisplay = `<span style="color: ${amtVal > 0 ? '#dc2626' : '#16a34a'};">${amtVal > 0 ? '+' : ''}${amtVal.toFixed(2)}</span>`;
      }

      return `
        <tr style="border-bottom: 1px solid #e2e8f0; vertical-align: top;">
          <td style="padding: 8px; font-size: 12px; white-space: nowrap;">${new Date(txDate).toLocaleDateString()} ${new Date(txDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
          <td style="padding: 8px; font-size: 12px; font-weight: bold;">
            <span style="padding: 2px 6px; border-radius: 4px; font-size: 10px; background: ${entryType === 'SALE' ? '#fee2e2; color: #991b1b;' : '#dcfce7; color: #166534;'}">${entryType}</span>
          </td>
          <td style="padding: 8px; font-size: 12px;">
            <div style="font-weight: 600; color: #0f172a;">${refText}</div>
            ${itemsHtml}
            ${noteHtml}
          </td>
          <td style="padding: 8px; font-size: 12px; text-align: right; font-weight: bold;">
            ${amtDisplay}
          </td>
          <td style="padding: 8px; font-size: 12px; text-align: right; font-weight: bold; font-family: monospace;">
            Rs. ${(Number(entry.balance_after) || 0).toFixed(2)}
          </td>
        </tr>
      `;
    }).join('');

    const storeDisplayName = (settings.store_name || settings.pharmacy_name || currentUser?.tenant_name || 'Khushi Medical Hall & Store').toUpperCase();

    const fullHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>${selectedCustomer.name} - Ledger Statement - ${storeDisplayName}</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; padding: 20px; color: #1e293b; line-height: 1.4; }
            .header { text-align: center; border-bottom: 2px solid #059669; padding-bottom: 10px; margin-bottom: 20px; }
            .title { font-size: 20px; font-weight: bold; color: #065f46; margin: 0; }
            .subtitle { font-size: 13px; color: #475569; margin-top: 4px; }
            .info-grid { display: flex; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 20px; font-size: 13px; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
            th { background: #059669; color: white; text-align: left; padding: 8px; font-size: 12px; }
            .summary { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px; font-size: 14px; text-align: right; font-weight: bold; color: #15803d; }
            .footer { margin-top: 40px; display: flex; justify-content: space-between; font-size: 12px; color: #64748b; }
            @media print {
              body { padding: 0; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1 class="title">${storeDisplayName}</h1>
            <div class="subtitle">Official Customer Udhar Ledger Statement (ادھار کھاتہ رپورٹ)</div>
            <div class="subtitle">Date: ${new Date().toLocaleDateString()} | Time: ${new Date().toLocaleTimeString()}</div>
          </div>

          <div class="info-grid">
            <div>
              <strong>Customer Name:</strong> ${selectedCustomer.name}<br/>
              <strong>Phone Number:</strong> ${selectedCustomer.phone || 'N/A'}<br/>
              <strong>Address:</strong> ${selectedCustomer.address || 'N/A'}
            </div>
            <div style="text-align: right;">
              <strong>Credit Limit:</strong> Rs. ${(Number(selectedCustomer.credit_limit) || 0).toFixed(2)}<br/>
              <strong>Current Udhar Balance:</strong> <span style="color: ${(Number(selectedCustomer.current_balance) || 0) > 0 ? '#dc2626' : '#16a34a'}; font-size: 16px; font-weight: bold;">Rs. ${(Number(selectedCustomer.current_balance) || 0).toFixed(2)}</span>
            </div>
          </div>

          <h3>Ledger History Transactions</h3>
          <table>
            <thead>
              <tr>
                <th>Date & Time</th>
                <th>Type</th>
                <th>Description</th>
                <th style="text-align: right;">Amount (Rs.)</th>
                <th style="text-align: right;">Balance After</th>
              </tr>
            </thead>
            <tbody>
              ${entriesHtml.length > 0 ? entriesHtml : '<tr><td colspan="5" style="text-align:center; padding: 16px;">No ledger records found</td></tr>'}
            </tbody>
          </table>

          <div class="summary">
            TOTAL OUTSTANDING DUE AMOUNT: Rs. ${(Number(selectedCustomer.current_balance) || 0).toFixed(2)}
          </div>

          <div class="footer">
            <div>Verified By: ___________________</div>
            <div>Customer Signature: ___________________</div>
          </div>
        </body>
      </html>
    `;

    // Method 1: Try window.open
    const printWindow = window.open('', '_blank');
    if (printWindow && printWindow.document) {
      printWindow.document.open();
      printWindow.document.write(fullHtml);
      printWindow.document.close();
      setTimeout(() => {
        printWindow.focus();
        printWindow.print();
      }, 300);
      return;
    }

    // Method 2: Fallback Iframe print if popup is blocked
    let iframe = document.getElementById('ledger-print-frame') as HTMLIFrameElement;
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.id = 'ledger-print-frame';
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      document.body.appendChild(iframe);
    }
    const doc = iframe.contentWindow?.document;
    if (doc) {
      doc.open();
      doc.write(fullHtml);
      doc.close();
      setTimeout(() => {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      }, 300);
    }
  };

  const totalUdharAllCustomers = customers.reduce((acc, c) => acc + Math.max(0, c.current_balance), 0);

  return (
    <div className="p-2 sm:p-4 md:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-6">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-white flex items-center space-x-2">
            <Users className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400 shrink-0" />
            <span>Customer Management & Udhar Ledger (ادھار کھاتہ)</span>
          </h2>
          <p className="text-xs text-slate-400">
            Track customer debts, credit limits, transaction ledgers, and debt recovery payments.
          </p>
        </div>

        <div className="flex flex-wrap items-center space-x-2 sm:space-x-3 w-full sm:w-auto justify-end">
          <div className="bg-rose-950/80 border border-rose-800/80 px-3 py-1.5 rounded-xl text-xs font-semibold text-rose-300">
            Total Udhar Credit: <span className="text-white font-bold text-sm">Rs. {(Number(totalUdharAllCustomers) || 0).toFixed(2)}</span>
          </div>

          {canRegister && (
            <button
            onClick={() => setShowAddModal(true)}
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 sm:px-4 py-2 rounded-xl flex items-center space-x-1.5 shadow-lg shadow-emerald-950/50"
          >
            <UserPlus className="w-4 h-4" />
            <span>Add Customer</span>
          </button>
          )}
        </div>
      </div>

      {/* Main Split Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6">
        
        {/* Customer Directory List */}
        <div className="lg:col-span-5 bg-slate-900 p-3 sm:p-4 rounded-2xl border border-slate-800 shadow-xl space-y-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search customer by name or phone..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyUp={(e) => e.key === 'Enter' && fetchCustomers()}
              className="w-full pl-9 pr-4 py-2 bg-slate-800 text-white placeholder-slate-400 rounded-xl border border-slate-700 text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="max-h-[320px] sm:max-h-[420px] lg:max-h-[520px] overflow-y-auto space-y-2 pr-1 scrollbar-thin">
            {loading ? (
              <div className="py-12 text-center text-slate-400">Loading Customers...</div>
            ) : customers.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-xs">No customers registered yet.</div>
            ) : (
              customers.map(c => {
                const isSelected = selectedCustomer?.id === c.id;
                return (
                  <div
                    key={c.id}
                    onClick={() => handleSelectCustomer(c)}
                    className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                      isSelected
                        ? 'bg-slate-800 border-emerald-500 shadow-md'
                        : 'bg-slate-800/40 border-slate-700/60 hover:bg-slate-800/80'
                    }`}
                  >
                    <div>
                      <h4 className="font-bold text-white text-sm">{c.name}</h4>
                      <div className="text-[11px] text-slate-400 flex items-center space-x-2 mt-0.5">
                        <span className="flex items-center"><Phone className="w-3 h-3 mr-1" />{c.phone}</span>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className={`font-bold text-sm ${Number(c.current_balance || 0) > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        Rs. {(Number(c.current_balance) || 0).toFixed(0)}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        {Number(c.current_balance || 0) > 0 ? 'Udhar Debt' : 'Clear'}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Selected Customer Ledger View */}
        <div className="lg:col-span-7 bg-slate-900 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
          {selectedCustomer ? (
            <>
              {/* Ledger Header */}
              <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                <div>
                  <h3 className="font-bold text-base text-white">{selectedCustomer.name}</h3>
                  <div className="text-xs text-slate-400 flex items-center space-x-3 mt-1">
                    <span>Phone: {selectedCustomer.phone}</span>
                    <span>•</span>
                    <span>Address: {selectedCustomer.address || 'N/A'}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handlePrintCustomerLedger}
                    className="bg-indigo-900/80 hover:bg-indigo-800 text-indigo-200 border border-indigo-700/80 text-xs font-bold px-3 py-2 rounded-xl flex items-center space-x-1.5 transition-all"
                    title="Print Customer Ledger Record"
                  >
                    <Printer className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Print Ledger (پرنٹ کھاتہ)</span>
                  </button>

                  <button
                    onClick={() => setShowMessageModal(true)}
                    className="bg-emerald-900/80 hover:bg-emerald-800 text-emerald-200 border border-emerald-700/80 text-xs font-bold px-3 py-2 rounded-xl flex items-center space-x-1.5 transition-all"
                    title="Send Prewritten Message via WhatsApp or Direct SMS"
                  >
                    <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Send Message (پیغام)</span>
                  </button>

                  <button
                    onClick={handleOpenEditModal}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold px-3 py-2 rounded-xl flex items-center space-x-1.5 transition-all"
                    title="Edit Customer Details"
                  >
                    <Edit className="w-3.5 h-3.5 text-blue-400" />
                    <span>Edit</span>
                  </button>

                  <button
                    onClick={handleDeleteCustomer}
                    className="bg-rose-950/60 hover:bg-rose-900/80 text-rose-300 border border-rose-800/80 text-xs font-bold px-3 py-2 rounded-xl flex items-center space-x-1.5 transition-all"
                    title="Delete Customer Account"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                    <span>Delete</span>
                  </button>

                  <button
                    onClick={() => {
                      setPayAmount(String(selectedCustomer.current_balance));
                      setShowPaymentModal(true);
                    }}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-3.5 py-2 rounded-xl flex items-center space-x-1.5 shadow-md"
                  >
                    <DollarSign className="w-4 h-4" />
                    <span>Receive Payment (وصولی)</span>
                  </button>
                </div>
              </div>

              {/* Outstanding Balance Banner */}
              <div className="bg-slate-800/80 p-3.5 rounded-xl border border-slate-700 flex items-center justify-between text-xs">
                <span>Current Udhar Outstanding Balance:</span>
                <span className={`text-base font-bold ${Number(selectedCustomer.current_balance || 0) > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                  Rs. {(Number(selectedCustomer.current_balance) || 0).toFixed(2)}
                </span>
              </div>

              {/* Statement Ledger Table */}
              <div className="max-h-[380px] overflow-y-auto rounded-xl border border-slate-800">
                {loadingLedger ? (
                  <div className="py-12 text-center text-slate-400">Loading Ledger Statement...</div>
                ) : ledgerEntries.length === 0 ? (
                  <div className="py-12 text-center text-slate-500 text-xs">No transactions recorded yet.</div>
                ) : (
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-800 text-slate-400 uppercase font-mono">
                      <tr>
                        <th className="py-2.5 px-3 hidden sm:table-cell">Date</th>
                        <th className="py-2.5 px-3 hidden md:table-cell">Type</th>
                        <th className="py-2.5 px-3">Reference / Details</th>
                        <th className="py-2.5 px-3 text-right">Debit (+Udhar)</th>
                        <th className="py-2.5 px-3 text-right">Credit (-Paid)</th>
                        <th className="py-2.5 px-3 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {ledgerEntries.map(entry => (
                        <tr key={entry.id} className="hover:bg-slate-800/40">
                          <td className="py-2.5 px-3 text-[11px] text-slate-400 hidden sm:table-cell">
                            {new Date(entry.transaction_date).toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' })}
                          </td>
                          <td className="py-2.5 px-3 font-bold hidden md:table-cell">
                            <span className={`px-2 py-0.5 rounded text-[10px] ${
                              entry.type === 'SALE' ? 'bg-rose-950 text-rose-300' : 'bg-emerald-950 text-emerald-300'
                            }`}>
                              {entry.type}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 font-mono">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-200">{entry.reference || '-'}</span>
                              <span className={`sm:hidden px-1.5 py-0.2 rounded text-[9px] font-bold ${
                                entry.type === 'SALE' ? 'bg-rose-950 text-rose-300' : 'bg-emerald-950 text-emerald-300'
                              }`}>{entry.type}</span>
                            </div>
                            <div className="text-[10px] text-slate-400 sm:hidden">
                              {new Date(entry.transaction_date).toLocaleDateString()}
                            </div>
                            {entry.items && entry.items.length > 0 && (
                              <div className="text-[10px] text-emerald-300 mt-1 font-sans space-y-0.5 bg-slate-900/90 p-1.5 rounded border border-slate-700/60">
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
                          <td className="py-2.5 px-3 text-right font-bold text-rose-400">
                            {entry.debit > 0 ? `Rs. ${entry.debit}` : '-'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-bold text-emerald-400">
                            {entry.credit > 0 ? `Rs. ${entry.credit}` : '-'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-bold text-white">
                            Rs. {(Number(entry.balance_after) || 0).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          ) : (
            <div className="py-20 text-center text-slate-500 space-y-2">
              <FileText className="w-8 h-8 mx-auto text-slate-600" />
              <p className="font-semibold text-slate-400">Select a customer from left panel to view ledger statement.</p>
            </div>
          )}
        </div>

      </div>

      {/* RECEIVE PAYMENT MODAL */}
      {showPaymentModal && selectedCustomer && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={handleRecordPayment} className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="font-bold text-base text-white">Record Udhar Debt Payment</h3>
            <div className="text-xs text-slate-300 bg-slate-800 p-3 rounded-xl">
              Customer: <span className="font-bold text-white">{selectedCustomer.name}</span><br />
              Current Udhar Balance: <span className="font-bold text-rose-400">Rs. {(Number(selectedCustomer.current_balance) || 0).toFixed(2)}</span>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Amount Received (Rs.)*:</label>
                <input
                  type="number"
                  required
                  min="1"
                  max={selectedCustomer.current_balance}
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-full bg-slate-800 text-white font-bold text-base p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Payment Mode:</label>
                <select
                  value={payMode}
                  onChange={(e) => setPayMode(e.target.value)}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                >
                  <option value="Cash">Cash (نقد)</option>
                  <option value="EasyPaisa">EasyPaisa</option>
                  <option value="JazzCash">JazzCash</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Notes / Receipt Reference:</label>
                <input
                  type="text"
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  placeholder="e.g. Received by Kashif at store counter"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex items-center space-x-2 pt-2">
              <button
                type="submit"
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl text-xs"
              >
                Confirm Payment Receipt
              </button>
              <button
                type="button"
                onClick={() => setShowPaymentModal(false)}
                className="bg-slate-800 text-slate-400 hover:text-white font-semibold py-2.5 px-4 rounded-xl text-xs"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ADD CUSTOMER MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={handleCreateCustomer} className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="font-bold text-base text-white">Add New Customer Account</h3>
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Customer Full Name*:</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Chaudhry Muhammad Ali"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Phone Number* (Used for Login & SMS):</label>
                <input
                  type="text"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="03001234567"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Address / Town:</label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Main Bazaar, Lahore"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Opening Debt Balance (Rs.):</label>
                <input
                  type="number"
                  value={openingBalance}
                  onChange={(e) => setOpeningBalance(Number(e.target.value))}
                  placeholder="0"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex items-center space-x-2 pt-2">
              <button
                type="submit"
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl text-xs"
              >
                Create Account
              </button>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="bg-slate-800 text-slate-400 hover:text-white font-semibold py-2.5 px-4 rounded-xl text-xs"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* EDIT CUSTOMER MODAL */}
      {showEditModal && selectedCustomer && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={handleSaveEditCustomer} className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="font-bold text-base text-white flex items-center space-x-2">
                <Edit className="w-4 h-4 text-emerald-400" />
                <span>Edit Customer Details</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowEditModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Customer Name*:</label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Phone Number* (Used for Login & Messages):</label>
                <input
                  type="text"
                  required
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Address / Town:</label>
                <input
                  type="text"
                  value={editAddress}
                  onChange={(e) => setEditAddress(e.target.value)}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex items-center space-x-2 pt-2">
              <button
                type="submit"
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl text-xs shadow-md"
              >
                Save Changes
              </button>
              <button
                type="button"
                onClick={() => setShowEditModal(false)}
                className="bg-slate-800 text-slate-400 hover:text-white font-semibold py-2.5 px-4 rounded-xl text-xs"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* PREWRITTEN MESSAGE & DIRECT SENDER MODAL */}
      {showMessageModal && selectedCustomer && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="font-bold text-base text-white flex items-center space-x-2">
                  <MessageSquare className="w-5 h-5 text-emerald-400" />
                  <span>Send Prewritten Message / Reminders</span>
                </h3>
                <p className="text-[11px] text-slate-400">
                  Customer: <span className="text-white font-bold">{selectedCustomer.name}</span> ({selectedCustomer.phone})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowMessageModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Zero Config Explanation Notice */}
            <div className="bg-emerald-950/60 border border-emerald-800/80 p-3 rounded-xl text-xs text-emerald-200 flex items-start space-x-2">
              <Info className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-emerald-300">How messages work without gateway configuration:</p>
                <p className="text-[11px] text-emerald-200/90 mt-0.5">
                  You don't need any paid API or SMS gateway key! Click <strong>WhatsApp Direct</strong> or <strong>Direct Mobile SMS</strong> below. It will automatically open WhatsApp or your device's native messaging app with the prewritten Urdu/English text ready to send in 1-click!
                </p>
              </div>
            </div>

            {/* Template Selector */}
            <div className="space-y-2 text-xs">
              <label className="block text-slate-300 font-semibold">Select Prewritten Message Template:</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedTemplate('UDHAR_REMINDER')}
                  className={`p-2.5 rounded-xl border text-left font-medium transition-all ${
                    selectedTemplate === 'UDHAR_REMINDER'
                      ? 'bg-emerald-900/60 border-emerald-500 text-white font-bold'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-750'
                  }`}
                >
                  <div className="text-xs">Udhar Debt Reminder</div>
                  <div className="text-[10px] opacity-75">ادھار یاددہانی پیغام</div>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedTemplate('PAYMENT_RECEIPT')}
                  className={`p-2.5 rounded-xl border text-left font-medium transition-all ${
                    selectedTemplate === 'PAYMENT_RECEIPT'
                      ? 'bg-emerald-900/60 border-emerald-500 text-white font-bold'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-750'
                  }`}
                >
                  <div className="text-xs">Payment Receipt</div>
                  <div className="text-[10px] opacity-75">وصولی کی رسید</div>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedTemplate('REFILL')}
                  className={`p-2.5 rounded-xl border text-left font-medium transition-all ${
                    selectedTemplate === 'REFILL'
                      ? 'bg-emerald-900/60 border-emerald-500 text-white font-bold'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-750'
                  }`}
                >
                  <div className="text-xs">Prescription Refill</div>
                  <div className="text-[10px] opacity-75">دوائی ختم ہونے کی یاددہانی</div>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedTemplate('CUSTOM')}
                  className={`p-2.5 rounded-xl border text-left font-medium transition-all ${
                    selectedTemplate === 'CUSTOM'
                      ? 'bg-emerald-900/60 border-emerald-500 text-white font-bold'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-750'
                  }`}
                >
                  <div className="text-xs">Custom Message</div>
                  <div className="text-[10px] opacity-75">اپنی مرضی کا پیغام</div>
                </button>
              </div>
            </div>

            {/* Message Preview Box */}
            <div className="space-y-1 text-xs">
              <label className="block text-slate-300 font-semibold">Message Preview (Urdu / English):</label>
              {selectedTemplate === 'CUSTOM' ? (
                <textarea
                  rows={4}
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  placeholder="Type your custom message here..."
                  className="w-full bg-slate-800 text-white p-3 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 text-xs font-sans leading-relaxed"
                />
              ) : (
                <div className="bg-slate-800/90 p-3 rounded-xl border border-slate-700 text-slate-200 font-sans text-xs leading-relaxed">
                  {getPrewrittenMessage()}
                </div>
              )}
            </div>

            {/* Direct Send Action Buttons */}
            <div className="pt-2 space-y-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    const msg = getPrewrittenMessage();
                    const res = await api.sendUdharReminder(selectedCustomer.id, msg);
                    alert(res.message || 'Notification queued successfully for Email AND WhatsApp/SMS!');
                    setShowMessageModal(false);
                  } catch (err: any) {
                    alert(err.message || 'Failed to queue notification');
                  }
                }}
                className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold py-2.5 px-3 rounded-xl text-xs flex items-center justify-center space-x-2 shadow-lg shadow-emerald-950/50"
              >
                <Mail className="w-4 h-4" />
                <span>Queue Automated Email + WhatsApp Gateway Alert</span>
              </button>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleSendWhatsApp}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-3 rounded-xl text-xs flex items-center justify-center space-x-1.5 shadow-md"
                >
                  <Share2 className="w-4 h-4" />
                  <span>Send via WhatsApp App</span>
                </button>

                <button
                  type="button"
                  onClick={handleSendSMSApp}
                  className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-2.5 px-3 rounded-xl text-xs flex items-center justify-center space-x-1.5 shadow-md"
                >
                  <Send className="w-4 h-4" />
                  <span>Send via Mobile SMS</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => setShowMessageModal(false)}
                className="w-full bg-slate-800 text-slate-400 hover:text-white font-semibold py-2 px-4 rounded-xl text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
