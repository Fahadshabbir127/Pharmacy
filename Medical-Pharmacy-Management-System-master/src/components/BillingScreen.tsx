import React, { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Product, Category, Customer, CartItem, SaleHeader, SystemSettings } from '../types';
import { api, saveDraftCart, loadDraftCart, clearDraftCart, savePendingOfflineSale } from '../lib/api';
import { ThermalReceiptModal } from './ThermalReceiptModal';
import { 
  Search, 
  Plus, 
  Minus, 
  Trash2, 
  ShoppingCart, 
  User, 
  CreditCard, 
  DollarSign, 
  CheckCircle, 
  AlertCircle, 
  Pill, 
  RefreshCw,
  UserPlus,
  Percent,
  X,
  Barcode,
  Scan,
  Camera,
  Volume2,
  Check,
  Zap,
  Sparkles
} from 'lucide-react';

interface BillingScreenProps {
  settings?: SystemSettings | null;
  onRefreshData?: () => void;
}

export const BillingScreen: React.FC<BillingScreenProps> = ({ settings, onRefreshData }) => {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);

  // Cart State
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [overallDiscountPercent, setOverallDiscountPercent] = useState<number>(0);

  // Payment Modal State
  const [showPaymentModal, setShowPaymentModal] = useState<boolean>(false);
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'PARTIAL' | 'UDHAR'>('CASH');
  const [amountPaidInput, setAmountPaidInput] = useState<string>('');
  const [submittingSale, setSubmittingSale] = useState<boolean>(false);

  // New Customer Quick Modal
  const [showAddCustomerModal, setShowAddCustomerModal] = useState<boolean>(false);
  const [newCustName, setNewCustName] = useState<string>('');
  const [newCustPhone, setNewCustPhone] = useState<string>('');
  const [newCustAddress, setNewCustAddress] = useState<string>('');

  // Receipt Modal State
  const [completedSale, setCompletedSale] = useState<(SaleHeader & { items?: any[] }) | null>(null);

  // Draft Cart Alert State
  const [hasDraft, setHasDraft] = useState<boolean>(false);

  // Barcode Scanner & Print States
  const [barcodeMode, setBarcodeMode] = useState<boolean>(true);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [printOnSave, setPrintOnSave] = useState<boolean>(true);
  const [scanNotice, setScanNotice] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);
  const [lastScannedItem, setLastScannedItem] = useState<{ name: string; price: number; barcode: string; timestamp: number } | null>(null);
  
  // Camera Modal States
  const [showCameraScanner, setShowCameraScanner] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // USB Scanner Keypress Buffer Refs
  const barcodeBufferRef = useRef<string>('');
  const lastKeyTimeRef = useRef<number>(0);

  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchInitialData();
    checkDraftCart();
  }, []);

  // Audio Beep Generator using Web Audio API
  const playScanBeep = (type: 'success' | 'error' = 'success') => {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      
      if (type === 'success') {
        osc.frequency.setValueAtTime(1400, ctx.currentTime);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      } else {
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      }
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (type === 'success' ? 0.12 : 0.25));
    } catch (e) {
      // Audio muted or blocked
    }
  };

  // Find product by Barcode / GTIN / SKU / Batch / HSN / ID / Name
  const findProductByBarcode = (query: string): Product | undefined => {
    if (!query || !query.trim()) return undefined;
    const q = query.trim().toLowerCase();
    const qClean = q.replace(/[^a-z0-9]/gi, '');

    // 1. Exact match by barcode
    let match = products.find(p => p.barcode && p.barcode.toLowerCase().trim() === q);
    if (match) return match;

    // 2. Barcode match ignoring leading zeroes or special chars
    match = products.find(p => {
      if (!p.barcode) return false;
      const pClean = p.barcode.toLowerCase().replace(/[^a-z0-9]/gi, '');
      return pClean === qClean || p.barcode.replace(/^0+/, '') === q.replace(/^0+/, '');
    });
    if (match) return match;

    // 3. Exact match by batch number
    match = products.find(p => p.batch_number && p.batch_number.toLowerCase().trim() === q);
    if (match) return match;

    // 4. Exact match by HSN code
    match = products.find(p => p.hsn_code && p.hsn_code.toLowerCase().trim() === q);
    if (match) return match;

    // 5. Match by Product ID (e.g. 1 or KMH-1)
    match = products.find(p => String(p.id) === q || `kmh-${p.id}` === q);
    if (match) return match;

    // 6. Match by exact product name or generic name
    match = products.find(p => (p.name && p.name.toLowerCase().trim() === q) || (p.generic_name && p.generic_name.toLowerCase().trim() === q));
    if (match) return match;

    // 7. Partial/contains barcode match
    match = products.find(p => p.barcode && (p.barcode.toLowerCase().includes(q) || q.includes(p.barcode.toLowerCase())));
    return match;
  };

  // Process a barcode scan
  const processBarcodeScan = (code: string) => {
    if (!code || !code.trim()) return;
    const trimmed = code.trim();
    const matchedProduct = findProductByBarcode(trimmed);

    if (matchedProduct) {
      if (matchedProduct.stock <= 0) {
        playScanBeep('error');
        setScanNotice({
          type: 'error',
          message: `⚠️ Out of Stock! "${matchedProduct.name}" is currently unavailable in inventory.`
        });
        return;
      }

      handleAddToCart(matchedProduct);
      playScanBeep('success');
      setLastScannedItem({
        name: matchedProduct.name,
        price: matchedProduct.sale_price,
        barcode: matchedProduct.barcode || trimmed,
        timestamp: Date.now()
      });
      setScanNotice({
        type: 'success',
        message: `✓ Scanned & Added "${matchedProduct.name}" (Rs. ${matchedProduct.sale_price})`
      });
      setSearchQuery('');
    } else {
      playScanBeep('error');
      setScanNotice({
        type: 'warning',
        message: `❌ No registered product found for scanned code: "${trimmed}"`
      });
    }

    setTimeout(() => {
      if (searchInputRef.current) searchInputRef.current.focus();
    }, 50);
  };

  // USB Barcode Scanner Global Keyboard Stream Listener
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const activeElement = document.activeElement;
      const isInputFocused = activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA' || activeElement?.tagName === 'SELECT';

      if (isInputFocused && activeElement !== searchInputRef.current) {
        return;
      }

      const now = Date.now();
      const timeDiff = now - lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;

      if (e.key === 'Enter') {
        if (barcodeBufferRef.current.length >= 3) {
          const scannedCode = barcodeBufferRef.current;
          barcodeBufferRef.current = '';
          e.preventDefault();
          processBarcodeScan(scannedCode);
        } else {
          barcodeBufferRef.current = '';
        }
      } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (timeDiff > 80) {
          barcodeBufferRef.current = e.key;
        } else {
          barcodeBufferRef.current += e.key;
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [products]);

  // Handle Camera Barcode Scanner lifecycle
  useEffect(() => {
    let html5QrcodeScanner: Html5Qrcode | null = null;
    let isMounted = true;

    if (showCameraScanner) {
      setCameraError(null);
      const scannerId = 'camera-barcode-reader';

      const timer = setTimeout(async () => {
        try {
          const element = document.getElementById(scannerId);
          if (!element) return;

          html5QrcodeScanner = new Html5Qrcode(scannerId);

          const config = {
            fps: 15,
            qrbox: { width: 260, height: 180 },
            aspectRatio: 1.333,
          };

          await html5QrcodeScanner.start(
            { facingMode: 'environment' },
            config,
            (decodedText) => {
              if (isMounted && decodedText) {
                playScanBeep('success');
                processBarcodeScan(decodedText);
                setShowCameraScanner(false);
              }
            },
            () => {
              // Frame scan attempt failed to find barcode (normal)
            }
          );
        } catch (err: any) {
          console.error('Camera Scanner error:', err);
          if (isMounted) {
            setCameraError(err?.message || 'Could not start camera scanner. Please check browser camera permissions.');
          }
        }
      }, 150);

      return () => {
        isMounted = false;
        clearTimeout(timer);
        if (html5QrcodeScanner) {
          html5QrcodeScanner.stop().then(() => {
            html5QrcodeScanner?.clear();
          }).catch(() => {});
        }
      };
    }
  }, [showCameraScanner]);

  // Save draft cart to LocalStorage on changes
  useEffect(() => {
    if (cart.length > 0) {
      saveDraftCart(cart, selectedCustomer?.id, overallDiscountPercent);
    } else {
      clearDraftCart();
    }
  }, [cart, selectedCustomer, overallDiscountPercent]);

  const fetchInitialData = async () => {
    try {
      setLoading(true);
      const [prodsData, catsData, custsData] = await Promise.all([
        api.getInventory(),
        api.getCategories(),
        api.getCustomers(),
      ]);
      setProducts(prodsData);
      setCategories(catsData);
      setCustomers(custsData);
    } catch (err) {
      console.error('Error fetching billing data:', err);
    } finally {
      setLoading(false);
    }
  };

  const checkDraftCart = () => {
    const draft = loadDraftCart();
    if (draft && draft.cart && draft.cart.length > 0) {
      setHasDraft(true);
    }
  };

  const handleRestoreDraft = () => {
    const draft = loadDraftCart();
    if (draft && draft.cart) {
      setCart(draft.cart);
      if (draft.customerId) {
        const found = customers.find(c => c.id === draft.customerId);
        if (found) setSelectedCustomer(found);
      }
      setOverallDiscountPercent(draft.discountPercent || 0);
    }
    setHasDraft(false);
  };

  const handleDiscardDraft = () => {
    clearDraftCart();
    setHasDraft(false);
  };

  // Add Product to Cart
  const handleAddToCart = (product: Product) => {
    if (product.stock <= 0) {
      alert(`"${product.name}" is currently Out of Stock!`);
      return;
    }

    setCart(prev => {
      const existingIndex = prev.findIndex(item => item.product.id === product.id);
      if (existingIndex > -1) {
        const updated = [...prev];
        const currentQty = updated[existingIndex].quantity;
        if (currentQty + 1 > product.stock) {
          alert(`Cannot add more than available stock (${product.stock} ${product.unit})`);
          return prev;
        }
        const newQty = currentQty + 1;
        const subtotal = calculateItemSubtotal(
          newQty, 
          product.sale_price, 
          updated[existingIndex].discount_percent, 
          product.gst_rate
        );
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: newQty,
          subtotal
        };
        return updated;
      } else {
        const subtotal = calculateItemSubtotal(1, product.sale_price, 0, product.gst_rate);
        return [
          ...prev,
          {
            product,
            quantity: 1,
            unit_price: product.sale_price,
            discount_percent: 0,
            discount_amount: 0,
            gst_percent: product.gst_rate,
            gst_amount: 0,
            subtotal
          }
        ];
      }
    });

    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  };

  const calculateItemSubtotal = (qty: number, price: number, discPercent: number, gstPercent: number) => {
    const rawTotal = qty * price;
    const discAmount = (rawTotal * discPercent) / 100;
    const afterDisc = rawTotal - discAmount;
    const gstAmt = (afterDisc * gstPercent) / 100;
    return afterDisc + gstAmt;
  };

  const updateCartQuantity = (productId: number, delta: number) => {
    setCart(prev => {
      return prev.map(item => {
        if (item.product.id === productId) {
          const newQty = item.quantity + delta;
          if (newQty <= 0) return null;
          if (newQty > item.product.stock) {
            alert(`Maximum available stock reached (${item.product.stock})`);
            return item;
          }
          const subtotal = calculateItemSubtotal(newQty, item.unit_price, item.discount_percent, item.gst_percent);
          return { ...item, quantity: newQty, subtotal };
        }
        return item;
      }).filter(Boolean) as CartItem[];
    });
  };

  const setDirectCartQuantity = (productId: number, newQtyVal: number) => {
    setCart(prev => {
      return prev.map(item => {
        if (item.product.id === productId) {
          let targetQty = newQtyVal;
          if (isNaN(targetQty) || targetQty <= 0) {
            targetQty = 1;
          }
          if (targetQty > item.product.stock) {
            alert(`Maximum available stock reached for "${item.product.name}" (${item.product.stock} ${item.product.unit})`);
            targetQty = item.product.stock;
          }
          const subtotal = calculateItemSubtotal(targetQty, item.unit_price, item.discount_percent, item.gst_percent);
          return { ...item, quantity: targetQty, subtotal };
        }
        return item;
      });
    });
  };

  const updateCartItemDiscount = (productId: number, discPercent: number) => {
    setCart(prev => {
      return prev.map(item => {
        if (item.product.id === productId) {
          const subtotal = calculateItemSubtotal(item.quantity, item.unit_price, discPercent, item.gst_percent);
          return { ...item, discount_percent: discPercent, subtotal };
        }
        return item;
      });
    });
  };

  const removeFromCart = (productId: number) => {
    setCart(prev => prev.filter(item => item.product.id !== productId));
  };

  // Cart Calculations
  const { cartSubtotal, cartItemDiscounts, cartGstTotal, overallDiscountAmount, grandTotal } = React.useMemo(() => {
    const subtotal = cart.reduce((acc, item) => acc + (item.quantity * item.unit_price), 0);
    const itemDiscounts = cart.reduce((acc, item) => {
      const raw = item.quantity * item.unit_price;
      return acc + ((raw * item.discount_percent) / 100);
    }, 0);
    const gstTotal = cart.reduce((acc, item) => {
      const raw = item.quantity * item.unit_price;
      const afterDisc = raw - ((raw * item.discount_percent) / 100);
      return acc + ((afterDisc * item.gst_percent) / 100);
    }, 0);
    const discAmount = ((subtotal - itemDiscounts) * overallDiscountPercent) / 100;
    const gTotal = Math.max(0, (subtotal - itemDiscounts - discAmount) + gstTotal);

    return {
      cartSubtotal: subtotal,
      cartItemDiscounts: itemDiscounts,
      cartGstTotal: gstTotal,
      overallDiscountAmount: discAmount,
      grandTotal: gTotal
    };
  }, [cart, overallDiscountPercent]);

  // Handle Quick Add Customer
  const handleQuickAddCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustName || !newCustPhone) return;
    try {
      await api.addCustomer({ name: newCustName, phone: newCustPhone, address: newCustAddress });
      const updatedCusts = await api.getCustomers();
      setCustomers(updatedCusts);
      const added = updatedCusts.find(c => c.phone === newCustPhone);
      if (added) setSelectedCustomer(added);
      setShowAddCustomerModal(false);
      setNewCustName('');
      setNewCustPhone('');
      setNewCustAddress('');
    } catch (err: any) {
      alert(err.message || 'Failed to add customer');
    }
  };

  // Auto download invoice file to device
  const downloadSaleInvoiceFile = (saleDetail: any) => {
    const storeName = settings?.store_name || settings?.pharmacy_name || 'KHUSHI MEDICAL HALL';
    const address = settings?.address || 'Main Bazar, Medical Complex Road';
    const phone = settings?.phone || '03247077664';

    const line = '='.repeat(52);
    const dash = '-'.repeat(52);

    let text = `====================================================\n`;
    text += `           ${storeName.toUpperCase()}\n`;
    text += `      ${address}\n`;
    text += `            Phone: ${phone}\n`;
    text += `====================================================\n\n`;
    text += `INVOICE NUMBER : ${saleDetail.invoice_number || 'INV-TEMP'}\n`;
    text += `DATE & TIME    : ${new Date(saleDetail.sale_date || Date.now()).toLocaleString()}\n`;
    text += `CUSTOMER       : ${saleDetail.customer_name || 'Walk-in Customer'}\n`;
    if (saleDetail.customer_phone) {
      text += `PHONE          : ${saleDetail.customer_phone}\n`;
    }
    text += `PAYMENT METHOD : ${saleDetail.payment_method}\n`;
    text += `STATUS         : ${saleDetail.amount_due > 0 ? 'PARTIAL / UDHAR (CREDIT)' : 'PAID IN FULL'}\n`;
    text += `\n${line}\n`;
    text += `ITEM NAME                   QTY   PRICE    TOTAL (RS)\n`;
    text += `${dash}\n`;

    const items = saleDetail.items || [];
    items.forEach((item: any) => {
      const name = (item.product_name || item.product?.name || 'Medicine Item').padEnd(25).slice(0, 25);
      const qty = String(item.quantity).padStart(5);
      const price = String(Number(item.sale_price || item.unit_price || 0).toFixed(0)).padStart(7);
      const total = String(Number(item.subtotal || 0).toFixed(0)).padStart(10);
      text += `${name} ${qty} ${price} ${total}\n`;
    });

    text += `${dash}\n`;
    text += `SUBTOTAL           : Rs. ${Number(saleDetail.total_amount || saleDetail.net_amount || 0).toFixed(2)}\n`;
    text += `DISCOUNT           : Rs. ${Number(saleDetail.discount_amount || 0).toFixed(2)}\n`;
    text += `GRAND TOTAL        : Rs. ${Number(saleDetail.grand_total || 0).toFixed(2)}\n`;
    text += `AMOUNT PAID        : Rs. ${Number(saleDetail.amount_paid || 0).toFixed(2)}\n`;
    text += `REMAINING DUE      : Rs. ${Number(saleDetail.amount_due || 0).toFixed(2)}\n`;

    if (saleDetail.previous_balance !== undefined && saleDetail.previous_balance !== null) {
      text += `PREVIOUS BALANCE   : Rs. ${Number(saleDetail.previous_balance || 0).toFixed(2)}\n`;
      text += `TOTAL CUMULATIVE   : Rs. ${Number(saleDetail.new_balance || 0).toFixed(2)}\n`;
    }

    text += `\n${line}\n`;
    text += `Thank you for shopping at Khushi Medical Hall!\n`;
    text += `All rights reserved | Software Developer: Muhammad Umar (03247077664)\n`;
    text += `====================================================\n`;

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Invoice_${saleDetail.invoice_number || Date.now()}_KhushiMedical.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Submit Sale Transaction
  const handleProcessSale = async () => {
    if (cart.length === 0) return;

    if ((paymentMethod === 'PARTIAL' || paymentMethod === 'UDHAR') && !selectedCustomer) {
      alert('Please select a customer for Partial or Udhar payment method!');
      return;
    }

    const numericAmountPaid = paymentMethod === 'UDHAR' ? 0 : Number(amountPaidInput || grandTotal);

    const salePayload = {
      customer_id: selectedCustomer?.id,
      items: cart,
      total_amount: cartSubtotal,
      discount_percent: overallDiscountPercent,
      discount_amount: cartItemDiscounts + overallDiscountAmount,
      net_amount: cartSubtotal - (cartItemDiscounts + overallDiscountAmount),
      total_gst: cartGstTotal,
      grand_total: grandTotal,
      payment_method: paymentMethod,
      amount_paid: numericAmountPaid
    };

    try {
      setSubmittingSale(true);
      let saleDetail: any = null;

      if (navigator.onLine) {
        try {
          const result = await api.createSale(salePayload);
          saleDetail = await api.getSaleDetail(result.sale_id);
        } catch (apiErr: any) {
          console.warn('Network API sale creation failed, saving offline:', apiErr);
          savePendingOfflineSale(salePayload);
          saleDetail = createLocalOfflineSaleDetail(salePayload);
        }
      } else {
        savePendingOfflineSale(salePayload);
        saleDetail = createLocalOfflineSaleDetail(salePayload);
      }

      // Automatically download sale invoice to local PC/device
      downloadSaleInvoiceFile(saleDetail);

      // Clear Cart & Draft
      setCart([]);
      clearDraftCart();
      setShowPaymentModal(false);

      // Show completed sale detail in thermal modal
      setCompletedSale(saleDetail);

      // Refresh inventory & customers list if online
      if (navigator.onLine) {
        fetchInitialData();
        if (onRefreshData) onRefreshData();
      }

    } catch (err: any) {
      alert(err.message || 'Error completing sale transaction');
    } finally {
      setSubmittingSale(false);
    }
  };

  const createLocalOfflineSaleDetail = (payload: any) => {
    const paid = payload.amount_paid || 0;
    return {
      id: 0,
      invoice_number: `OFFLINE-${Date.now().toString().slice(-6)}`,
      sale_date: new Date().toISOString(),
      customer_name: selectedCustomer?.name || 'Walk-in Customer',
      customer_phone: selectedCustomer?.phone,
      payment_method: paymentMethod,
      total_amount: cartSubtotal,
      discount_amount: cartItemDiscounts + overallDiscountAmount,
      net_amount: cartSubtotal - (cartItemDiscounts + overallDiscountAmount),
      grand_total: grandTotal,
      amount_paid: paid,
      amount_due: Math.max(0, grandTotal - paid),
      items: cart.map(item => ({
        product_name: item.product.name,
        quantity: item.quantity,
        sale_price: item.unit_price,
        subtotal: item.subtotal
      }))
    };
  };

  // Filtered Products
  const filteredProducts = React.useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q && selectedCategory === null) return products;
    return products.filter(p => {
      const matchesSearch = !q ||
                            (p.name || '').toLowerCase().includes(q) ||
                            (p.generic_name || '').toLowerCase().includes(q) ||
                            (p.barcode || '').toLowerCase().includes(q) ||
                            (p.batch_number && p.batch_number.toLowerCase().includes(q)) ||
                            (p.hsn_code && p.hsn_code.includes(q)) ||
                            String(p.id) === q;
      const matchesCategory = selectedCategory === null || p.category_id === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [products, searchQuery, selectedCategory]);

  return (
    <div className="space-y-2 select-none high-density-text">
      
      {/* Top Metric Cards - High Density Accent Left Borders */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="bg-white border-l-4 border-emerald-500 p-2 shadow-sm flex items-center justify-between rounded-r">
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-500">Total Products</div>
            <div className="text-base font-black text-slate-900 font-mono">{products.length}</div>
          </div>
          <span className="text-[10px] bg-emerald-100 text-emerald-800 font-bold px-1.5 py-0.5 rounded">
            Active Catalog
          </span>
        </div>

        <div className="bg-white border-l-4 border-orange-500 p-2 shadow-sm flex items-center justify-between rounded-r">
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-500">Low Stock Alerts</div>
            <div className="text-base font-black text-orange-600 font-mono">
              {products.filter(p => p.stock <= p.min_stock).length}
            </div>
          </div>
          <span className="text-[10px] bg-orange-100 text-orange-800 font-bold px-1.5 py-0.5 rounded">
            Restock Soon
          </span>
        </div>

        <div className="bg-white border-l-4 border-red-500 p-2 shadow-sm flex items-center justify-between rounded-r">
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-500">Out of Stock</div>
            <div className="text-base font-black text-red-600 font-mono">
              {products.filter(p => p.stock <= 0).length}
            </div>
          </div>
          <span className="text-[10px] bg-red-100 text-red-800 font-bold px-1.5 py-0.5 rounded">
            Critical
          </span>
        </div>

        <div className="bg-white border-l-4 border-blue-500 p-2 shadow-sm flex items-center justify-between rounded-r">
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-500">Registered Udhar Custs</div>
            <div className="text-base font-black text-blue-700 font-mono">{customers.length}</div>
          </div>
          <span className="text-[10px] bg-blue-100 text-blue-800 font-bold px-1.5 py-0.5 rounded">
            Khata Active
          </span>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-2">
        
        {/* LEFT PANE: Product Search & Catalog */}
        <div className="lg:w-7/12 space-y-2">
          
          {/* Draft Cart Restored Alert */}
          {hasDraft && (
            <div className="p-2.5 bg-amber-50 border-l-4 border-amber-500 rounded shadow-sm flex items-center justify-between text-amber-900 text-xs">
              <div className="flex items-center space-x-2">
                <AlertCircle className="w-4 h-4 text-amber-600" />
                <div>
                  <p className="font-bold">Draft Cart Recovered</p>
                  <p className="text-[10px] text-amber-700">Unsaved POS items from previous session found.</p>
                </div>
              </div>
              <div className="flex items-center space-x-1">
                <button 
                  onClick={handleRestoreDraft}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-2 py-1 rounded text-[10px]"
                >
                  Resume
                </button>
                <button 
                  onClick={handleDiscardDraft}
                  className="bg-slate-200 text-slate-700 hover:bg-slate-300 px-2 py-1 rounded text-[10px]"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          {/* Barcode Scanner Control Banner */}
          <div className="bg-gradient-to-r from-slate-900 to-emerald-950 text-white p-2.5 rounded-xl border border-emerald-800 shadow-md flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center space-x-2">
              <div className="bg-emerald-500/20 p-1.5 rounded-lg border border-emerald-500/40">
                <Barcode className="w-5 h-5 text-emerald-400 animate-pulse" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <span className="font-extrabold text-xs tracking-wide text-white">USB / CAMERA BARCODE SCANNER</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping mr-1"></span>
                    ACTIVE
                  </span>
                </div>
                <p className="text-[10px] text-slate-300">Point USB scanner or scan/type barcode & press Enter to add to cart instantly.</p>
              </div>
            </div>

            <div className="flex items-center space-x-1.5">
              {/* Print on Save Toggle */}
              <button
                type="button"
                onClick={() => setPrintOnSave(!printOnSave)}
                className={`p-1.5 rounded-lg text-xs font-bold flex items-center space-x-1 transition-all ${
                  printOnSave
                    ? 'bg-indigo-950 text-indigo-300 border border-indigo-700/80 shadow-sm'
                    : 'bg-slate-800 text-slate-400 border border-slate-700'
                }`}
                title="Toggle Auto Print Thermal Dialog on Sale Completion"
              >
                <Zap className={`w-3.5 h-3.5 ${printOnSave ? 'text-amber-400 fill-amber-400' : ''}`} />
                <span className="text-[10px]">{printOnSave ? 'Print on Save: ON' : 'Print on Save: OFF'}</span>
              </button>

              {/* Beep Audio Toggle */}
              <button
                type="button"
                onClick={() => setSoundEnabled(!soundEnabled)}
                className={`p-1.5 rounded-lg text-xs font-bold flex items-center space-x-1 transition-all ${
                  soundEnabled
                    ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700'
                    : 'bg-slate-800 text-slate-400 border border-slate-700'
                }`}
                title="Toggle Scan Beep Sound"
              >
                <Volume2 className="w-3.5 h-3.5" />
                <span className="text-[10px]">{soundEnabled ? 'Beep ON' : 'Beep OFF'}</span>
              </button>

              {/* Camera Scanner Button */}
              <button
                type="button"
                onClick={() => setShowCameraScanner(true)}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1 px-2.5 rounded-lg text-[10px] flex items-center space-x-1 shadow-sm transition-all"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>Camera Scan</span>
              </button>
            </div>
          </div>

          {/* Scan Notice Alert Banner */}
          {scanNotice && (
            <div className={`p-2 rounded-xl text-xs font-bold flex items-center justify-between shadow-sm ${
              scanNotice.type === 'success'
                ? 'bg-emerald-50 text-emerald-900 border border-emerald-300'
                : scanNotice.type === 'error'
                ? 'bg-rose-50 text-rose-900 border border-rose-300'
                : 'bg-amber-50 text-amber-900 border border-amber-300'
            }`}>
              <div className="flex items-center space-x-2">
                {scanNotice.type === 'success' && <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />}
                {scanNotice.type === 'error' && <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />}
                {scanNotice.type === 'warning' && <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />}
                <span>{scanNotice.message}</span>
              </div>
              <button onClick={() => setScanNotice(null)} className="text-slate-400 hover:text-slate-700 p-0.5">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Quick Barcode Sample Demo Chips */}
          <div className="bg-slate-50 p-2 rounded-xl border border-slate-200 flex items-center space-x-1.5 overflow-x-auto scrollbar-thin">
            <span className="text-[10px] font-black text-slate-500 uppercase shrink-0 flex items-center space-x-1">
              <Zap className="w-3 h-3 text-amber-500" />
              <span>Quick Test Scan:</span>
            </span>
            {products.slice(0, 5).map(prod => (
              <button
                key={prod.id}
                type="button"
                onClick={() => processBarcodeScan(prod.barcode || String(prod.id))}
                className="bg-white hover:bg-emerald-50 text-slate-800 hover:text-emerald-900 font-medium px-2 py-1 rounded-lg border border-slate-300 hover:border-emerald-400 text-[10px] whitespace-nowrap shadow-2xs flex items-center space-x-1 transition-colors"
                title={`Click to simulate barcode scan for ${prod.name} (${prod.barcode})`}
              >
                <Barcode className="w-3 h-3 text-emerald-600" />
                <span>{prod.name.split(' ')[0]} ({prod.barcode})</span>
              </button>
            ))}
          </div>

          {/* Search Bar & Scanner Input */}
          <div className="bg-white p-2.5 rounded border border-slate-300 shadow-sm space-y-2">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Scan Barcode or Search Medicine / Batch Number (Press Enter to scan)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchQuery.trim()) {
                      processBarcodeScan(searchQuery);
                    }
                  }
                }}
                className="w-full pl-8 pr-12 py-1.5 bg-slate-50 text-slate-900 placeholder-slate-400 rounded border border-slate-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 text-xs font-medium"
                autoFocus
              />
              {searchQuery && (
                <button 
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-2 text-slate-500 hover:text-slate-900 text-[10px] font-bold bg-slate-200 px-1.5 py-0.5 rounded"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Categories Pills */}
            <div className="flex items-center space-x-1.5 overflow-x-auto pb-0.5 scrollbar-thin">
              <button
                onClick={() => setSelectedCategory(null)}
                className={`px-2 py-1 rounded text-[10px] font-bold whitespace-nowrap transition-colors ${
                  selectedCategory === null
                    ? 'bg-emerald-700 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-300'
                }`}
              >
                All Categories
              </button>
              {categories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.id)}
                  className={`px-2 py-1 rounded text-[10px] font-bold whitespace-nowrap transition-colors ${
                    selectedCategory === cat.id
                      ? 'bg-emerald-700 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-300'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </div>

          {/* Product Catalogue Grid */}
          <div className="bg-white p-2 rounded border border-slate-300 shadow-sm min-h-[250px] max-h-[380px] sm:max-h-[460px] lg:max-h-[520px] overflow-y-auto scrollbar-thin">
            {loading ? (
              <div className="flex items-center justify-center py-20 text-slate-500 space-x-2">
                <RefreshCw className="w-4 h-4 animate-spin text-emerald-600" />
                <span>Loading Store Inventory...</span>
              </div>
            ) : filteredProducts.length === 0 ? (
              <div className="text-center py-16 text-slate-500 space-y-1">
                <Pill className="w-8 h-8 mx-auto text-slate-400" />
                <p className="font-bold text-slate-700">No matching medicines found</p>
                <p className="text-[10px]">Try searching with a different keyword or barcode.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                {filteredProducts.map(product => {
                  const isLowStock = product.stock <= product.min_stock;
                  const isOutOfStock = product.stock <= 0;

                  return (
                    <div
                      key={product.id}
                      onClick={() => handleAddToCart(product)}
                      className={`p-2 rounded border transition-all cursor-pointer flex flex-col justify-between ${
                        isOutOfStock
                          ? 'bg-slate-100 border-slate-300 opacity-60'
                          : 'bg-white border-slate-300 hover:border-emerald-600 hover:bg-emerald-50/50 shadow-2xs'
                      }`}
                    >
                      <div>
                        <div className="flex items-start justify-between gap-1">
                          <h4 className="font-bold text-slate-900 text-xs line-clamp-1">{product.name}</h4>
                          <span className="text-xs font-black text-emerald-800 bg-emerald-100 px-1.5 py-0.5 rounded border border-emerald-300 shrink-0 font-mono">
                            Rs.{product.sale_price}
                          </span>
                        </div>

                        <div className="text-[10px] text-slate-500 mt-0.5 flex items-center space-x-1.5 flex-wrap">
                          <span>Unit: {product.unit}</span>
                          <span>•</span>
                          <span>Batch: {product.batch_number || '-'}</span>
                          {product.barcode && (
                            <>
                              <span>•</span>
                              <span className="font-mono bg-slate-100 text-slate-700 px-1 py-0.2 rounded border border-slate-300 text-[9px] flex items-center space-x-0.5">
                                <Barcode className="w-2.5 h-2.5 text-emerald-600" />
                                <span>{product.barcode}</span>
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="mt-2 flex items-center justify-between text-[11px] pt-1 border-t border-slate-200">
                        <span className={`font-bold ${
                          isOutOfStock ? 'text-red-600' : isLowStock ? 'text-orange-600' : 'text-emerald-700'
                        }`}>
                          Stock: {product.stock} {product.unit}s
                        </span>

                        <button
                          disabled={isOutOfStock}
                          className={`px-2 py-0.5 rounded flex items-center space-x-1 font-bold text-[10px] ${
                            isOutOfStock
                              ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                              : 'bg-emerald-700 hover:bg-emerald-800 text-white'
                          }`}
                        >
                          <Plus className="w-3 h-3" />
                          <span>ADD</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT PANE: Active Cart & POS Checkout */}
        <div className="lg:w-5/12 bg-white rounded border border-slate-300 shadow-sm flex flex-col justify-between p-2 space-y-2">
          
          <div className="space-y-2">
            
            {/* Cart Header */}
            <div className="bg-emerald-50 p-2 rounded border border-emerald-200 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <ShoppingCart className="w-4 h-4 text-emerald-700" />
                <h3 className="font-bold text-slate-900 text-xs">ACTIVE POS CART ({cart.length})</h3>
              </div>

              {cart.length > 0 && (
                <button
                  onClick={() => setCart([])}
                  className="text-[10px] text-red-600 hover:text-red-800 font-bold flex items-center space-x-1 bg-red-50 px-1.5 py-0.5 rounded border border-red-200"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>CLEAR</span>
                </button>
              )}
            </div>

            {/* Customer Selection Bar */}
            <div className="bg-slate-50 p-2 rounded border border-slate-200 space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-bold text-slate-700 uppercase flex items-center space-x-1">
                  <User className="w-3 h-3 text-emerald-700" />
                  <span>CUSTOMER (ادھار کھاتہ)</span>
                </label>

                <button
                  onClick={() => setShowAddCustomerModal(true)}
                  className="text-[10px] text-emerald-700 hover:text-emerald-900 font-bold flex items-center space-x-0.5"
                >
                  <UserPlus className="w-3 h-3" />
                  <span>+ NEW CUST</span>
                </button>
              </div>

              <select
                value={selectedCustomer?.id || ''}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  const found = customers.find(c => c.id === id) || null;
                  setSelectedCustomer(found);
                }}
                className="w-full bg-white text-slate-900 text-xs p-1.5 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-medium"
              >
                <option value="">Walk-in Cash Customer (نقد گاہک)</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.phone}) - Udhar: Rs. {c.current_balance}
                  </option>
                ))}
              </select>

              {selectedCustomer && (
                <div className="text-[10px] bg-white p-1.5 rounded border border-slate-200 flex items-center justify-between text-slate-700 font-bold">
                  <span>Existing Udhar Credit:</span>
                  <span className={`font-mono ${Number(selectedCustomer.current_balance || 0) > 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                    Rs. {(Number(selectedCustomer.current_balance) || 0).toFixed(2)}
                  </span>
                </div>
              )}
            </div>

            {/* Cart Itemized List */}
            <div className="max-h-[220px] overflow-y-auto space-y-1.5 pr-0.5 scrollbar-thin">
              {cart.length === 0 ? (
                <div className="text-center py-10 text-slate-400 space-y-1">
                  <ShoppingCart className="w-6 h-6 mx-auto text-slate-300" />
                  <p className="text-xs font-bold text-slate-500">Cart is empty</p>
                  <p className="text-[10px]">Select medicines from the catalog on the left.</p>
                </div>
              ) : (
                cart.map(item => (
                  <div 
                    key={item.product.id}
                    className="bg-slate-50 p-2 rounded border border-slate-200 flex items-center justify-between text-xs"
                  >
                    <div className="flex-1 pr-2">
                      <div className="font-bold text-slate-900 text-xs">{item.product.name}</div>
                      <div className="text-[10px] text-slate-500 font-mono">
                        Rs.{item.unit_price} x {item.quantity} {item.product.unit}
                      </div>
                    </div>

                    {/* Manual Quantity Modifier */}
                    <div className="flex items-center space-x-1">
                      <button
                        onClick={() => updateCartQuantity(item.product.id, -1)}
                        title="Decrease Qty"
                        className="p-1 text-slate-600 hover:text-slate-900 bg-slate-200/80 hover:bg-slate-300 rounded"
                      >
                        <Minus className="w-2.5 h-2.5" />
                      </button>
                      <input
                        type="number"
                        min="1"
                        max={item.product.stock}
                        value={item.quantity}
                        onChange={(e) => setDirectCartQuantity(item.product.id, parseInt(e.target.value, 10))}
                        onFocus={(e) => e.target.select()}
                        className="w-12 bg-white text-slate-900 font-black text-xs py-0.5 px-1 text-center border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-600 font-mono"
                        title="Click to type quantity manually"
                      />
                      <button
                        onClick={() => updateCartQuantity(item.product.id, 1)}
                        title="Increase Qty"
                        className="p-1 text-slate-600 hover:text-slate-900 bg-slate-200/80 hover:bg-slate-300 rounded"
                      >
                        <Plus className="w-2.5 h-2.5" />
                      </button>
                    </div>

                    {/* Subtotal & Delete */}
                    <div className="text-right pl-2 min-w-[65px]">
                      <div className="font-black text-emerald-800 text-xs font-mono">Rs.{(Number(item.subtotal) || 0).toFixed(0)}</div>
                      <button
                        onClick={() => removeFromCart(item.product.id)}
                        className="text-[9px] text-red-600 hover:underline font-bold"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Bill Summary & Payment Trigger */}
          <div className="space-y-2 pt-2 border-t border-slate-200">
            
            <div className="bg-slate-900 text-white p-2.5 rounded space-y-1 font-mono">
              <div className="flex justify-between text-[11px] text-slate-300">
                <span>Subtotal:</span>
                <span>Rs. {(Number(cartSubtotal) || 0).toFixed(2)}</span>
              </div>

              {/* Overall Discount Input */}
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center space-x-1 text-slate-300">
                  <Percent className="w-3 h-3 text-emerald-400" />
                  <span>Discount (%):</span>
                </span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={overallDiscountPercent || ''}
                  onChange={(e) => setOverallDiscountPercent(Number(e.target.value) || 0)}
                  className="w-14 bg-slate-800 text-right text-emerald-300 font-bold px-1 py-0.5 rounded border border-slate-700 focus:outline-none focus:border-emerald-500 text-xs"
                  placeholder="0"
                />
              </div>

              {cartGstTotal > 0 && (
                <div className="flex justify-between text-[11px] text-slate-400">
                  <span>GST Tax:</span>
                  <span>+ Rs. {(Number(cartGstTotal) || 0).toFixed(2)}</span>
                </div>
              )}

              <div className="flex justify-between font-black text-sm text-white pt-1.5 border-t border-slate-800">
                <span>GRAND TOTAL:</span>
                <span className="text-emerald-400 text-base">Rs. {(Number(grandTotal) || 0).toFixed(2)}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <button
                disabled={cart.length === 0}
                onClick={() => {
                  setPaymentMethod('CASH');
                  setAmountPaidInput(String(grandTotal));
                  setShowPaymentModal(true);
                }}
                className={`py-2 px-2 rounded font-bold text-xs flex items-center justify-center space-x-1 transition-all ${
                  cart.length === 0
                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    : 'bg-emerald-700 hover:bg-emerald-800 text-white shadow-sm'
                }`}
              >
                <CreditCard className="w-3.5 h-3.5" />
                <span>CASH (نقد)</span>
              </button>

              <button
                disabled={cart.length === 0}
                onClick={() => {
                  setPaymentMethod('UDHAR');
                  setAmountPaidInput('0');
                  setShowPaymentModal(true);
                }}
                className={`py-2 px-2 rounded font-bold text-xs flex items-center justify-center space-x-1 transition-all ${
                  cart.length === 0
                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    : 'bg-slate-800 hover:bg-slate-900 text-white shadow-sm'
                }`}
              >
                <DollarSign className="w-3.5 h-3.5" />
                <span>UDHAR (ادھار)</span>
              </button>
            </div>
          </div>

        </div>

      </div>

      {/* PAYMENT MODAL */}
      {showPaymentModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl">
            
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="font-bold text-lg text-white">Payment & Billing Options</h3>
              <button onClick={() => setShowPaymentModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              
              {/* Payment Method Selector */}
              <div>
                <label className="block text-slate-300 font-semibold mb-2">Select Payment Method:</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod('CASH');
                      setAmountPaidInput(String(grandTotal));
                    }}
                    className={`py-2.5 px-2 rounded-xl font-bold border text-center text-xs transition-all ${
                      paymentMethod === 'CASH'
                        ? 'bg-emerald-600 border-emerald-500 text-white shadow-md'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    Full Cash (نقد)
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod('PARTIAL');
                      setAmountPaidInput(String(Math.round(grandTotal / 2)));
                    }}
                    className={`py-2.5 px-2 rounded-xl font-bold border text-center text-xs transition-all ${
                      paymentMethod === 'PARTIAL'
                        ? 'bg-amber-600 border-amber-500 text-white shadow-md'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    Partial (نقد + ادھار)
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod('UDHAR');
                      setAmountPaidInput('0');
                    }}
                    className={`py-2.5 px-2 rounded-xl font-bold border text-center text-xs transition-all ${
                      paymentMethod === 'UDHAR'
                        ? 'bg-rose-600 border-rose-500 text-white shadow-md'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    Full Udhar (ادھار)
                  </button>
                </div>
              </div>

              {/* Amount Paid Input */}
              {paymentMethod !== 'UDHAR' && (
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Cash Paid Now by Customer (Rs.):
                  </label>
                  <input
                    type="number"
                    value={amountPaidInput}
                    onChange={(e) => setAmountPaidInput(e.target.value)}
                    className="w-full bg-slate-800 text-white font-bold text-base p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              )}

              {/* Udhar Calculation Preview */}
              <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700 space-y-1.5">
                <div className="flex justify-between">
                  <span>Bill Grand Total:</span>
                  <span className="font-bold text-white">Rs. {(Number(grandTotal) || 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-emerald-400">
                  <span>Amount Paid:</span>
                  <span>Rs. {Number(amountPaidInput || 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-rose-400 font-bold border-t pt-1 border-slate-700">
                  <span>Remaining Udhar (ادھار):</span>
                  <span>Rs. {Math.max(0, grandTotal - Number(amountPaidInput || 0)).toFixed(2)}</span>
                </div>

                {selectedCustomer && (
                  <div className="text-[11px] text-slate-400 pt-1 border-t border-slate-700/50">
                    Customer: <span className="text-slate-200 font-semibold">{selectedCustomer.name}</span>
                  </div>
                )}
              </div>

              {/* Print on Save Quick Checkbox */}
              <div className="flex items-center justify-between p-2.5 bg-slate-800/60 rounded-xl border border-slate-700/80">
                <label htmlFor="modalPrintOnSave" className="flex items-center space-x-2 text-xs font-semibold text-slate-300 cursor-pointer">
                  <Zap className={`w-4 h-4 ${printOnSave ? 'text-amber-400 fill-amber-400' : 'text-slate-500'}`} />
                  <span>Print on Save (Auto-trigger thermal print)</span>
                </label>
                <input
                  id="modalPrintOnSave"
                  type="checkbox"
                  checked={printOnSave}
                  onChange={(e) => setPrintOnSave(e.target.checked)}
                  className="w-4 h-4 text-emerald-500 rounded bg-slate-900 border-slate-700 focus:ring-emerald-500"
                />
              </div>

              <button
                disabled={submittingSale}
                onClick={handleProcessSale}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl flex items-center justify-center space-x-2 transition-all shadow-lg shadow-emerald-950/60"
              >
                {submittingSale ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Saving Invoice...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    <span>Complete Sale & Print Receipt</span>
                  </>
                )}
              </button>

            </div>
          </div>
        </div>
      )}

      {/* QUICK ADD CUSTOMER MODAL */}
      {showAddCustomerModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={handleQuickAddCustomer} className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
            <h3 className="font-bold text-base text-white">Add New Customer</h3>
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Customer Full Name*:</label>
                <input
                  type="text"
                  required
                  value={newCustName}
                  onChange={(e) => setNewCustName(e.target.value)}
                  placeholder="e.g. Tariq Mahmood"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Phone Number* (03XX...):</label>
                <input
                  type="text"
                  required
                  value={newCustPhone}
                  onChange={(e) => setNewCustPhone(e.target.value)}
                  placeholder="03001234567"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Address / Town:</label>
                <input
                  type="text"
                  value={newCustAddress}
                  onChange={(e) => setNewCustAddress(e.target.value)}
                  placeholder="Main Bazaar, Lahore"
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex items-center space-x-2 pt-2">
              <button
                type="submit"
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-xl text-xs"
              >
                Save Customer
              </button>
              <button
                type="button"
                onClick={() => setShowAddCustomerModal(false)}
                className="bg-slate-800 text-slate-400 hover:text-white font-semibold py-2 px-3 rounded-xl text-xs"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* COMPLETED SALE THERMAL RECEIPT MODAL */}
      {completedSale && (
        <ThermalReceiptModal
          sale={completedSale}
          settings={settings}
          autoPrint={printOnSave}
          onClose={() => setCompletedSale(null)}
        />
      )}

      {/* CAMERA BARCODE SCANNER MODAL */}
      {showCameraScanner && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 text-white rounded-2xl border border-slate-800 shadow-2xl max-w-md w-full p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <Camera className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-sm text-white">Live Camera Barcode Scanner</h3>
              </div>
              <button
                onClick={() => setShowCameraScanner(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Video Feed / Viewport */}
            <div className="relative bg-black rounded-xl overflow-hidden min-h-[220px] border border-slate-800 flex items-center justify-center">
              <div id="camera-barcode-reader" className="w-full h-full min-h-[220px]"></div>
              
              {cameraError && (
                <div className="absolute inset-0 bg-slate-900/95 p-4 flex flex-col items-center justify-center text-center space-y-2 z-10">
                  <AlertCircle className="w-8 h-8 text-amber-400" />
                  <p className="text-xs text-slate-300 font-semibold">{cameraError}</p>
                  <p className="text-[11px] text-slate-400">You can also type or click any product below to simulate a scan.</p>
                </div>
              )}
            </div>

            {/* Direct Input & Quick Barcode Selector */}
            <div className="space-y-2">
              <label className="text-[11px] text-slate-300 font-bold">Type or select scanned barcode code:</label>
              <div className="flex space-x-2">
                <input
                  type="text"
                  placeholder="Enter barcode..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = (e.target as HTMLInputElement).value;
                      if (val) {
                        processBarcodeScan(val);
                        setShowCameraScanner(false);
                      }
                    }
                  }}
                  className="flex-1 bg-slate-800 text-white p-2 rounded-xl text-xs border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2">
                {products.slice(0, 4).map(p => (
                  <button
                    key={p.id}
                    onClick={() => {
                      processBarcodeScan(p.barcode || String(p.id));
                      setShowCameraScanner(false);
                    }}
                    className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-[10px] text-left border border-slate-700 flex items-center justify-between"
                  >
                    <span className="font-bold truncate">{p.name}</span>
                    <span className="font-mono text-emerald-400 text-[9px] shrink-0 ml-1">{p.barcode}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-800">
              <button
                onClick={() => setShowCameraScanner(false)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold px-4 py-2 rounded-xl text-xs"
              >
                Close Scanner
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
