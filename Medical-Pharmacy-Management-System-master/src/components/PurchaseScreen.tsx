import React, { useState, useEffect } from 'react';
import { Supplier, Product } from '../types';
import { api } from '../lib/api';
import { Truck, Plus, Trash2, CheckCircle, Package, RefreshCw, X, UserPlus, FileText, Mail, History, Calendar, ExternalLink } from 'lucide-react';
import { PurchaseOrderModal } from './PurchaseOrderModal';

export const PurchaseScreen: React.FC = () => {
  const [activeSubTab, setActiveSubTab] = useState<'NEW_PO' | 'PO_HISTORY'>('NEW_PO');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [purchasesHistory, setPurchasesHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Supplier Quick Modal State
  const [showAddSupplierModal, setShowAddSupplierModal] = useState<boolean>(false);
  const [newSuppName, setNewSuppName] = useState<string>('');
  const [newSuppCompany, setNewSuppCompany] = useState<string>('');
  const [newSuppPhone, setNewSuppPhone] = useState<string>('');
  const [newSuppAddress, setNewSuppAddress] = useState<string>('');
  const [addingSupplier, setAddingSupplier] = useState<boolean>(false);

  // Purchase Form
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>('');
  const [invoiceNumber, setInvoiceNumber] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [purchaseItems, setPurchaseItems] = useState<Array<{
    product_id: number;
    product_name: string;
    quantity: number;
    purchase_price: number;
    batch_number: string;
    expiry_date: string;
  }>>([]);

  // Item Row Form Input
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [itemQty, setItemQty] = useState<number>(10);
  const [itemPrice, setItemPrice] = useState<number>(100);
  const [itemBatch, setItemBatch] = useState<string>('');
  const [itemExpiry, setItemExpiry] = useState<string>('');

  const [submitting, setSubmitting] = useState<boolean>(false);

  // PO PDF Modal State
  const [poModalData, setPoModalData] = useState<{
    supplier: Supplier;
    poNumber: string;
    items: Array<{
      product_id: number;
      product_name: string;
      quantity: number;
      purchase_price: number;
      batch_number?: string;
      expiry_date?: string;
    }>;
    notes?: string;
    purchaseDate?: string;
  } | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [supps, prods, purHist] = await Promise.all([
        api.getSuppliers(),
        api.getInventory(),
        api.getPurchases().catch(() => [])
      ]);
      setSuppliers(supps);
      setProducts(prods);
      setPurchasesHistory(purHist);
      if (supps.length > 0 && !selectedSupplierId) setSelectedSupplierId(String(supps[0].id));
    } catch (err) {
      console.error('Error fetching purchase data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddRow = () => {
    if (!selectedProductId) return;
    const prod = products.find(p => p.id === Number(selectedProductId));
    if (!prod) return;

    setPurchaseItems(prev => [
      ...prev,
      {
        product_id: prod.id,
        product_name: prod.name,
        quantity: itemQty,
        purchase_price: itemPrice || prod.purchase_price,
        batch_number: itemBatch || prod.batch_number || '',
        expiry_date: itemExpiry || prod.expiry_date || ''
      }
    ]);

    setSelectedProductId('');
    setItemQty(10);
    setItemPrice(100);
    setItemBatch('');
    setItemExpiry('');
  };

  const handleRemoveRow = (idx: number) => {
    setPurchaseItems(prev => prev.filter((_, i) => i !== idx));
  };

  const handleAddSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSuppName.trim()) {
      alert('Supplier name is required');
      return;
    }
    try {
      setAddingSupplier(true);
      const res = await api.addSupplier({
        name: newSuppName,
        company: newSuppCompany,
        phone: newSuppPhone,
        address: newSuppAddress
      });
      alert(res.message || 'Pharmaceutical Supplier added successfully!');
      setShowAddSupplierModal(false);
      setNewSuppName('');
      setNewSuppCompany('');
      setNewSuppPhone('');
      setNewSuppAddress('');

      // Refresh suppliers list
      const updatedSupps = await api.getSuppliers();
      setSuppliers(updatedSupps);
      if (res.supplier) {
        setSelectedSupplierId(String(res.supplier.id));
      } else if (updatedSupps.length > 0) {
        setSelectedSupplierId(String(updatedSupps[updatedSupps.length - 1].id));
      }
    } catch (err: any) {
      alert(err.message || 'Error adding supplier');
    } finally {
      setAddingSupplier(false);
    }
  };

  const handleSelectProduct = (prodIdStr: string) => {
    setSelectedProductId(prodIdStr);
    const prod = products.find(p => p.id === Number(prodIdStr));
    if (prod) {
      setItemPrice(prod.purchase_price);
      setItemBatch(prod.batch_number || '');
      setItemExpiry(prod.expiry_date || '');
    }
  };

  const handleOpenDraftPOModal = () => {
    if (!selectedSupplierId || purchaseItems.length === 0) {
      alert('Please select a supplier and add at least one item to generate a Purchase Order PDF.');
      return;
    }
    const supp = suppliers.find(s => s.id === Number(selectedSupplierId));
    if (!supp) return;

    setPoModalData({
      supplier: supp,
      poNumber: invoiceNumber || `PO-${Date.now().toString().slice(-6)}`,
      items: purchaseItems,
      notes: notes || 'Official Purchase Order generated from Khushi Medical Hall POS',
      purchaseDate: new Date().toISOString()
    });
  };

  const handleOpenHistoryPOModal = async (purId: number) => {
    try {
      setLoading(true);
      const details = await api.getPurchaseDetails(purId);
      const supp: Supplier = {
        id: details.supplier_id,
        name: details.supplier_name || 'Pharmaceutical Supplier',
        company: details.supplier_company || '',
        phone: details.supplier_phone || '',
        address: details.supplier_address || ''
      };

      setPoModalData({
        supplier: supp,
        poNumber: details.invoice_number,
        items: details.items.map((it: any) => ({
          product_id: it.product_id,
          product_name: it.product_name,
          quantity: it.quantity,
          purchase_price: it.purchase_price,
          batch_number: it.batch_number,
          expiry_date: it.expiry_date
        })),
        notes: details.notes,
        purchaseDate: details.purchase_date
      });
    } catch (err: any) {
      alert(err.message || 'Error fetching purchase details');
    } finally {
      setLoading(false);
    }
  };

  const totalPurchaseAmount = purchaseItems.reduce((acc, item) => acc + (item.quantity * item.purchase_price), 0);

  const handleSubmitPurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSupplierId || purchaseItems.length === 0) {
      alert('Please select supplier and add at least one item');
      return;
    }

    try {
      setSubmitting(true);
      const poNum = invoiceNumber || `PUR-${Date.now().toString().slice(-6)}`;
      const res = await api.recordPurchase({
        supplier_id: Number(selectedSupplierId),
        invoice_number: poNum,
        items: purchaseItems,
        notes
      });

      alert(`Purchase order #${poNum} saved! Inventory stock levels updated.`);

      // Prompt to open PDF PO
      const supp = suppliers.find(s => s.id === Number(selectedSupplierId));
      if (supp) {
        setPoModalData({
          supplier: supp,
          poNumber: poNum,
          items: purchaseItems,
          notes,
          purchaseDate: new Date().toISOString()
        });
      }

      setPurchaseItems([]);
      setInvoiceNumber('');
      setNotes('');
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Error recording purchase order');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-2 sm:p-4 md:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-6">
      
      {/* Page Header & Subtab Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-white flex items-center space-x-2">
            <Truck className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400 shrink-0" />
            <span>Purchase & PDF Purchase Orders (خریداری)</span>
          </h2>
          <p className="text-xs text-slate-400">
            Record supplier stock-in purchases, generate printable PDF Purchase Orders, and email distributors.
          </p>
        </div>

        {/* Subtab Toggle */}
        <div className="flex flex-wrap rounded-xl bg-slate-900 p-1 border border-slate-800 text-xs font-bold shrink-0">
          <button
            onClick={() => setActiveSubTab('NEW_PO')}
            className={`px-3 sm:px-4 py-2 rounded-lg transition flex items-center gap-1.5 ${
              activeSubTab === 'NEW_PO' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Plus className="w-4 h-4" />
            <span>Create Purchase Order</span>
          </button>

          <button
            onClick={() => setActiveSubTab('PO_HISTORY')}
            className={`px-3 sm:px-4 py-2 rounded-lg transition flex items-center gap-1.5 ${
              activeSubTab === 'PO_HISTORY' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <History className="w-4 h-4" />
            <span>PO History ({purchasesHistory.length})</span>
          </button>
        </div>
      </div>

      {activeSubTab === 'NEW_PO' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Supplier & Header Config */}
          <div className="lg:col-span-4 bg-slate-900 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
            <h3 className="font-bold text-white text-sm pb-2 border-b border-slate-800">1. Purchase Order Header</h3>

            <div className="space-y-3 text-xs">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-slate-300 font-semibold">Pharmaceutical Supplier*:</label>
                  <button
                    type="button"
                    onClick={() => setShowAddSupplierModal(true)}
                    className="text-[11px] font-bold text-emerald-400 hover:text-emerald-300 flex items-center space-x-1"
                  >
                    <Plus className="w-3 h-3" />
                    <span>New Supplier</span>
                  </button>
                </div>
                <select
                  value={selectedSupplierId}
                  onChange={(e) => setSelectedSupplierId(e.target.value)}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                >
                  {suppliers.length === 0 ? (
                    <option value="">No suppliers found. Click + New Supplier</option>
                  ) : (
                    suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name} ({s.company || 'Distributor'})</option>
                    ))
                  )}
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Supplier Invoice / PO #:</label>
                <input
                  type="text"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  placeholder="e.g. GSK-INV-8821"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Notes / Delivery Reference:</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Received via distributor truck..."
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700 flex items-center justify-between font-bold">
                <span>Total Purchase Value:</span>
                <span className="text-emerald-400 text-base font-mono">Rs. {(Number(totalPurchaseAmount) || 0).toFixed(2)}</span>
              </div>

              <div className="space-y-2 pt-2">
                <button
                  type="button"
                  disabled={purchaseItems.length === 0}
                  onClick={handleOpenDraftPOModal}
                  className={`w-full py-2.5 rounded-xl font-bold text-xs flex items-center justify-center space-x-2 border transition-all ${
                    purchaseItems.length === 0
                      ? 'bg-slate-800/40 border-slate-800 text-slate-600 cursor-not-allowed'
                      : 'bg-blue-950/80 hover:bg-blue-900 border-blue-700 text-blue-200 shadow'
                  }`}
                >
                  <FileText className="w-4 h-4 text-blue-400" />
                  <span>Preview PDF PO & Email Supplier</span>
                </button>

                <button
                  disabled={submitting || purchaseItems.length === 0}
                  onClick={handleSubmitPurchase}
                  className={`w-full py-3 rounded-xl font-bold text-xs flex items-center justify-center space-x-2 transition-all ${
                    purchaseItems.length === 0
                      ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                      : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950/60'
                  }`}
                >
                  <CheckCircle className="w-4 h-4" />
                  <span>Confirm Stock-In & Update Inventory</span>
                </button>
              </div>
            </div>
          </div>

        {/* Item Entry Table */}
        <div className="lg:col-span-8 bg-slate-900 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
          <h3 className="font-bold text-white text-sm pb-2 border-b border-slate-800">2. Add Purchased Medicine Items</h3>

          {/* Quick Item Entry Bar */}
          <div className="bg-slate-800/60 p-3.5 rounded-xl border border-slate-700/80 grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs">
            <div className="sm:col-span-4">
              <label className="block text-slate-400 font-semibold mb-1">Medicine Item:</label>
              <select
                value={selectedProductId}
                onChange={(e) => handleSelectProduct(e.target.value)}
                className="w-full bg-slate-900 text-white p-2 rounded-lg border border-slate-700 focus:outline-none focus:border-emerald-500"
              >
                <option value="">Select Item...</option>
                {products.map(p => (
                  <option key={p.id} value={p.id}>{p.name} (Cur. Stock: {p.stock})</option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-slate-400 font-semibold mb-1">Qty:</label>
              <input
                type="number"
                min="1"
                value={itemQty}
                onChange={(e) => setItemQty(Number(e.target.value))}
                className="w-full bg-slate-900 text-white p-2 rounded-lg border border-slate-700 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-slate-400 font-semibold mb-1">Cost Price (Rs.):</label>
              <input
                type="number"
                min="0"
                value={itemPrice}
                onChange={(e) => setItemPrice(Number(e.target.value))}
                className="w-full bg-slate-900 text-white p-2 rounded-lg border border-slate-700 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-slate-400 font-semibold mb-1">Batch #:</label>
              <input
                type="text"
                value={itemBatch}
                onChange={(e) => setItemBatch(e.target.value)}
                placeholder="B-901"
                className="w-full bg-slate-900 text-white p-2 rounded-lg border border-slate-700 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="sm:col-span-2 flex items-end">
              <button
                onClick={handleAddRow}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg flex items-center justify-center space-x-1"
              >
                <Plus className="w-4 h-4" />
                <span>Add</span>
              </button>
            </div>
          </div>

          {/* Items Table */}
          <div className="max-h-[360px] overflow-y-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-800 text-slate-400 uppercase font-mono">
                <tr>
                  <th className="py-2.5 px-3">Medicine</th>
                  <th className="py-2.5 px-3 text-center hidden sm:table-cell">Batch #</th>
                  <th className="py-2.5 px-3 text-center hidden md:table-cell">Expiry</th>
                  <th className="py-2.5 px-3 text-center">Qty</th>
                  <th className="py-2.5 px-3 text-right hidden sm:table-cell">Cost Price</th>
                  <th className="py-2.5 px-3 text-right">Total</th>
                  <th className="py-2.5 px-3 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {purchaseItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-500">
                      No items added to purchase order yet.
                    </td>
                  </tr>
                ) : (
                  purchaseItems.map((item, idx) => (
                    <tr key={idx} className="hover:bg-slate-800/40">
                      <td className="py-2.5 px-3 font-bold text-white">
                        <div>{item.product_name}</div>
                        <div className="sm:hidden text-[10px] text-slate-400 font-mono">
                          {item.batch_number ? `Batch: ${item.batch_number}` : ''} @ Rs. {item.purchase_price}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-center font-mono hidden sm:table-cell">{item.batch_number || '-'}</td>
                      <td className="py-2.5 px-3 text-center text-slate-400 hidden md:table-cell">{item.expiry_date || '-'}</td>
                      <td className="py-2.5 px-3 text-center font-bold text-emerald-400">{item.quantity}</td>
                      <td className="py-2.5 px-3 text-right hidden sm:table-cell">Rs. {item.purchase_price}</td>
                      <td className="py-2.5 px-3 text-right font-bold text-white">
                        Rs. {(Number(item.quantity || 0) * Number(item.purchase_price || 0)).toFixed(2)}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <button
                          onClick={() => handleRemoveRow(idx)}
                          className="text-rose-400 hover:text-rose-300"
                        >
                          <Trash2 className="w-3.5 h-3.5 mx-auto" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
      )}

      {activeSubTab === 'PO_HISTORY' && (
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div>
              <h3 className="font-bold text-white text-sm">Purchase Orders & Stock Receipts Archive</h3>
              <p className="text-xs text-slate-400">View past purchase invoices, print PDF POs, or re-email them to suppliers.</p>
            </div>
            <button
              onClick={fetchData}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl flex items-center space-x-1.5 border border-slate-700"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh History</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-800/80 text-slate-400 uppercase font-mono border-b border-slate-700">
                <tr>
                  <th className="py-3 px-4">PO Invoice #</th>
                  <th className="py-3 px-4">Supplier / Brand</th>
                  <th className="py-3 px-4">Purchase Date</th>
                  <th className="py-3 px-4 text-right">Total Amount</th>
                  <th className="py-3 px-4 text-center">PDF PO Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {purchasesHistory.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-slate-500">
                      No recorded purchase orders found in history.
                    </td>
                  </tr>
                ) : (
                  purchasesHistory.map((pur) => (
                    <tr key={pur.id} className="hover:bg-slate-800/50">
                      <td className="py-3 px-4 font-mono font-bold text-emerald-400">
                        {pur.invoice_number}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-bold text-white">{pur.supplier_name || 'Supplier'}</div>
                        <div className="text-[11px] text-slate-400">{pur.supplier_company || 'Distributor'} • {pur.supplier_phone || 'N/A'}</div>
                      </td>
                      <td className="py-3 px-4 text-slate-400 font-mono">
                        {new Date(pur.purchase_date).toLocaleDateString('en-PK', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-white font-mono text-sm">
                        Rs. {Number(pur.total_amount).toFixed(2)}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center space-x-2">
                          <button
                            onClick={() => handleOpenHistoryPOModal(pur.id)}
                            className="px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white border border-blue-500/30 rounded-xl font-bold text-xs flex items-center space-x-1.5 transition shadow"
                            title="Generate & View PDF Purchase Order"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            <span>PDF PO</span>
                          </button>

                          <button
                            onClick={() => handleOpenHistoryPOModal(pur.id)}
                            className="px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 rounded-xl font-bold text-xs flex items-center space-x-1.5 transition shadow"
                            title="Email PO to Supplier"
                          >
                            <Mail className="w-3.5 h-3.5" />
                            <span>Email Supplier</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PDF Purchase Order Modal */}
      {poModalData && (
        <PurchaseOrderModal
          supplier={poModalData.supplier}
          poNumber={poModalData.poNumber}
          items={poModalData.items}
          notes={poModalData.notes}
          purchaseDate={poModalData.purchaseDate}
          onClose={() => setPoModalData(null)}
        />
      )}

      {/* Add New Supplier Modal */}
      {showAddSupplierModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl relative space-y-4">
            <button
              onClick={() => setShowAddSupplierModal(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center space-x-2 pb-2 border-b border-slate-800">
              <UserPlus className="w-5 h-5 text-emerald-400" />
              <h3 className="text-base font-bold text-white">Add Pharmaceutical Supplier</h3>
            </div>

            <form onSubmit={handleAddSupplier} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Supplier / Representative Name*:</label>
                <input
                  type="text"
                  required
                  value={newSuppName}
                  onChange={(e) => setNewSuppName(e.target.value)}
                  placeholder="e.g. Tariq Ahmad (Pharma Sales)"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Pharmaceutical Company / Brand:</label>
                <input
                  type="text"
                  value={newSuppCompany}
                  onChange={(e) => setNewSuppCompany(e.target.value)}
                  placeholder="e.g. Sami Pharmaceuticals / GSK"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Phone Number:</label>
                <input
                  type="text"
                  value={newSuppPhone}
                  onChange={(e) => setNewSuppPhone(e.target.value)}
                  placeholder="e.g. +92 300 1234567"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Distributor Address / Depot:</label>
                <textarea
                  value={newSuppAddress}
                  onChange={(e) => setNewSuppAddress(e.target.value)}
                  rows={2}
                  placeholder="e.g. Main Medicine Market, Lahore"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="pt-2 flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowAddSupplierModal(false)}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold px-4 py-2 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addingSupplier}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-5 py-2 rounded-xl flex items-center space-x-1.5 shadow-lg shadow-emerald-950/50"
                >
                  {addingSupplier ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  <span>Save Supplier</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
