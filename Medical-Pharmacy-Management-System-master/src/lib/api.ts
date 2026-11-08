import { User, Product, Category, Customer, LedgerEntry, SaleHeader, CartItem, SMSQueueItem, SystemSettings, Supplier, Tenant } from '../types';

const API_BASE = '/api';

export function getAuthToken(): string | null {
  return localStorage.getItem('khushi_token');
}

export function setAuthToken(token: string): void {
  localStorage.setItem('khushi_token', token);
}

export function removeAuthToken(): void {
  localStorage.removeItem('khushi_token');
  localStorage.removeItem('khushi_user');
}

export function getCurrentUser(): User | null {
  const data = localStorage.getItem('khushi_user');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function setCurrentUser(user: User): void {
  localStorage.setItem('khushi_user', JSON.stringify(user));
}

export function setSuperAdminBackup(token: string, user: User): void {
  localStorage.setItem('khushi_superadmin_backup_token', token);
  localStorage.setItem('khushi_superadmin_backup_user', JSON.stringify(user));
}

export function getSuperAdminBackup(): { token: string; user: User } | null {
  const token = localStorage.getItem('khushi_superadmin_backup_token');
  const userData = localStorage.getItem('khushi_superadmin_backup_user');
  if (!token || !userData) return null;
  try {
    return { token, user: JSON.parse(userData) };
  } catch {
    return null;
  }
}

export function clearSuperAdminBackup(): void {
  localStorage.removeItem('khushi_superadmin_backup_token');
  localStorage.removeItem('khushi_superadmin_backup_user');
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'An unexpected error occurred' }));
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  // Auth
  login: async (username: string, password: string) => {
    const data = await request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setAuthToken(data.token);
    setCurrentUser(data.user);
    return data;
  },
  sendLoginOtp: (email: string) =>
    request<{ message: string; otp_code?: string }>('/auth/send-login-otp', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  loginWithOtp: async (email: string, otp_code: string) => {
    const data = await request<{ token: string; user: User }>('/auth/login-otp', {
      method: 'POST',
      body: JSON.stringify({ email, otp_code }),
    });
    setAuthToken(data.token);
    setCurrentUser(data.user);
    return data;
  },
  sendOtp: (email: string) =>
    request<{ message: string; otp_code?: string }>('/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  register: (regData: { email: string; phone?: string; fullName: string; password: string; role: string; otp_code: string }) =>
    request<{ message: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(regData),
    }),
  registerStore: (data: { storeName: string; ownerName: string; ownerEmail: string; phone?: string; password: string; address?: string; city?: string; otp_code: string }) =>
    request<{ message: string; tenant_id: number }>('/auth/register-store', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getMe: () => request<{ user: User }>('/auth/me'),

  // Super Admin Methods (Supervisor & Platform Management)
  getSuperAdminMetrics: () => request<{ totalTenants: number; activeTenants: number; totalSales: number; totalRevenue: number; totalUsers: number }>('/superadmin/metrics'),
  getSuperAdminTenants: () => request<Tenant[]>('/superadmin/tenants'),
  getSuperAdminTenantDetails: (id: number) =>
    request<{
      tenant: Tenant;
      users: User[];
      sales: SaleHeader[];
      products: Product[];
      customers: Customer[];
      auditLogs: import('../types').AuditLog[];
    }>(`/superadmin/tenants/${id}/details`),
  updateTenantServices: (id: number, allowed_services: string[]) =>
    request<{ message: string; allowed_services: string }>(`/superadmin/tenants/${id}/services`, {
      method: 'PUT',
      body: JSON.stringify({ allowed_services }),
    }),
  createTenant: (data: { name: string; owner_name: string; owner_email: string; phone?: string; address?: string; city?: string; plan?: string }) =>
    request<{ message: string; tenant: Tenant }>('/superadmin/tenants', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateTenantStatus: (id: number, status: 'ACTIVE' | 'SUSPENDED' | 'PENDING') =>
    request<{ message: string }>(`/superadmin/tenants/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }),
  deleteTenant: (id: number) =>
    request<{ message: string }>(`/superadmin/tenants/${id}`, {
      method: 'DELETE',
    }),
  loginAsTenant: (id: number) =>
    request<{ message: string; token: string; user: User }>(`/superadmin/tenants/${id}/login-as`, {
      method: 'POST',
    }),
  sendSuperAdminMessage: (data: { targetTenantId?: number; recipientEmail?: string; subject: string; messageBody: string }) =>
    request<{ message: string }>('/superadmin/send-message', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // User Management (Admin Only)
  getUsers: () => request<User[]>('/users'),
  createSystemUser: (userData: { username: string; password: string; fullName: string; role: 'ADMIN' | 'STAFF' | 'CUSTOMER'; email?: string; phone?: string; allowed_services?: string[] }) =>
    request<{ message: string; user?: User }>('/users', {
      method: 'POST',
      body: JSON.stringify(userData),
    }),
  updateUserPermissions: (id: number, allowed_services: string[]) =>
    request<{ message: string; allowed_services: string }>(`/users/${id}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ allowed_services }),
    }),
  updateUserProfile: (id: number, userData: { fullName?: string; email?: string; phone?: string; role?: 'ADMIN' | 'STAFF' | 'CUSTOMER' }) =>
    request<{ message: string }>(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(userData),
    }),
  updateUserStatus: (id: number, status: 'APPROVED' | 'REJECTED' | 'PENDING' | 'SUSPENDED') =>
    request<{ message: string }>(`/users/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }),
  updateUserRole: (id: number, role: 'ADMIN' | 'STAFF' | 'CUSTOMER') =>
    request<{ message: string }>(`/users/${id}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }),
  resetUserPassword: (id: number, password: string) =>
    request<{ message: string }>(`/users/${id}/reset-password`, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    }),
  deleteUser: (id: number) =>
    request<{ message: string }>(`/users/${id}`, {
      method: 'DELETE',
    }),

  // Audit Logs (Admin Only)
  getAuditLogs: (params?: { search?: string; action_type?: string; tenant_id?: string | number; user_id?: string | number }) => {
    const query = new URLSearchParams();
    if (params?.search) query.append('search', params.search);
    if (params?.action_type) query.append('action_type', params.action_type);
    if (params?.tenant_id && params.tenant_id !== 'ALL') query.append('tenant_id', String(params.tenant_id));
    if (params?.user_id && params.user_id !== 'ALL') query.append('user_id', String(params.user_id));
    return request<import('../types').AuditLog[]>(`/audit-logs?${query.toString()}`);
  },
  clearAuditLogs: () =>
    request<{ message: string }>('/audit-logs/clear', {
      method: 'DELETE',
    }),

  // Inventory
  getInventory: (params?: { search?: string; category_id?: number; low_stock?: boolean; expiring?: boolean; expiry_days?: number }) => {
    const query = new URLSearchParams();
    if (params?.search) query.append('search', params.search);
    if (params?.category_id) query.append('category_id', String(params.category_id));
    if (params?.low_stock) query.append('low_stock', 'true');
    if (params?.expiring) query.append('expiring', 'true');
    if (params?.expiry_days) query.append('expiry_days', String(params.expiry_days));
    return request<Product[]>(`/inventory?${query.toString()}`);
  },
  addProduct: (productData: Partial<Product>) =>
    request<{ message: string }>('/inventory', {
      method: 'POST',
      body: JSON.stringify(productData),
    }),
  updateProduct: (id: number, productData: Partial<Product>) =>
    request<{ message: string }>(`/inventory/${id}`, {
      method: 'PUT',
      body: JSON.stringify(productData),
    }),
  deleteProduct: (id: number) =>
    request<{ message: string }>(`/inventory/${id}`, {
      method: 'DELETE',
    }),
  adjustStock: (productId: number, type: 'ADD' | 'REMOVE', quantity: number, reason: string) =>
    request<{ message: string; newStock: number }>('/inventory/adjust', {
      method: 'POST',
      body: JSON.stringify({ product_id: productId, adjustment_type: type, quantity, reason }),
    }),

  // Categories & Suppliers
  getCategories: () => request<Category[]>('/categories'),
  addCategory: (category: { name: string; description?: string }) =>
    request<Category>('/categories', {
      method: 'POST',
      body: JSON.stringify(category),
    }),
  getSuppliers: () => request<Supplier[]>('/suppliers'),
  addSupplier: (supplier: Partial<Supplier>) =>
    request<{ message: string; supplier?: Supplier }>('/suppliers', {
      method: 'POST',
      body: JSON.stringify(supplier),
    }),
  updateSupplier: (id: number, supplier: Partial<Supplier>) =>
    request<{ message: string }>(`/suppliers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(supplier),
    }),
  deleteSupplier: (id: number) =>
    request<{ message: string }>(`/suppliers/${id}`, {
      method: 'DELETE',
    }),

  // Customers & Ledger
  getCustomers: (search?: string) => {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    return request<Customer[]>(`/customers${query}`);
  },
  addCustomer: (customerData: { name: string; phone: string; address?: string; opening_balance?: number }) =>
    request<{ message: string }>('/customers', {
      method: 'POST',
      body: JSON.stringify(customerData),
    }),
  updateCustomer: (id: number, customerData: { name: string; phone: string; address?: string }) =>
    request<{ message: string }>(`/customers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(customerData),
    }),
  deleteCustomer: (id: number) =>
    request<{ message: string }>(`/customers/${id}`, {
      method: 'DELETE',
    }),
  getCustomerLedger: (customerId: number) =>
    request<{ customer: Customer; ledger: LedgerEntry[] }>(`/customers/${customerId}/ledger`),
  recordCustomerPayment: (customerId: number, amount: number, payment_mode: string, notes?: string) =>
    request<{ message: string; newBalance: number }>(`/customers/${customerId}/payment`, {
      method: 'POST',
      body: JSON.stringify({ amount, payment_mode, notes }),
    }),
  sendUdharReminder: (customerId: number, message?: string) =>
    request<{ message: string }>(`/customers/${customerId}/remind`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // Sales & POS
  createSale: (saleData: {
    customer_id?: number;
    items: CartItem[];
    total_amount: number;
    discount_percent: number;
    discount_amount: number;
    net_amount: number;
    total_gst: number;
    grand_total: number;
    payment_method: 'CASH' | 'PARTIAL' | 'UDHAR';
    amount_paid: number;
  }) =>
    request<{
      message: string;
      invoice_number: string;
      sale_id: number;
      grand_total: number;
      amount_paid: number;
      amount_due: number;
      previous_balance: number;
      new_balance: number;
    }>('/sales', {
      method: 'POST',
      body: JSON.stringify(saleData),
    }),

  getFullSalesHistory: (start_date?: string, end_date?: string, customer_id?: number) => {
    const query = new URLSearchParams();
    if (start_date) query.append('start_date', start_date);
    if (end_date) query.append('end_date', end_date);
    if (customer_id) query.append('customer_id', String(customer_id));
    query.append('include_items', 'true');
    return request<SaleHeader[]>(`/sales/history?${query.toString()}`);
  },
  getSalesHistory: (start_date?: string, end_date?: string, customer_id?: number) => {
    const query = new URLSearchParams();
    if (start_date) query.append('start_date', start_date);
    if (end_date) query.append('end_date', end_date);
    if (customer_id) query.append('customer_id', String(customer_id));
    return request<SaleHeader[]>(`/sales/history?${query.toString()}`);
  },

  getSaleDetail: (saleId: number) => request<SaleHeader & { items: any[] }>(`/sales/${saleId}`),
  deleteSale: (saleId: number) =>
    request<{ message: string }>(`/sales/${saleId}`, {
      method: 'DELETE',
    }),

  // Purchase & Stock In
  // Purchases & POs
  getPurchases: () => request<any[]>('/purchases'),
  getPurchaseDetails: (id: number) => request<any>(`/purchases/${id}`),
  recordPurchase: (purchaseData: { supplier_id: number; invoice_number?: string; items: any[]; notes?: string }) =>
    request<{ message: string; id?: number; invoice_number?: string }>('/purchases', {
      method: 'POST',
      body: JSON.stringify(purchaseData),
    }),
  emailPurchaseOrder: (poData: { supplier_id: number; supplier_email?: string; po_number: string; subject?: string; message?: string; items_summary?: string }) =>
    request<{ message: string }>('/purchases/email-po', {
      method: 'POST',
      body: JSON.stringify(poData),
    }),

  // Reports
  getDashboardStats: () =>
    request<import('../types').DashboardStats>('/reports/dashboard'),

  getSalesReport: (start_date?: string, end_date?: string, group_by?: 'daily' | 'monthly' | 'yearly') => {
    const query = new URLSearchParams();
    if (start_date) query.append('start_date', start_date);
    if (end_date) query.append('end_date', end_date);
    if (group_by) query.append('group_by', group_by);
    return request<any[]>(`/reports/sales?${query.toString()}`);
  },

  getTopProducts: () => request<any[]>('/reports/top-products'),

  // Email Notifications
  getEmailQueue: () => request<import('../types').EmailQueueItem[]>('/email/queue'),
  processEmailQueue: () =>
    request<{ message: string }>('/email/process', {
      method: 'POST',
    }),
  deleteEmailQueueItem: (id: number) =>
    request<{ message: string }>(`/email/queue/${id}`, {
      method: 'DELETE',
    }),
  clearEmailQueue: () =>
    request<{ message: string }>('/email/queue', {
      method: 'DELETE',
    }),
  updateEmailQueueItem: (id: number, data: { email: string; subject: string; message: string; status: string }) =>
    request<{ message: string }>(`/email/queue/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Legacy SMS Alias
  getSMSQueue: () => request<SMSQueueItem[]>('/sms/queue'),
  processSMSQueue: () =>
    request<{ message: string }>('/sms/process', {
      method: 'POST',
    }),
  deleteSMSQueueItem: (id: number) =>
    request<{ message: string }>(`/sms/queue/${id}`, {
      method: 'DELETE',
    }),
  clearSMSQueue: () =>
    request<{ message: string }>('/sms/queue', {
      method: 'DELETE',
    }),
  updateSMSQueueItem: (id: number, data: { phone: string; message: string; status: string }) =>
    request<{ message: string }>(`/sms/queue/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Settings & Encrypted Backup
  getSettings: () => request<Record<string, string>>('/settings'),
  saveSettings: (settings: Record<string, string>) =>
    request<{ message: string }>('/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  testSmtp: (testEmail?: string) =>
    request<{ message: string }>('/settings/test-smtp', {
      method: 'POST',
      body: JSON.stringify({ testEmail }),
    }),
  exportBackup: (password: string) =>
    request<any>('/backup/export', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  importBackup: (backupPayload: any, password: string) =>
    request<{ message: string }>('/backup/import', {
      method: 'POST',
      body: JSON.stringify({ backupPayload, password }),
    }),

  // Customer Portal (Restricted view)
  getCustomerPortalData: () =>
    request<{ customer: Customer; recentInvoices: SaleHeader[]; ledger: LedgerEntry[] }>('/customer-portal/me'),
};

// Local Draft Cart Auto-Save Utility
const DRAFT_CART_KEY = 'khushi_pos_draft_cart';
const OFFLINE_SALES_KEY = 'khushi_pending_offline_sales';

export interface OfflinePendingSale {
  id: string;
  saleData: any;
  timestamp: string;
}

export function getPendingOfflineSales(): OfflinePendingSale[] {
  try {
    const raw = localStorage.getItem(OFFLINE_SALES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function savePendingOfflineSale(saleData: any): OfflinePendingSale {
  const pending = getPendingOfflineSales();
  const newItem: OfflinePendingSale = {
    id: `OFFLINE-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    saleData,
    timestamp: new Date().toISOString(),
  };
  pending.push(newItem);
  try {
    localStorage.setItem(OFFLINE_SALES_KEY, JSON.stringify(pending));
  } catch (e) {
    console.error('Error saving pending offline sale', e);
  }
  return newItem;
}

export function removePendingOfflineSale(id: string): void {
  const pending = getPendingOfflineSales().filter(item => item.id !== id);
  try {
    localStorage.setItem(OFFLINE_SALES_KEY, JSON.stringify(pending));
  } catch (e) {
    console.error('Error removing pending offline sale', e);
  }
}

export async function syncPendingOfflineSales(): Promise<{ synced: number; remaining: number }> {
  const pending = getPendingOfflineSales();
  if (pending.length === 0) return { synced: 0, remaining: 0 };

  let synced = 0;
  for (const item of pending) {
    try {
      await api.createSale(item.saleData);
      removePendingOfflineSale(item.id);
      synced++;
    } catch (err) {
      console.error(`Failed to sync offline sale ${item.id}`, err);
    }
  }

  const remaining = getPendingOfflineSales().length;
  return { synced, remaining };
}

export function saveDraftCart(cart: CartItem[], customerId?: number, discountPercent: number = 0): void {
  try {
    localStorage.setItem(
      DRAFT_CART_KEY,
      JSON.stringify({
        cart,
        customerId,
        discountPercent,
        timestamp: new Date().toISOString(),
      })
    );
  } catch (e) {
    console.error('Failed to save draft cart', e);
  }
}

export function loadDraftCart(): { cart: CartItem[]; customerId?: number; discountPercent: number } | null {
  try {
    const raw = localStorage.getItem(DRAFT_CART_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearDraftCart(): void {
  localStorage.removeItem(DRAFT_CART_KEY);
}
