import { exportToExcel } from '../lib/excel';
import React, { useState, useEffect } from 'react';
import { Product, Category, Supplier, User } from '../types';
import { api } from '../lib/api';
import { 
  Package, 
  Search, 
  Plus, 
  Edit3, 
  Trash2, 
  AlertTriangle, 
  Clock, 
  Download, 
  Upload, 
  RefreshCw,
  Sliders,
  X
} from 'lucide-react';

interface InventoryScreenProps {
  currentUser?: User;
}

export const InventoryScreen: React.FC<InventoryScreenProps> = ({ currentUser }) => {
  const isStaff = currentUser?.role === 'STAFF';
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [filterLowStock, setFilterLowStock] = useState<boolean>(false);
  const [expiryDaysFilter, setExpiryDaysFilter] = useState<number>(0); // 0 = all, 30, 60, 90

  // Modals
  const [showProductModal, setShowProductModal] = useState<boolean>(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [showAdjustModal, setShowAdjustModal] = useState<boolean>(false);
  const [adjustProduct, setAdjustProduct] = useState<Product | null>(null);
  const [showCategoryModal, setShowCategoryModal] = useState<boolean>(false);
  const [newCategoryName, setNewCategoryName] = useState<string>('');
  const [newCategoryDesc, setNewCategoryDesc] = useState<string>('');

  // Custom Category & Supplier toggle mode in form
  const [isCustomCategory, setIsCustomCategory] = useState<boolean>(false);
  const [customCategoryName, setCustomCategoryName] = useState<string>('');
  const [isCustomSupplier, setIsCustomSupplier] = useState<boolean>(false);
  const [customSupplierName, setCustomSupplierName] = useState<string>('');

  // Form State
  const [formError, setFormError] = useState<string | null>(null);
  const [isSavingProduct, setIsSavingProduct] = useState<boolean>(false);
  const [formData, setFormData] = useState({
    name: '',
    unit: 'Pack',
    purchase_price: 100,
    sale_price: 130,
    min_stock: 10,
    stock: 50,
    batch_number: '',
    expiry_date: '',
    category_id: '',
    hsn_code: '3004.90',
    gst_rate: 0,
    rack_location: '',
    supplier_id: '',
    barcode: ''
  });

  // Adjust Form State
  const [adjustType, setAdjustType] = useState<'ADD' | 'REMOVE'>('ADD');
  const [adjustQty, setAdjustQty] = useState<number>(1);
  const [adjustReason, setAdjustReason] = useState<string>('Inventory Count Audit');

  useEffect(() => {
    fetchInventory();
  }, [filterLowStock, expiryDaysFilter, selectedCategory]);

  const fetchInventory = async () => {
    try {
      setLoading(true);
      const [prodsData, catsData, suppsData] = await Promise.all([
        api.getInventory({
          search: searchQuery,
          category_id: selectedCategory || undefined,
          low_stock: filterLowStock,
          expiring: expiryDaysFilter > 0 ? true : false,
          expiry_days: expiryDaysFilter > 0 ? expiryDaysFilter : undefined
        }),
        api.getCategories(),
        api.getSuppliers()
      ]);
      setProducts(prodsData);
      setCategories(catsData);
      setSuppliers(suppsData);
    } catch (err) {
      console.error('Error fetching inventory:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenAddModal = () => {
    setEditingProduct(null);
    setFormError(null);
    setIsCustomCategory(false);
    setCustomCategoryName('');
    setIsCustomSupplier(false);
    setCustomSupplierName('');
    setFormData({
      name: '',
      unit: 'Pack',
      purchase_price: 100,
      sale_price: 130,
      min_stock: 10,
      stock: 50,
      batch_number: 'B-' + Math.floor(10000 + Math.random() * 90000),
      expiry_date: new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0],
      category_id: categories.length > 0 ? String(categories[0].id) : '',
      hsn_code: '3004.90',
      gst_rate: 0,
      rack_location: 'Rack A1',
      supplier_id: suppliers.length > 0 ? String(suppliers[0].id) : '',
      barcode: ''
    });
    setShowProductModal(true);
  };

  const handleOpenEditModal = (p: Product) => {
    setEditingProduct(p);
    setFormError(null);
    setIsCustomCategory(false);
    setCustomCategoryName('');
    setIsCustomSupplier(false);
    setCustomSupplierName('');
    setFormData({
      name: p.name,
      unit: p.unit,
      purchase_price: p.purchase_price,
      sale_price: p.sale_price,
      min_stock: p.min_stock,
      stock: p.stock,
      batch_number: p.batch_number || '',
      expiry_date: p.expiry_date || '',
      category_id: p.category_id ? String(p.category_id) : '',
      hsn_code: p.hsn_code || '3004.90',
      gst_rate: p.gst_rate || 0,
      rack_location: p.rack_location || '',
      supplier_id: p.supplier_id ? String(p.supplier_id) : '',
      barcode: p.barcode || ''
    });
    setShowProductModal(true);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const medicineName = formData.name.trim();
    if (!medicineName) {
      setFormError('Please enter a valid Medicine Name.');
      return;
    }

    try {
      setIsSavingProduct(true);
      const payload = {
        ...formData,
        name: medicineName,
        category_id: isCustomCategory ? customCategoryName.trim() : formData.category_id,
        supplier_id: isCustomSupplier ? customSupplierName.trim() : formData.supplier_id
      };

      if (editingProduct) {
        await api.updateProduct(editingProduct.id, payload);
      } else {
        await api.addProduct(payload);
      }
      setShowProductModal(false);
      await fetchInventory();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save medicine product.');
    } finally {
      setIsSavingProduct(false);
    }
  };

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    try {
      await api.addCategory({ name: newCategoryName.trim(), description: newCategoryDesc.trim() });
      setNewCategoryName('');
      setNewCategoryDesc('');
      setShowCategoryModal(false);
      fetchInventory();
    } catch (err: any) {
      alert(err.message || 'Error creating category');
    }
  };

  const handleDeleteProduct = async (id: number) => {
    if (!confirm('Are you sure you want to delete this medicine product?')) return;
    try {
      await api.deleteProduct(id);
      fetchInventory();
    } catch (err: any) {
      alert(err.message || 'Error deleting product');
    }
  };

  const handleStockAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustProduct) return;
    try {
      await api.adjustStock(adjustProduct.id, adjustType, adjustQty, adjustReason);
      setShowAdjustModal(false);
      fetchInventory();
    } catch (err: any) {
      alert(err.message || 'Error adjusting stock');
    }
  };

  // Excel Export
  const handleExportExcel = () => {
    const headers = ['ID', 'Name', 'Category', 'Unit', 'Purchase Price', 'Sale Price', 'Stock', 'Min Stock', 'Batch #', 'Expiry Date', 'Rack Location'];
    const rows = products.map(p => [
      p.id,
      p.name,
      p.category_name || '',
      p.unit,
      p.purchase_price,
      p.sale_price,
      p.stock,
      p.min_stock,
      p.batch_number || '',
      p.expiry_date || '',
      p.rack_location || ''
    ]);

    exportToExcel([headers, ...rows], `Khushi_Store_Inventory_${new Date().toISOString().split('T')[0]}`);
  };

  return (
    <div className="p-2 sm:p-4 md:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-6">
      
      {/* Header & Actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-white flex items-center space-x-2">
            <Package className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400 shrink-0" />
            <span>Store Inventory Management</span>
          </h2>
          <p className="text-xs text-slate-400">
            Manage stock levels, expiry dates, batch numbers, and stock adjustments.
          </p>
        </div>

        <div className="flex items-center space-x-2 sm:space-x-3 w-full sm:w-auto justify-end">
          {!isStaff && (
            <button
              onClick={() => setShowCategoryModal(true)}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-2.5 sm:px-3 py-2 rounded-xl border border-slate-700 flex items-center space-x-1.5"
            >
              <Plus className="w-3.5 h-3.5 text-emerald-400" />
              <span>Add Category</span>
            </button>
          )}

          <button
            onClick={handleExportExcel}
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-2.5 sm:px-3 py-2 rounded-xl border border-slate-700 flex items-center space-x-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Excel (.xlsx)</span>
          </button>

          {!isStaff && (
            <button
              onClick={handleOpenAddModal}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 sm:px-4 py-2 rounded-xl flex items-center space-x-1.5 shadow-lg shadow-emerald-950/50"
            >
              <Plus className="w-4 h-4" />
              <span>Add Medicine</span>
            </button>
          )}
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-slate-900 p-3 sm:p-4 rounded-2xl border border-slate-800 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 shadow-lg">
        
        <div className="relative w-full md:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Search by name, batch, HSN..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyUp={(e) => e.key === 'Enter' && fetchInventory()}
            className="w-full pl-9 pr-4 py-2 bg-slate-800 text-white placeholder-slate-400 rounded-xl border border-slate-700 text-xs focus:outline-none focus:border-emerald-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={() => setFilterLowStock(!filterLowStock)}
            className={`px-3 py-1.5 rounded-xl border font-semibold flex items-center space-x-1.5 transition-colors ${
              filterLowStock 
                ? 'bg-rose-950 text-rose-300 border-rose-800' 
                : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
            <span>Low Stock</span>
          </button>

          <div className="flex flex-wrap items-center space-x-1 bg-slate-800/80 p-1 rounded-xl border border-slate-700">
            <span className="text-[10px] text-slate-400 px-1 font-semibold flex items-center">
              <Clock className="w-3 h-3 mr-1 text-amber-400" /> Expiry:
            </span>
            <button
              onClick={() => setExpiryDaysFilter(0)}
              className={`px-2 py-1 rounded-lg text-[11px] font-semibold transition-all ${
                expiryDaysFilter === 0 ? 'bg-slate-700 text-white font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setExpiryDaysFilter(30)}
              className={`px-2 py-1 rounded-lg text-[11px] font-semibold transition-all ${
                expiryDaysFilter === 30 ? 'bg-rose-900 text-rose-200 font-bold border border-rose-700' : 'text-rose-400 hover:text-rose-300'
              }`}
              title="Items expiring within 30 days"
            >
              30 Days (شدید)
            </button>
            <button
              onClick={() => setExpiryDaysFilter(60)}
              className={`px-2 py-1 rounded-lg text-[11px] font-semibold transition-all ${
                expiryDaysFilter === 60 ? 'bg-amber-900 text-amber-200 font-bold border border-amber-700' : 'text-amber-400 hover:text-amber-300'
              }`}
              title="Items expiring within 60 days"
            >
              60 Days
            </button>
            <button
              onClick={() => setExpiryDaysFilter(90)}
              className={`px-2 py-1 rounded-lg text-[11px] font-semibold transition-all ${
                expiryDaysFilter === 90 ? 'bg-yellow-900 text-yellow-200 font-bold border border-yellow-700' : 'text-yellow-400 hover:text-yellow-300'
              }`}
              title="Items expiring within 90 days"
            >
              90 Days
            </button>
          </div>

          <button
            onClick={fetchInventory}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700"
            title="Refresh Table"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

      </div>

      {/* Inventory Products Table */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-xl overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-slate-400 flex items-center justify-center space-x-2">
            <RefreshCw className="w-5 h-5 animate-spin text-emerald-400" />
            <span>Loading Inventory...</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-800/80 text-slate-400 uppercase font-mono border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Medicine Name</th>
                  <th className="py-3 px-4 hidden md:table-cell">Category</th>
                  <th className="py-3 px-4 hidden lg:table-cell">Unit</th>
                  <th className="py-3 px-4">Purchase / Sale Price</th>
                  <th className="py-3 px-4 text-center hidden sm:table-cell">Batch & Expiry</th>
                  <th className="py-3 px-4 text-center hidden xl:table-cell">Rack</th>
                  <th className="py-3 px-4 text-center">Stock Level</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {products.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-500">
                      No inventory records found.
                    </td>
                  </tr>
                ) : (
                  products.map(p => {
                    const isLowStock = p.stock <= p.min_stock;
                    
                    let daysUntilExpiry: number | null = null;
                    if (p.expiry_date) {
                      const expTime = new Date(p.expiry_date).getTime();
                      const nowTime = new Date().getTime();
                      daysUntilExpiry = Math.ceil((expTime - nowTime) / (1000 * 3600 * 24));
                    }

                    const isExpired = daysUntilExpiry !== null && daysUntilExpiry <= 0;
                    const is30DaysExpiring = daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry <= 30;
                    const is60DaysExpiring = daysUntilExpiry !== null && daysUntilExpiry > 30 && daysUntilExpiry <= 60;
                    const is90DaysExpiring = daysUntilExpiry !== null && daysUntilExpiry > 60 && daysUntilExpiry <= 90;

                    return (
                      <tr key={p.id} className="hover:bg-slate-800/40 transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-bold text-white text-sm">{p.name}</div>
                          <div className="text-[10px] text-slate-500">HSN: {p.hsn_code || 'N/A'} • GST: {p.gst_rate}% {p.barcode ? `• Code: ${p.barcode}` : ''}</div>
                          {/* Mobile-only inline details */}
                          <div className="md:hidden flex flex-wrap gap-1 items-center mt-1 text-[10px]">
                            <span className="bg-slate-800 px-1.5 py-0.5 rounded text-slate-300 border border-slate-700">{p.category_name || 'Uncategorized'}</span>
                            <span className="text-slate-400">Unit: {p.unit}</span>
                            {p.rack_location && <span className="text-slate-400">Rack: {p.rack_location}</span>}
                            {p.expiry_date && (
                              <span className={`px-1 rounded font-semibold ${isExpired ? 'bg-rose-950 text-rose-300' : 'text-amber-400'}`}>
                                Exp: {p.expiry_date}
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="py-3 px-4 font-semibold text-slate-300 hidden md:table-cell">
                          {p.category_name || 'Uncategorized'}
                        </td>

                        <td className="py-3 px-4 hidden lg:table-cell">{p.unit}</td>

                        <td className="py-3 px-4">
                          <div className="text-emerald-400 font-bold">Sale: Rs. {p.sale_price}</div>
                          <div className="text-[10px] text-slate-500">Cost: Rs. {p.purchase_price}</div>
                        </td>

                        <td className="py-3 px-4 text-center hidden sm:table-cell">
                          <div className="font-mono text-slate-300">{p.batch_number || '-'}</div>
                          
                          {p.expiry_date ? (
                            <div className="mt-0.5">
                              <span className={`inline-block text-[10px] px-2 py-0.5 rounded-full font-bold ${
                                isExpired
                                  ? 'bg-rose-950 text-rose-300 border border-rose-800 animate-pulse'
                                  : is30DaysExpiring
                                  ? 'bg-rose-900/90 text-rose-200 border border-rose-700'
                                  : is60DaysExpiring
                                  ? 'bg-amber-900/90 text-amber-200 border border-amber-700'
                                  : is90DaysExpiring
                                  ? 'bg-yellow-900/90 text-yellow-200 border border-yellow-700'
                                  : 'text-slate-400 font-normal'
                              }`}>
                                {p.expiry_date} {
                                  isExpired ? '(EXPIRED)' :
                                  is30DaysExpiring ? `(${daysUntilExpiry}d Expiry)` :
                                  is60DaysExpiring ? `(${daysUntilExpiry}d Expiry)` :
                                  is90DaysExpiring ? `(${daysUntilExpiry}d Expiry)` : ''
                                }
                              </span>
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-500">N/A</span>
                          )}
                        </td>

                        <td className="py-3 px-4 text-center hidden xl:table-cell">
                          <span className="bg-slate-800 px-2 py-0.5 rounded text-[11px] font-mono text-slate-300 border border-slate-700">
                            {p.rack_location || '-'}
                          </span>
                        </td>

                        <td className="py-3 px-4 text-center">
                          <div className="flex items-center justify-center space-x-1.5">
                            <span className={`font-bold px-2.5 py-1 rounded-full text-xs ${
                              p.stock <= 0
                                ? 'bg-rose-950 text-rose-300 border border-rose-800'
                                : isLowStock
                                ? 'bg-amber-950 text-amber-300 border border-amber-800'
                                : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                            }`}>
                              {p.stock} {p.unit}s
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-500 mt-0.5">Min: {p.min_stock}</div>
                        </td>

                        <td className="py-3 px-4 text-right">
                          {isStaff ? (
                            <span className="text-slate-500 text-[11px] font-mono">View Only</span>
                          ) : (
                            <div className="flex items-center justify-end space-x-2">
                              <button
                                onClick={() => {
                                  setAdjustProduct(p);
                                  setShowAdjustModal(true);
                                }}
                                className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-semibold border border-slate-700"
                                title="Quick Stock Adjustment"
                              >
                                Adjust
                              </button>

                              <button
                                onClick={() => handleOpenEditModal(p)}
                                className="p-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-400 rounded-lg border border-slate-700"
                                title="Edit Item"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>

                              <button
                                onClick={() => handleDeleteProduct(p.id)}
                                className="p-1.5 bg-slate-800 hover:bg-rose-950 text-rose-400 rounded-lg border border-slate-700"
                                title="Delete Item"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ADD / EDIT PRODUCT MODAL */}
      {showProductModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <form onSubmit={handleSaveProduct} className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="font-bold text-base text-white flex items-center space-x-2">
                <Package className="w-5 h-5 text-emerald-400" />
                <span>{editingProduct ? 'Edit Medicine Details' : 'Add New Medicine / Item'}</span>
              </h3>
              <button type="button" onClick={() => setShowProductModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {formError && (
              <div className="p-3 bg-rose-950/80 border border-rose-800 text-rose-300 rounded-xl text-xs flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>{formError}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="sm:col-span-2">
                <label className="block text-slate-300 font-semibold mb-1">Medicine Name*:</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={formData.name}
                  onChange={(e) => {
                    setFormData({ ...formData, name: e.target.value });
                    if (formError) setFormError(null);
                  }}
                  placeholder="e.g. Panadol Extra 500mg, Augmentin 625mg, Brufen Syrup"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-medium"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-slate-300 font-semibold">Category:</label>
                  <button
                    type="button"
                    onClick={() => setIsCustomCategory(!isCustomCategory)}
                    className="text-[11px] text-emerald-400 hover:underline font-semibold"
                  >
                    {isCustomCategory ? 'Choose from list' : '+ Custom Category'}
                  </button>
                </div>
                {isCustomCategory ? (
                  <input
                    type="text"
                    placeholder="Enter Category Name (e.g. Antibiotics)"
                    value={customCategoryName}
                    onChange={(e) => setCustomCategoryName(e.target.value)}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                  />
                ) : (
                  <select
                    value={formData.category_id}
                    onChange={(e) => setFormData({ ...formData, category_id: e.target.value })}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">Select Category</option>
                    {categories.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Packaging Unit:</label>
                <select
                  value={formData.unit}
                  onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                >
                  <option value="Piece">Piece (دانہ / سٹرپ)</option>
                  <option value="Pack">Pack (پیک)</option>
                  <option value="Bottle">Bottle (بوتل)</option>
                  <option value="Box">Box (ڈبہ)</option>
                  <option value="Strip">Strip (پتہ)</option>
                  <option value="Flacon">Flacon / Ampoule</option>
                  <option value="Tube">Tube (ٹیوب)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Purchase Price (Rs.)*:</label>
                <input
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value={formData.purchase_price}
                  onChange={(e) => setFormData({ ...formData, purchase_price: Number(e.target.value) })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Sale Price (Rs.)*:</label>
                <input
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value={formData.sale_price}
                  onChange={(e) => setFormData({ ...formData, sale_price: Number(e.target.value) })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Current Stock Quantity*:</label>
                <input
                  type="number"
                  required
                  min="0"
                  value={formData.stock}
                  onChange={(e) => setFormData({ ...formData, stock: Number(e.target.value) })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Minimum Alert Level:</label>
                <input
                  type="number"
                  min="0"
                  value={formData.min_stock}
                  onChange={(e) => setFormData({ ...formData, min_stock: Number(e.target.value) })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Batch Number:</label>
                <input
                  type="text"
                  value={formData.batch_number}
                  onChange={(e) => setFormData({ ...formData, batch_number: e.target.value })}
                  placeholder="e.g. B-88192"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Expiry Date:</label>
                <input
                  type="date"
                  value={formData.expiry_date}
                  onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Rack / Shelf Location:</label>
                <input
                  type="text"
                  value={formData.rack_location}
                  onChange={(e) => setFormData({ ...formData, rack_location: e.target.value })}
                  placeholder="e.g. Rack A1, Drawer 3"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-slate-300 font-semibold">Supplier:</label>
                  <button
                    type="button"
                    onClick={() => setIsCustomSupplier(!isCustomSupplier)}
                    className="text-[11px] text-emerald-400 hover:underline font-semibold"
                  >
                    {isCustomSupplier ? 'Choose from list' : '+ Custom Supplier'}
                  </button>
                </div>
                {isCustomSupplier ? (
                  <input
                    type="text"
                    placeholder="Enter Supplier Name"
                    value={customSupplierName}
                    onChange={(e) => setCustomSupplierName(e.target.value)}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                  />
                ) : (
                  <select
                    value={formData.supplier_id}
                    onChange={(e) => setFormData({ ...formData, supplier_id: e.target.value })}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">Select Supplier</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name} ({s.company})</option>
                    ))}
                  </select>
                )}
              </div>

              <div className="sm:col-span-2">
                <label className="block text-slate-300 font-semibold mb-1">Barcode / GTIN / SKU:</label>
                <input
                  type="text"
                  value={formData.barcode}
                  onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                  placeholder="e.g. 8901000000001 (Leave empty to auto-generate)"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>
            </div>

            <div className="flex items-center space-x-3 pt-3 border-t border-slate-800">
              <button
                type="submit"
                disabled={isSavingProduct}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white font-bold py-2.5 rounded-xl text-xs shadow-lg shadow-emerald-950/50 flex items-center justify-center space-x-2"
              >
                {isSavingProduct ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Saving Medicine...</span>
                  </>
                ) : (
                  <span>Save Medicine</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setShowProductModal(false)}
                className="bg-slate-800 text-slate-400 hover:text-white font-semibold py-2.5 px-4 rounded-xl text-xs"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* CREATE CATEGORY MODAL */}
      {showCategoryModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={handleCreateCategory} className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <h3 className="font-bold text-base text-white">Add New Medicine Category</h3>
              <button type="button" onClick={() => setShowCategoryModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Category Name*:</label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. Antibiotics, Syrups, Painkillers"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Description (Optional):</label>
                <input
                  type="text"
                  placeholder="e.g. Oral antibiotic medicines and tablets"
                  value={newCategoryDesc}
                  onChange={(e) => setNewCategoryDesc(e.target.value)}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex items-center space-x-2 pt-2 border-t border-slate-800">
              <button
                type="submit"
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl text-xs"
              >
                Create Category
              </button>
              <button
                type="button"
                onClick={() => setShowCategoryModal(false)}
                className="bg-slate-800 text-slate-400 hover:text-white font-semibold py-2.5 px-4 rounded-xl text-xs"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* QUICK STOCK ADJUSTMENT MODAL */}
      {showAdjustModal && adjustProduct && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={handleStockAdjustment} className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
            <h3 className="font-bold text-base text-white">Stock Adjustment</h3>
            <div className="text-xs text-slate-300">
              Product: <span className="font-bold text-emerald-400">{adjustProduct.name}</span> (Current Stock: {adjustProduct.stock})
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Action Type:</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setAdjustType('ADD')}
                    className={`py-2 rounded-xl font-bold border text-center ${
                      adjustType === 'ADD' ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300'
                    }`}
                  >
                    + Add Stock
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdjustType('REMOVE')}
                    className={`py-2 rounded-xl font-bold border text-center ${
                      adjustType === 'REMOVE' ? 'bg-rose-600 border-rose-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300'
                    }`}
                  >
                    - Deduct Stock
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Quantity:</label>
                <input
                  type="number"
                  min="1"
                  required
                  value={adjustQty}
                  onChange={(e) => setAdjustQty(Number(e.target.value))}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Audit Reason:</label>
                <select
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                >
                  <option value="Inventory Count Audit">Inventory Count Audit</option>
                  <option value="Damaged Stock">Damaged Stock</option>
                  <option value="Expired Product Disposal">Expired Product Disposal</option>
                  <option value="Supplier Return">Supplier Return</option>
                </select>
              </div>
            </div>

            <div className="flex items-center space-x-2 pt-2">
              <button
                type="submit"
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-xl text-xs"
              >
                Confirm Adjustment
              </button>
              <button
                type="button"
                onClick={() => setShowAdjustModal(false)}
                className="bg-slate-800 text-slate-400 hover:text-white font-semibold py-2 px-3 rounded-xl text-xs"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

    </div>
  );
};
