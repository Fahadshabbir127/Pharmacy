export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'STAFF' | 'CUSTOMER';
export type UserStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export interface Tenant {
  id: number;
  name: string;
  owner_name: string;
  owner_email: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  currency?: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING';
  plan: 'FREE_TRIAL' | 'PRO' | 'ENTERPRISE';
  max_users?: number;
  max_products?: number;
  allowed_services?: string;
  created_at?: string;
  user_count?: number;
  product_count?: number;
  sales_total?: number;
}

export interface User {
  id: number;
  username: string;
  role: UserRole;
  fullName?: string;
  full_name?: string;
  email?: string;
  phone?: string;
  tenant_id?: number | null;
  tenant_name?: string;
  tenant_status?: string;
  allowed_services?: string;
  customerId?: number;
  customer_id?: number;
  status?: UserStatus;
  created_at?: string;
}

export interface AuditLog {
  id: number;
  user_id?: number;
  user_name?: string;
  action_type: string;
  description: string;
  target_type?: string;
  target_id?: number;
  ip_address?: string;
  user_agent?: string;
  tenant_id?: number;
  store_name?: string;
  created_at: string;
}

export interface Category {
  id: number;
  name: string;
  description?: string;
}

export interface Supplier {
  id: number;
  name: string;
  phone: string;
  company: string;
  address?: string;
}

export interface Product {
  id: number;
  name: string;
  unit: string; // Piece, Pack, Bottle, Box, Strip, Flacon, etc.
  purchase_price: number;
  sale_price: number;
  min_stock: number;
  stock: number;
  batch_number: string;
  expiry_date: string; // YYYY-MM-DD
  category_id: number;
  category_name?: string;
  hsn_code: string;
  gst_rate: number; // percentage e.g. 0, 5, 18
  rack_location: string;
  barcode?: string;
  supplier_id?: number;
  supplier_name?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  address: string;
  opening_balance: number;
  current_balance: number; // Positive = Customer owes money (Udhar)
  login_id?: string;
  created_at?: string;
}

export interface LedgerEntryItem {
  product_name: string;
  quantity: number;
  unit: string;
  sale_price: number;
  subtotal: number;
}

export interface LedgerEntry {
  id: number;
  customer_id: number;
  transaction_date: string;
  type: 'SALE' | 'PAYMENT' | 'ADJUSTMENT';
  reference: string; // e.g. "Invoice #INV-1002" or "Cash Payment"
  debit: number; // Increase in debt
  credit: number; // Decrease in debt
  balance_after: number;
  notes?: string;
  sale_id?: number;
  items?: LedgerEntryItem[];
}

export type PaymentMethod = 'CASH' | 'PARTIAL' | 'UDHAR';

export interface CartItem {
  product: Product;
  quantity: number;
  unit_price: number;
  discount_percent: number;
  discount_amount: number;
  gst_percent: number;
  gst_amount: number;
  subtotal: number;
}

export interface SaleHeader {
  id: number;
  invoice_number: string;
  customer_id?: number;
  customer_name?: string;
  customer_phone?: string;
  sale_date: string;
  total_amount: number;
  discount_percent: number;
  discount_amount: number;
  net_amount: number;
  total_gst: number;
  grand_total: number;
  payment_method: PaymentMethod;
  amount_paid: number;
  amount_due: number;
  payment_status: 'PAID' | 'PARTIAL' | 'UNPAID';
  created_by_user_id: number;
  created_by_name?: string;
  previous_balance?: number;
  new_balance?: number;
  items?: SaleItem[];
}

export interface SaleItem {
  id: number;
  sale_id: number;
  product_id: number;
  product_name: string;
  quantity: number;
  unit: string;
  sale_price: number;
  cost_price: number;
  discount_percent: number;
  discount_amount: number;
  gst_amount: number;
  batch_number: string;
  expiry_date: string;
  subtotal: number;
}

export interface PurchaseHeader {
  id: number;
  invoice_number: string;
  supplier_id: number;
  supplier_name?: string;
  purchase_date: string;
  total_amount: number;
  notes?: string;
  items?: PurchaseItem[];
}

export interface PurchaseItem {
  id: number;
  purchase_id: number;
  product_id: number;
  product_name?: string;
  quantity: number;
  purchase_price: number;
  batch_number: string;
  expiry_date: string;
}

export interface StockAdjustment {
  id: number;
  product_id: number;
  product_name?: string;
  adjustment_type: 'ADD' | 'REMOVE';
  quantity: number;
  reason: string;
  created_at: string;
  user_id: number;
}

export interface EmailQueueItem {
  id: number;
  customer_id: number;
  customer_name?: string;
  email: string;
  subject: string;
  message: string;
  type: 'UDHAR_REMINDER' | 'PAYMENT_CONFIRMATION' | 'WELCOME' | 'ACCOUNT_APPROVED';
  status: 'PENDING' | 'SENT' | 'FAILED';
  error_message?: string;
  created_at: string;
  sent_at?: string;
}

export interface SMSQueueItem {
  id: number;
  customer_id: number;
  customer_name?: string;
  phone: string;
  message: string;
  type: 'UDHAR_REMINDER' | 'PAYMENT_CONFIRMATION' | 'WELCOME';
  status: 'PENDING' | 'SENT' | 'FAILED';
  error_message?: string;
  created_at: string;
  sent_at?: string;
}

export interface SystemSettings {
  store_name: string;
  store_urdu_name: string;
  address: string;
  phone: string;
  ntn_number: string;
  receipt_footer: string;
  printer_type: 'THERMAL_80MM' | 'THERMAL_58MM' | 'PDF';
  printer_address: string;
  twilio_account_sid: string;
  twilio_auth_token: string;
  twilio_from_phone: string;
  sms_enabled: boolean;
  auto_backup_enabled: boolean;
  backup_interval_hours: number;
}

export interface DashboardStats {
  todaySalesTotal: number;
  todaySalesCount: number;
  todayGrossProfit: number;
  monthSalesTotal: number;
  monthSalesCount: number;
  monthGrossProfit: number;
  yearSalesTotal: number;
  yearSalesCount: number;
  yearGrossProfit: number;
  totalUdharBalance: number;
  lowStockCount: number;
  expiringCount: number;
  totalProductsCount: number;
  totalCustomersCount: number;
}
