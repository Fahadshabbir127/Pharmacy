import React, { useState, useEffect } from 'react';
import { 
  Building2, Users, ShoppingBag, DollarSign, ShieldAlert, CheckCircle2, 
  XCircle, Plus, Search, RefreshCw, AlertTriangle, ShieldCheck, Lock, ExternalLink,
  Mail, MessageSquare, Send, LogIn, Save, Shield
} from 'lucide-react';
import { api, getAuthToken, setAuthToken, setCurrentUser, setSuperAdminBackup } from '../lib/api';
import { Tenant, User } from '../types';

interface Metrics {
  totalTenants: number;
  activeTenants: number;
  totalSales: number;
  totalRevenue: number;
  totalUsers: number;
}

interface SuperAdminScreenProps {
  currentUser: User;
}

const ALL_AVAILABLE_SERVICES = [
  { id: 'POS_BILLING', name: 'POS & Billing', desc: 'Counter billing, POS receipt printing, sale discount controls' },
  { id: 'INVENTORY', name: 'Inventory & Stock', desc: 'Medicine management, stock levels, batch numbers, expiry tracking' },
  { id: 'UDHAR_KHATTA', name: 'Customers & Udhar Khatta', desc: 'Customer ledgers, credit tracking, payment history' },
  { id: 'PURCHASES', name: 'Purchases & Stock-In', desc: 'Supplier purchase invoices, bulk stock addition' },
  { id: 'REPORTS', name: 'Sales & Profit Analytics', desc: 'Daily revenue, net profit calculations, sales reports' },
  { id: 'EMAIL_ALERTS', name: 'Email Alert Center', desc: 'Low stock alerts and automatic daily/weekly email notifications' },
  { id: 'USER_VERIFY', name: 'User Management & Approvals', desc: 'Staff account creation, permissions and status verification' },
  { id: 'AUDIT_LOGS', name: 'System Audit Logs', desc: 'Security logging, user action tracking and audit history' },
  { id: 'SETTINGS', name: 'Settings & Backups', desc: 'Store customization, print headers, DB backup & restoration' },
  { id: 'CUSTOMER_PORTAL', name: 'Customer Self-Service Portal', desc: 'Customer digital ledger access via unique OTP' },
];

export const SuperAdminScreen: React.FC<SuperAdminScreenProps> = ({ currentUser }) => {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Store Profile Modal State
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null);
  const [profileLoading, setProfileLoading] = useState<boolean>(false);
  const [profileData, setProfileData] = useState<{
    tenant: Tenant;
    users: User[];
    sales: any[];
    products: any[];
    customers: any[];
    auditLogs: any[];
  } | null>(null);
  const [activeProfileTab, setActiveProfileTab] = useState<'SERVICES' | 'BILLING' | 'INVENTORY' | 'CUSTOMERS' | 'USERS' | 'AUDIT'>('SERVICES');
  const [allowedServicesMap, setAllowedServicesMap] = useState<{ [key: string]: boolean }>({});
  const [savingServices, setSavingServices] = useState<boolean>(false);
  const [servicesMsg, setServicesMsg] = useState<string | null>(null);

  // Direct Message to Shopkeepers State
  const [showMessageModal, setShowMessageModal] = useState<boolean>(false);
  const [msgTargetTenantId, setMsgTargetTenantId] = useState<number | undefined>(undefined);
  const [msgTargetName, setMsgTargetName] = useState<string>('All Active Shopkeepers');
  const [msgSubject, setMsgSubject] = useState<string>('');
  const [msgBody, setMsgBody] = useState<string>('');
  const [sendingMsg, setSendingMsg] = useState<boolean>(false);
  const [msgNotice, setMsgNotice] = useState<string | null>(null);

  // Settings & SMTP State
  const [globalSettings, setGlobalSettings] = useState<Record<string, string>>({});
  const [savingGlobalSettings, setSavingGlobalSettings] = useState<boolean>(false);
  const [globalSettingsMsg, setGlobalSettingsMsg] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState<string>('');
  const [testingSmtp, setTestingSmtp] = useState<boolean>(false);
  const [smtpTestResult, setSmtpTestResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // New Store Form State
  const [formData, setFormData] = useState({
    name: '',
    owner_name: '',
    owner_email: '',
    password: '',
    phone: '',
    address: '',
    city: 'Lahore',
    plan: 'PRO'
  });

  const handleOpenSendMessage = (tenantId?: number, storeName?: string) => {
    setMsgTargetTenantId(tenantId);
    setMsgTargetName(storeName ? `Store #${tenantId}: ${storeName}` : 'All Registered Active Shopkeepers (Broadcast)');
    setMsgSubject('');
    setMsgBody('');
    setMsgNotice(null);
    setShowMessageModal(true);
  };

  const applyTemplateToMessage = (tmplKey: string) => {
    if (tmplKey === 'UDHAR_REMINDER') {
      setMsgSubject('Udhar Account Payment Reminder (ادھار یاد دہانی نوٹس)');
      setMsgBody(globalSettings.msg_template_udhar_reminder || 'محترم {name} صاحب! خوشی میڈیکل ہال پر آپ کا بقیہ ادھار رقم Rs. {balance} ہے۔ برائے مہربانی اپنا ادھار کھاتہ جلد از جلد صاف فرمائیں۔ شکریہ! - Khushi Medical Hall');
    } else if (tmplKey === 'PAYMENT_RECEIPT') {
      setMsgSubject('Payment Received Confirmation (رقم وصولی کی تصدیق)');
      setMsgBody(globalSettings.msg_template_payment_receipt || 'محترم {name}! خوشی میڈیکل ہال میں آپ کی طرف سے رقم موصول ہو گئی ہے۔ آپ کا بقیہ کھاتہ Rs. {balance} ہے۔ شکریہ! - Khushi Medical Hall');
    } else if (tmplKey === 'REFILL') {
      setMsgSubject('Prescription Medicine Refill Reminder (دوائی ختم ہونے کا نوٹس)');
      setMsgBody(globalSettings.msg_template_refill || 'Dear {name}, your regular medicine prescription stock at Khushi Medical Hall may be finishing soon. Visit us today for fresh refill & discounts! - Khushi Medical Hall');
    } else if (tmplKey === 'ANNOUNCEMENT') {
      setMsgSubject('Platform Software Update & Store Announcement');
      setMsgBody('Dear Shopkeeper, please be informed that platform maintenance and feature updates have been applied to your store system portal.');
    }
  };

  const handleSendSuperAdminMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!msgSubject.trim() || !msgBody.trim()) {
      setMsgNotice('Message subject and content body are required.');
      return;
    }
    setSendingMsg(true);
    setMsgNotice(null);
    try {
      const res = await api.sendSuperAdminMessage({
        targetTenantId: msgTargetTenantId,
        subject: msgSubject,
        messageBody: msgBody,
      });
      setSuccessMsg(res.message);
      setShowMessageModal(false);
    } catch (err: any) {
      setMsgNotice(err.message || 'Failed to dispatch message to shopkeeper.');
    } finally {
      setSendingMsg(false);
    }
  };

  const handleSaveGlobalSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingGlobalSettings(true);
    setGlobalSettingsMsg(null);
    try {
      await api.saveSettings(globalSettings);
      setGlobalSettingsMsg('Super Admin prewritten messages & SMTP configurations saved successfully!');
    } catch (err: any) {
      alert(err.message || 'Error saving global settings');
    } finally {
      setSavingGlobalSettings(false);
    }
  };

  const handleTestSmtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testEmail) return;
    setTestingSmtp(true);
    setSmtpTestResult(null);
    try {
      const res = await api.testSmtp(testEmail);
      setSmtpTestResult({ type: 'success', message: res.message });
    } catch (err: any) {
      setSmtpTestResult({ type: 'error', message: err.message || 'SMTP Gateway test failed.' });
    } finally {
      setTestingSmtp(false);
    }
  };

  const fetchSuperAdminData = async () => {
    setLoading(true);
    try {
      const [m, t, s] = await Promise.all([
        api.getSuperAdminMetrics(),
        api.getSuperAdminTenants(),
        api.getSettings().catch(() => ({}))
      ]);
      setMetrics(m);
      setTenants(t);
      setGlobalSettings(s || {});
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to load Super Admin dashboard data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSuperAdminData();
  }, []);

  const handleOpenStoreProfile = async (tenantId: number) => {
    setSelectedTenantId(tenantId);
    setProfileLoading(true);
    setProfileData(null);
    setServicesMsg(null);
    try {
      const details = await api.getSuperAdminTenantDetails(tenantId);
      setProfileData(details);

      const activeServices = (details.tenant.allowed_services || 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES,REPORTS,EMAIL_ALERTS,USER_VERIFY,USER_REGISTER,USER_RESET_PASSWORD,AUDIT_LOGS,SETTINGS,CUSTOMER_PORTAL').split(',');
      const map: { [key: string]: boolean } = {};
      ALL_AVAILABLE_SERVICES.forEach(s => {
        map[s.id] = activeServices.includes(s.id);
      });
      setAllowedServicesMap(map);
    } catch (err: any) {
      alert(err.message || 'Failed to load store profile details.');
    } finally {
      setProfileLoading(false);
    }
  };

  const handleSaveServices = async () => {
    if (!selectedTenantId) return;
    setSavingServices(true);
    setServicesMsg(null);
    try {
      const selectedList = Object.keys(allowedServicesMap).filter(k => allowedServicesMap[k]);
      const res = await api.updateTenantServices(selectedTenantId, selectedList);
      setServicesMsg('Service permissions saved successfully!');
      
      // Update local tenant list
      setTenants(prev => prev.map(t => t.id === selectedTenantId ? { ...t, allowed_services: res.allowed_services } : t));
      if (profileData) {
        setProfileData({ ...profileData, tenant: { ...profileData.tenant, allowed_services: res.allowed_services } });
      }
    } catch (err: any) {
      alert(err.message || 'Error updating service permissions');
    } finally {
      setSavingServices(false);
    }
  };

  const handleCreateTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await api.createTenant(formData);
      setSuccessMsg(res.message);
      setShowAddModal(false);
      setFormData({
        name: '',
        owner_name: '',
        owner_email: '',
        password: '',
        phone: '',
        address: '',
        city: 'Lahore',
        plan: 'PRO'
      });
      fetchSuperAdminData();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to create shop account.');
    }
  };

  const handleToggleStatus = async (tenantId: number, currentStatus: string) => {
    const newStatus = currentStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    const actionText = newStatus === 'SUSPENDED' ? 'SUSPEND store access' : 'ACTIVATE store access';
    if (!confirm(`Are you sure you want to ${actionText} for this store?`)) return;

    try {
      await api.updateTenantStatus(tenantId, newStatus);
      setTenants(prev => prev.map(t => t.id === tenantId ? { ...t, status: newStatus } : t));
      if (profileData && profileData.tenant.id === tenantId) {
        setProfileData({ ...profileData, tenant: { ...profileData.tenant, status: newStatus } });
      }
      fetchSuperAdminData();
    } catch (err: any) {
      alert(err.message || 'Error updating store status');
    }
  };

  const handleDeleteTenant = async (tenantId: number, storeName: string) => {
    if (!confirm(`CRITICAL WARNING: Are you sure you want to PERMANENTLY DELETE store "${storeName}" and all its inventory & sales records? This action cannot be undone.`)) return;

    try {
      await api.deleteTenant(tenantId);
      setTenants(prev => prev.filter(t => t.id !== tenantId));
      if (selectedTenantId === tenantId) {
        setSelectedTenantId(null);
        setProfileData(null);
      }
      fetchSuperAdminData();
    } catch (err: any) {
      alert(err.message || 'Error deleting store');
    }
  };

  const handleJumpToStore = async (tenantId: number, storeName: string) => {
    if (!confirm(`Jump directly into store account "${storeName}" as Admin?`)) return;
    try {
      const backupToken = getAuthToken();
      if (backupToken && currentUser) {
        setSuperAdminBackup(backupToken, currentUser);
      }
      const res = await api.loginAsTenant(tenantId);
      setAuthToken(res.token);
      setCurrentUser(res.user);
      window.location.reload();
    } catch (err: any) {
      alert(err.message || `Failed to jump into store ${storeName}`);
    }
  };

  const filteredTenants = tenants.filter(t => 
    t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.owner_email.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.owner_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-emerald-950 via-slate-900 to-slate-900 border border-emerald-800/60 rounded-2xl p-6 shadow-2xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2 text-emerald-400 font-bold text-xs uppercase tracking-wider mb-1">
            <ShieldCheck className="w-4 h-4" />
            <span>SaaS Platform Control Center</span>
          </div>
          <h1 className="text-2xl font-black text-white tracking-tight">Super Admin Supervision & Management</h1>
          <p className="text-slate-400 text-xs mt-1">
            Logged in as <span className="text-emerald-300 font-semibold">{currentUser.email || currentUser.username}</span> (Protected Super Supervisor)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => handleOpenSendMessage()}
            className="bg-emerald-950 hover:bg-emerald-900 text-emerald-300 text-xs font-semibold px-3.5 py-2.5 rounded-xl border border-emerald-800 flex items-center space-x-2 transition-all shadow-md"
          >
            <Mail className="w-4 h-4 text-emerald-400" />
            <span>Message Shopkeepers</span>
          </button>
          <button
            onClick={fetchSuperAdminData}
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-3 py-2.5 rounded-xl border border-slate-700 flex items-center space-x-2"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-emerald-400' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-4 py-2.5 rounded-xl shadow-lg shadow-emerald-950/50 flex items-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>Onboard New Store</span>
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="bg-rose-950/80 border border-rose-800 text-rose-300 p-4 rounded-xl text-xs flex items-center space-x-3">
          <AlertTriangle className="w-5 h-5 shrink-0 text-rose-400" />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="bg-emerald-950/80 border border-emerald-800 text-emerald-300 p-4 rounded-xl text-xs flex items-center space-x-3">
          <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-2">
            <span>Total Shops</span>
            <Building2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-black text-white">{metrics?.totalTenants || 0}</div>
          <div className="text-[11px] text-slate-500 mt-1">Registered Pharmacies</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-2">
            <span>Active Shops</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-black text-emerald-400">{metrics?.activeTenants || 0}</div>
          <div className="text-[11px] text-slate-500 mt-1">Fully Operational</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-2">
            <span>Platform Users</span>
            <Users className="w-4 h-4 text-blue-400" />
          </div>
          <div className="text-2xl font-black text-white">{metrics?.totalUsers || 0}</div>
          <div className="text-[11px] text-slate-500 mt-1">Owners & Staff</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-2">
            <span>Global Sales</span>
            <ShoppingBag className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-black text-white">{metrics?.totalSales || 0}</div>
          <div className="text-[11px] text-slate-500 mt-1">Transactions Processed</div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-2xl col-span-2 lg:col-span-1">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-2">
            <span>Total GMV Volume</span>
            <DollarSign className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-black text-emerald-400">
            Rs. {(metrics?.totalRevenue || 0).toLocaleString()}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Platform Revenue Volume</div>
        </div>
      </div>

      {/* Main Table Section */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center space-x-2">
              <Building2 className="w-5 h-5 text-emerald-400" />
              <span>Registered Stores & Shopkeepers</span>
            </h2>
            <p className="text-slate-400 text-xs mt-0.5">
              Supervise all registered store accounts, isolate store access, or toggle operational status.
            </p>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search store, owner or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-800 text-slate-100 text-xs pl-9 pr-3 py-2 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950 text-slate-400 uppercase font-semibold border-b border-slate-800">
              <tr>
                <th className="p-3 hidden sm:table-cell">Store ID</th>
                <th className="p-3">Store Name</th>
                <th className="p-3">Shopkeeper / Owner</th>
                <th className="p-3 hidden md:table-cell">Location</th>
                <th className="p-3 hidden lg:table-cell">Stats</th>
                <th className="p-3">Sales Volume</th>
                <th className="p-3 hidden sm:table-cell">Status</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredTenants.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-8 text-slate-500 text-xs">
                    No stores found matching search filter.
                  </td>
                </tr>
              ) : (
                filteredTenants.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="p-3 font-mono font-bold text-slate-400 hidden sm:table-cell">#{t.id}</td>
                    <td className="p-3">
                      <div className="font-bold text-white text-sm">{t.name}</div>
                      <div className="text-[11px] text-slate-400">{t.plan} Plan</div>
                      <div className="sm:hidden mt-1">
                        {t.status === 'ACTIVE' ? (
                          <span className="text-[10px] text-emerald-400 font-semibold">Active</span>
                        ) : (
                          <span className="text-[10px] text-rose-400 font-semibold">Suspended</span>
                        )}
                      </div>
                    </td>
                    <td className="p-3">
                      <div className="font-semibold text-slate-200">{t.owner_name}</div>
                      <div className="text-[11px] text-emerald-400 font-mono">{t.owner_email}</div>
                      <div className="text-[11px] text-slate-400">{t.phone || 'N/A'}</div>
                    </td>
                    <td className="p-3 hidden md:table-cell">
                      <div>{t.city || 'Lahore'}</div>
                      <div className="text-[11px] text-slate-500">{t.address || 'Main Market'}</div>
                    </td>
                    <td className="p-3 font-mono text-[11px] hidden lg:table-cell">
                      <div>Users: <span className="text-emerald-400 font-semibold">{t.user_count || 0}</span></div>
                      <div>Medicines: <span className="text-blue-400 font-semibold">{t.product_count || 0}</span></div>
                    </td>
                    <td className="p-3 font-bold text-emerald-400">
                      Rs. {(t.sales_total || 0).toLocaleString()}
                    </td>
                    <td className="p-3 hidden sm:table-cell">
                      {t.status === 'ACTIVE' ? (
                        <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full bg-emerald-950/80 border border-emerald-800 text-emerald-300 text-[11px] font-semibold">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          <span>Active</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full bg-rose-950/80 border border-rose-800 text-rose-300 text-[11px] font-semibold">
                          <XCircle className="w-3 h-3 text-rose-400" />
                          <span>Suspended</span>
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end space-x-2">
                        <button
                          onClick={() => handleJumpToStore(t.id, t.name)}
                          disabled={t.status === 'SUSPENDED'}
                          className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold flex items-center space-x-1 shadow-sm transition-all ${
                            t.status === 'SUSPENDED'
                              ? 'opacity-40 cursor-not-allowed bg-slate-900 text-slate-600 border border-slate-800'
                              : 'bg-indigo-600 hover:bg-indigo-500 text-white border border-indigo-500'
                          }`}
                          title={t.status === 'SUSPENDED' ? 'Store is suspended' : 'Jump directly into store account as Admin'}
                        >
                          <LogIn className="w-3 h-3" />
                          <span>Jump to Store</span>
                        </button>
                        <button
                          onClick={() => handleOpenSendMessage(t.id, t.name)}
                          className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 flex items-center space-x-1"
                          title="Send message to shopkeeper"
                        >
                          <Mail className="w-3 h-3 text-emerald-400" />
                          <span>Message</span>
                        </button>
                        <button
                          onClick={() => handleOpenStoreProfile(t.id)}
                          className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-950/70 hover:bg-emerald-900 border border-emerald-700 text-emerald-300 flex items-center space-x-1"
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span>Store Profile</span>
                        </button>
                        <button
                          onClick={() => handleToggleStatus(t.id, t.status)}
                          className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors ${
                            t.status === 'ACTIVE' 
                              ? 'bg-rose-950/50 hover:bg-rose-900 border-rose-800 text-rose-300' 
                              : 'bg-emerald-950/50 hover:bg-emerald-900 border-emerald-800 text-emerald-300'
                          }`}
                        >
                          {t.status === 'ACTIVE' ? 'Suspend' : 'Activate'}
                        </button>
                        <button
                          onClick={() => handleDeleteTenant(t.id, t.name)}
                          className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
                        >
                          Delete
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

      {/* Global Prewritten Messaging Templates & SMTP Gateway Control Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Prewritten Messaging Templates (Super Admin Portal) */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="font-bold text-white text-base flex items-center space-x-2">
              <Send className="w-5 h-5 text-emerald-400" />
              <span>Prewritten Messaging Templates (پیشگی تیار کردہ پیغامات)</span>
            </h3>
            <span className="text-[10px] uppercase tracking-wider font-bold bg-emerald-950 text-emerald-300 border border-emerald-800 px-2 py-0.5 rounded-md">
              Super Admin Control
            </span>
          </div>

          <p className="text-slate-400 text-xs">
            Manage global prewritten message templates dispatched across all stores for WhatsApp, SMS, and Email customer notices.
          </p>

          {globalSettingsMsg && (
            <div className="p-3 bg-emerald-950/80 border border-emerald-800 text-emerald-300 rounded-xl text-xs flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{globalSettingsMsg}</span>
            </div>
          )}

          <form onSubmit={handleSaveGlobalSettings} className="space-y-4 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">1. Udhar Due Reminder Message (ادھار یاد دہانی پیغام):</label>
              <textarea
                rows={3}
                value={globalSettings.msg_template_udhar_reminder || `محترم {name} صاحب! خوشی میڈیکل ہال پر آپ کا بقیہ ادھار رقم Rs. {balance} ہے۔ برائے مہربانی اپنا ادھار کھاتہ جلد از جلد صاف فرمائیں۔ شکریہ! - Khushi Medical Hall`}
                onChange={(e) => setGlobalSettings({ ...globalSettings, msg_template_udhar_reminder: e.target.value })}
                className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-sans"
              />
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">2. Payment Receipt Message (رقم وصولی کا پیغام):</label>
              <textarea
                rows={3}
                value={globalSettings.msg_template_payment_receipt || `محترم {name}! خوشی میڈیکل ہال میں آپ کی طرف سے رقم موصول ہو گئی ہے۔ آپ کا بقیہ کھاتہ Rs. {balance} ہے۔ شکریہ! - Khushi Medical Hall`}
                onChange={(e) => setGlobalSettings({ ...globalSettings, msg_template_payment_receipt: e.target.value })}
                className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-sans"
              />
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">3. Prescription Refill Reminder (دوائی ختم ہونے کا نوٹس):</label>
              <textarea
                rows={3}
                value={globalSettings.msg_template_refill || `Dear {name}, your regular medicine prescription stock at Khushi Medical Hall may be finishing soon. Visit us today for fresh refill & discounts! - Khushi Medical Hall`}
                onChange={(e) => setGlobalSettings({ ...globalSettings, msg_template_refill: e.target.value })}
                className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-sans"
              />
            </div>

            <button
              type="submit"
              disabled={savingGlobalSettings}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl flex items-center justify-center space-x-2 text-xs shadow-lg shadow-emerald-950/50"
            >
              {savingGlobalSettings ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              <span>Save Super Admin Message Templates</span>
            </button>
          </form>
        </div>

        {/* Outgoing Email Gateway Configuration (SMTP) */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="font-bold text-white text-base flex items-center space-x-2">
              <Mail className="w-5 h-5 text-emerald-400" />
              <span>Outgoing Email Gateway Configuration (SMTP)</span>
            </h3>
            <span className="text-[10px] uppercase tracking-wider font-bold bg-emerald-950 text-emerald-300 border border-emerald-800 px-2 py-0.5 rounded-md">
              Central Mail Server
            </span>
          </div>

          <p className="text-slate-400 text-xs">
            Configure server outgoing email parameters (Gmail SMTP, Custom Mail Server) to dispatch automated debt reminders, invoices, and system alerts.
          </p>

          <form onSubmit={handleSaveGlobalSettings} className="space-y-3 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">SMTP Gateway Status:</label>
                <select
                  value={globalSettings.smtp_enabled ?? 'true'}
                  onChange={(e) => setGlobalSettings({ ...globalSettings, smtp_enabled: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-semibold"
                >
                  <option value="true">Active (Enabled / جاری)</option>
                  <option value="false">Disabled (بند)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">SMTP Host Server:</label>
                <input
                  type="text"
                  placeholder="smtp.gmail.com"
                  value={globalSettings.smtp_host || ''}
                  onChange={(e) => setGlobalSettings({ ...globalSettings, smtp_host: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">SMTP Port:</label>
                <input
                  type="text"
                  placeholder="587 or 465"
                  value={globalSettings.smtp_port || ''}
                  onChange={(e) => setGlobalSettings({ ...globalSettings, smtp_port: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Encryption Security:</label>
                <select
                  value={globalSettings.smtp_secure || 'tls'}
                  onChange={(e) => setGlobalSettings({ ...globalSettings, smtp_secure: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                >
                  <option value="tls">STARTTLS / TLS (Port 587)</option>
                  <option value="ssl">SSL (Port 465)</option>
                  <option value="none">None (Port 25)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">SMTP Username / Email:</label>
                <input
                  type="text"
                  placeholder="khushi.pharmacy@gmail.com"
                  value={globalSettings.smtp_user || ''}
                  onChange={(e) => setGlobalSettings({ ...globalSettings, smtp_user: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">SMTP App Password:</label>
                <input
                  type="password"
                  placeholder="••••••••••••••••"
                  value={globalSettings.smtp_pass || ''}
                  onChange={(e) => setGlobalSettings({ ...globalSettings, smtp_pass: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Sender Email Address:</label>
                <input
                  type="email"
                  placeholder="khushi.pharmacy@gmail.com"
                  value={globalSettings.smtp_from_email || ''}
                  onChange={(e) => setGlobalSettings({ ...globalSettings, smtp_from_email: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Sender Display Name:</label>
                <input
                  type="text"
                  placeholder="Khushi Medical Hall Admin"
                  value={globalSettings.smtp_from_name || ''}
                  onChange={(e) => setGlobalSettings({ ...globalSettings, smtp_from_name: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={savingGlobalSettings}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl flex items-center justify-center space-x-2 text-xs shadow-lg shadow-emerald-950/50"
            >
              {savingGlobalSettings ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              <span>Save SMTP Server Settings</span>
            </button>
          </form>

          {/* Test SMTP Gateway Connection */}
          <div className="bg-slate-800/60 p-3.5 rounded-xl border border-slate-700/80 space-y-3 pt-3">
            <div className="font-bold text-white text-xs flex items-center space-x-1.5">
              <Send className="w-3.5 h-3.5 text-emerald-400" />
              <span>Test SMTP Gateway Connection (ای میل کنکشن ٹیسٹ)</span>
            </div>

            {smtpTestResult && (
              <div className={`p-2.5 rounded-xl text-xs flex items-start gap-2 ${
                smtpTestResult.type === 'success' ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-300' : 'bg-rose-950/80 border border-rose-800 text-rose-300'
              }`}>
                {smtpTestResult.type === 'success' ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />}
                <span>{smtpTestResult.message}</span>
              </div>
            )}

            <form onSubmit={handleTestSmtp} className="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                placeholder="Enter test recipient email address..."
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                className="flex-1 bg-slate-900 text-white p-2 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono text-xs"
              />
              <button
                type="submit"
                disabled={testingSmtp}
                className="bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-2 rounded-xl text-xs flex items-center justify-center space-x-1.5 shrink-0"
              >
                {testingSmtp ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                <span>Send Test Email</span>
              </button>
            </form>
          </div>
        </div>

      </div>

      {/* Add Store Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={handleCreateTenant} className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="font-bold text-base text-white flex items-center space-x-2">
                <Building2 className="w-5 h-5 text-emerald-400" />
                <span>Onboard New Store / Shop</span>
              </h3>
              <button type="button" onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white">
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="sm:col-span-2">
                <label className="block text-slate-300 font-semibold mb-1">Store Name*:</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Al-Razi General & Medical Store"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-medium"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Owner / Shopkeeper Name*:</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Tariq Mahmood"
                  value={formData.owner_name}
                  onChange={(e) => setFormData({ ...formData, owner_name: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Owner Email Address*:</label>
                <input
                  type="email"
                  required
                  placeholder="tariq@store.com"
                  value={formData.owner_email}
                  onChange={(e) => setFormData({ ...formData, owner_email: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Admin Password (پاسورڈ):</label>
                <input
                  type="password"
                  placeholder="Enter custom password or leave blank for admin123"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Phone Number:</label>
                <input
                  type="text"
                  placeholder="0300-1234567"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">City:</label>
                <input
                  type="text"
                  placeholder="Lahore / Rawalpindi / Karachi"
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-slate-300 font-semibold mb-1">Shop Address:</label>
                <input
                  type="text"
                  placeholder="e.g. Shop #12, Commercial Market, Rawalpindi"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex items-center space-x-3 pt-3 border-t border-slate-800">
              <button
                type="submit"
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl text-xs shadow-lg shadow-emerald-950/50"
              >
                Create Store Account
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
      {/* Store Profile & Services Management Modal */}
      {selectedTenantId !== null && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 text-slate-100 rounded-2xl max-w-5xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="bg-slate-950 px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <div className="flex items-center space-x-2">
                  <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded-md border border-emerald-800">
                    Store #{selectedTenantId}
                  </span>
                  <h3 className="font-bold text-lg text-white">
                    {profileData?.tenant.name || 'Loading Store Profile...'}
                  </h3>
                  {profileData && (
                    <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border ${
                      profileData.tenant.status === 'ACTIVE'
                        ? 'bg-emerald-950 border-emerald-800 text-emerald-300'
                        : 'bg-rose-950 border-rose-800 text-rose-300'
                    }`}>
                      {profileData.tenant.status}
                    </span>
                  )}
                </div>
                <p className="text-slate-400 text-xs mt-1">
                  Owner: <span className="text-slate-200 font-semibold">{profileData?.tenant.owner_name}</span> ({profileData?.tenant.owner_email}) • {profileData?.tenant.city || 'Lahore'}
                </p>
              </div>

              <div className="flex items-center space-x-2">
                {profileData && (
                  <>
                    <button
                      onClick={() => handleJumpToStore(profileData.tenant.id, profileData.tenant.name)}
                      disabled={profileData.tenant.status === 'SUSPENDED'}
                      className={`text-xs font-bold px-3 py-1.5 rounded-lg border flex items-center space-x-1 shadow-sm transition-all ${
                        profileData.tenant.status === 'SUSPENDED'
                          ? 'opacity-40 cursor-not-allowed bg-slate-900 text-slate-600 border-slate-800'
                          : 'bg-indigo-600 hover:bg-indigo-500 text-white border-indigo-500'
                      }`}
                    >
                      <LogIn className="w-3.5 h-3.5" />
                      <span>Jump to Store Account</span>
                    </button>
                    <button
                      onClick={() => handleToggleStatus(profileData.tenant.id, profileData.tenant.status)}
                      className={`text-xs font-bold px-3 py-1.5 rounded-lg border ${
                        profileData.tenant.status === 'ACTIVE'
                          ? 'bg-rose-950/80 hover:bg-rose-900 border-rose-800 text-rose-300'
                          : 'bg-emerald-950/80 hover:bg-emerald-900 border-emerald-800 text-emerald-300'
                      }`}
                    >
                      {profileData.tenant.status === 'ACTIVE' ? 'Suspend Store' : 'Activate Store'}
                    </button>
                  </>
                )}
                <button
                  onClick={() => setSelectedTenantId(null)}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold"
                >
                  Close ✕
                </button>
              </div>
            </div>

            {profileLoading || !profileData ? (
              <div className="p-12 text-center text-slate-400 text-sm flex flex-col items-center justify-center space-y-3">
                <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin" />
                <span>Fetching complete store records and service configurations...</span>
              </div>
            ) : (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Profile Tabs Bar */}
                <div className="bg-slate-900/90 border-b border-slate-800 px-6 py-2 flex items-center space-x-2 overflow-x-auto text-xs font-semibold">
                  <button
                    onClick={() => setActiveProfileTab('SERVICES')}
                    className={`px-3 py-2 rounded-xl flex items-center space-x-2 transition-all ${
                      activeProfileTab === 'SERVICES'
                        ? 'bg-emerald-600 text-white font-bold shadow-md shadow-emerald-950/50'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <ShieldCheck className="w-4 h-4" />
                    <span>Allowed Services ({Object.values(allowedServicesMap).filter(Boolean).length}/10)</span>
                  </button>

                  <button
                    onClick={() => setActiveProfileTab('BILLING')}
                    className={`px-3 py-2 rounded-xl flex items-center space-x-2 transition-all ${
                      activeProfileTab === 'BILLING'
                        ? 'bg-emerald-600 text-white font-bold shadow-md shadow-emerald-950/50'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <ShoppingBag className="w-4 h-4" />
                    <span>Store Billing ({profileData.sales.length})</span>
                  </button>

                  <button
                    onClick={() => setActiveProfileTab('INVENTORY')}
                    className={`px-3 py-2 rounded-xl flex items-center space-x-2 transition-all ${
                      activeProfileTab === 'INVENTORY'
                        ? 'bg-emerald-600 text-white font-bold shadow-md shadow-emerald-950/50'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <Building2 className="w-4 h-4" />
                    <span>Inventory Stock ({profileData.products.length})</span>
                  </button>

                  <button
                    onClick={() => setActiveProfileTab('CUSTOMERS')}
                    className={`px-3 py-2 rounded-xl flex items-center space-x-2 transition-all ${
                      activeProfileTab === 'CUSTOMERS'
                        ? 'bg-emerald-600 text-white font-bold shadow-md shadow-emerald-950/50'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <Users className="w-4 h-4" />
                    <span>Customers ({profileData.customers.length})</span>
                  </button>

                  <button
                    onClick={() => setActiveProfileTab('USERS')}
                    className={`px-3 py-2 rounded-xl flex items-center space-x-2 transition-all ${
                      activeProfileTab === 'USERS'
                        ? 'bg-emerald-600 text-white font-bold shadow-md shadow-emerald-950/50'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <Users className="w-4 h-4 text-blue-400" />
                    <span>Store Users ({profileData.users.length})</span>
                  </button>

                  <button
                    onClick={() => setActiveProfileTab('AUDIT')}
                    className={`px-3 py-2 rounded-xl flex items-center space-x-2 transition-all ${
                      activeProfileTab === 'AUDIT'
                        ? 'bg-emerald-600 text-white font-bold shadow-md shadow-emerald-950/50'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <ShieldAlert className="w-4 h-4 text-amber-400" />
                    <span>Store Audit Logs ({profileData.auditLogs.length})</span>
                  </button>
                </div>

                {/* Tab Content Body */}
                <div className="flex-1 overflow-y-auto p-6">
                  {/* TAB 1: Allowed Services */}
                  {activeProfileTab === 'SERVICES' && (
                    <div className="space-y-4">
                      <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                        <div>
                          <h4 className="font-bold text-sm text-white flex items-center space-x-2">
                            <Lock className="w-4 h-4 text-emerald-400" />
                            <span>Super Admin Service Level Access Control</span>
                          </h4>
                          <p className="text-slate-400 text-xs mt-0.5">
                            Decide which features and modules are unlocked or restricted for store <span className="text-emerald-300 font-semibold">{profileData.tenant.name}</span>.
                          </p>
                        </div>

                        <button
                          onClick={handleSaveServices}
                          disabled={savingServices}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-4 py-2 rounded-xl text-xs shadow-lg shadow-emerald-950/50 shrink-0"
                        >
                          {savingServices ? 'Saving Permissions...' : 'Save Service Permissions'}
                        </button>
                      </div>

                      {servicesMsg && (
                        <div className="bg-emerald-950/80 border border-emerald-800 text-emerald-300 p-3 rounded-xl text-xs font-semibold">
                          ✓ {servicesMsg}
                        </div>
                      )}

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {ALL_AVAILABLE_SERVICES.map((s) => (
                          <div 
                            key={s.id} 
                            onClick={() => setAllowedServicesMap(prev => ({ ...prev, [s.id]: !prev[s.id] }))}
                            className={`p-3.5 rounded-xl border cursor-pointer transition-all flex items-start space-x-3 ${
                              allowedServicesMap[s.id]
                                ? 'bg-slate-800/80 border-emerald-700/80 text-white'
                                : 'bg-slate-950/50 border-slate-800/80 text-slate-500 opacity-60'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={!!allowedServicesMap[s.id]}
                              onChange={() => {}}
                              className="mt-1 rounded border-slate-700 text-emerald-500 focus:ring-emerald-500"
                            />
                            <div>
                              <div className="font-bold text-xs flex items-center space-x-2">
                                <span>{s.name}</span>
                                <span className="text-[10px] font-mono text-slate-400">({s.id})</span>
                              </div>
                              <div className="text-[11px] text-slate-400 mt-0.5">{s.desc}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* TAB 2: Store Invoices & Billing */}
                  {activeProfileTab === 'BILLING' && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-sm text-white">Sales & Invoice History for {profileData.tenant.name}</h4>
                        <span className="text-xs font-mono text-slate-400">Total Records: {profileData.sales.length}</span>
                      </div>

                      {profileData.sales.length === 0 ? (
                        <div className="text-center py-12 text-slate-500 text-xs">No sales invoices recorded yet for this store.</div>
                      ) : (
                        <div className="overflow-x-auto border border-slate-800 rounded-xl">
                          <table className="w-full text-left text-xs text-slate-300">
                            <thead className="bg-slate-950 text-slate-400 uppercase font-semibold border-b border-slate-800">
                              <tr>
                                <th className="p-2.5">Invoice #</th>
                                <th className="p-2.5">Customer</th>
                                <th className="p-2.5">Date & Time</th>
                                <th className="p-2.5">Payment Method</th>
                                <th className="p-2.5 font-bold text-emerald-400">Grand Total</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60">
                              {profileData.sales.map((sale: any) => (
                                <tr key={sale.id} className="hover:bg-slate-800/40">
                                  <td className="p-2.5 font-mono font-bold text-slate-300">{sale.invoice_number || `#${sale.id}`}</td>
                                  <td className="p-2.5 text-slate-200">{sale.customer_name || 'Walk-In Customer'}</td>
                                  <td className="p-2.5 text-slate-400 text-[11px]">{sale.created_at}</td>
                                  <td className="p-2.5"><span className="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 text-[11px]">{sale.payment_method}</span></td>
                                  <td className="p-2.5 font-bold text-emerald-400">Rs. {Number(sale.grand_total || 0).toLocaleString()}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* TAB 3: Inventory */}
                  {activeProfileTab === 'INVENTORY' && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-sm text-white">Registered Medicines in {profileData.tenant.name}</h4>
                        <span className="text-xs font-mono text-slate-400">Total Medicines: {profileData.products.length}</span>
                      </div>

                      {profileData.products.length === 0 ? (
                        <div className="text-center py-12 text-slate-500 text-xs">No products in inventory for this store.</div>
                      ) : (
                        <div className="overflow-x-auto border border-slate-800 rounded-xl">
                          <table className="w-full text-left text-xs text-slate-300">
                            <thead className="bg-slate-950 text-slate-400 uppercase font-semibold border-b border-slate-800">
                              <tr>
                                <th className="p-2.5">Medicine Name</th>
                                <th className="p-2.5">Formula / Generic</th>
                                <th className="p-2.5">Stock Level</th>
                                <th className="p-2.5">Sale Price</th>
                                <th className="p-2.5">Purchase Price</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60">
                              {profileData.products.map((p: any) => (
                                <tr key={p.id} className="hover:bg-slate-800/40">
                                  <td className="p-2.5 font-bold text-white">{p.name}</td>
                                  <td className="p-2.5 text-slate-400">{p.generic_name || 'N/A'}</td>
                                  <td className="p-2.5 font-mono">
                                    <span className={`px-2 py-0.5 rounded-md font-bold ${p.stock_quantity <= (p.min_stock_alert || 10) ? 'bg-rose-950 text-rose-300 border border-rose-800' : 'bg-emerald-950 text-emerald-300'}`}>
                                      {p.stock_quantity} units
                                    </span>
                                  </td>
                                  <td className="p-2.5 font-bold text-emerald-400">Rs. {p.sale_price}</td>
                                  <td className="p-2.5 text-slate-400">Rs. {p.purchase_price}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* TAB 4: Customers & Udhar */}
                  {activeProfileTab === 'CUSTOMERS' && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-sm text-white">Registered Udhar Customers</h4>
                        <span className="text-xs font-mono text-slate-400">Total Customers: {profileData.customers.length}</span>
                      </div>

                      {profileData.customers.length === 0 ? (
                        <div className="text-center py-12 text-slate-500 text-xs">No registered customers yet.</div>
                      ) : (
                        <div className="overflow-x-auto border border-slate-800 rounded-xl">
                          <table className="w-full text-left text-xs text-slate-300">
                            <thead className="bg-slate-950 text-slate-400 uppercase font-semibold border-b border-slate-800">
                              <tr>
                                <th className="p-2.5">Customer Name</th>
                                <th className="p-2.5">Phone</th>
                                <th className="p-2.5">City</th>
                                <th className="p-2.5 font-bold text-amber-400">Current Udhar Balance</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60">
                              {profileData.customers.map((c: any) => (
                                <tr key={c.id} className="hover:bg-slate-800/40">
                                  <td className="p-2.5 font-bold text-white">{c.name}</td>
                                  <td className="p-2.5 text-emerald-400 font-mono">{c.phone || 'N/A'}</td>
                                  <td className="p-2.5 text-slate-400">{c.city || 'Lahore'}</td>
                                  <td className="p-2.5 font-bold text-amber-400">Rs. {Number(c.balance || 0).toLocaleString()}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* TAB 5: Store Staff & Users */}
                  {activeProfileTab === 'USERS' && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-sm text-white">Store Accounts & Staff Members</h4>
                        <span className="text-xs font-mono text-slate-400">Total Accounts: {profileData.users.length}</span>
                      </div>

                      <div className="overflow-x-auto border border-slate-800 rounded-xl">
                        <table className="w-full text-left text-xs text-slate-300">
                          <thead className="bg-slate-950 text-slate-400 uppercase font-semibold border-b border-slate-800">
                            <tr>
                              <th className="p-2.5">User ID</th>
                              <th className="p-2.5">Username / Email</th>
                              <th className="p-2.5">Full Name</th>
                              <th className="p-2.5">Role</th>
                              <th className="p-2.5">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/60">
                            {profileData.users.map((u: any) => (
                              <tr key={u.id} className="hover:bg-slate-800/40">
                                <td className="p-2.5 font-mono text-slate-400">#{u.id}</td>
                                <td className="p-2.5 font-bold text-white">{u.username}</td>
                                <td className="p-2.5 text-slate-300">{u.fullName || u.full_name}</td>
                                <td className="p-2.5"><span className="px-2 py-0.5 rounded bg-slate-800 text-emerald-400 font-semibold">{u.role}</span></td>
                                <td className="p-2.5"><span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 font-semibold">{u.status || 'APPROVED'}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* TAB 6: Store Audit Logs */}
                  {activeProfileTab === 'AUDIT' && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-sm text-white">Security Audit Log History</h4>
                        <span className="text-xs font-mono text-slate-400">Total Log Entries: {profileData.auditLogs.length}</span>
                      </div>

                      {profileData.auditLogs.length === 0 ? (
                        <div className="text-center py-12 text-slate-500 text-xs">No audit logs recorded for this store yet.</div>
                      ) : (
                        <div className="overflow-x-auto border border-slate-800 rounded-xl">
                          <table className="w-full text-left text-xs text-slate-300">
                            <thead className="bg-slate-950 text-slate-400 uppercase font-semibold border-b border-slate-800">
                              <tr>
                                <th className="p-2.5">Timestamp</th>
                                <th className="p-2.5">User</th>
                                <th className="p-2.5">Action</th>
                                <th className="p-2.5">Description</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60">
                              {profileData.auditLogs.map((log: any) => (
                                <tr key={log.id} className="hover:bg-slate-800/40">
                                  <td className="p-2.5 font-mono text-slate-400 text-[11px]">{log.created_at}</td>
                                  <td className="p-2.5 font-semibold text-slate-200">{log.user_name || 'System'}</td>
                                  <td className="p-2.5 font-mono text-emerald-400 text-[11px]">{log.action_type}</td>
                                  <td className="p-2.5 text-slate-300">{log.description}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Send Message to Shopkeeper Modal */}
      {showMessageModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl animate-fade-in">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-2 text-emerald-400 font-bold text-sm">
                <Mail className="w-5 h-5" />
                <span>Send Direct Message to Shopkeeper</span>
              </div>
              <button
                onClick={() => setShowMessageModal(false)}
                className="text-slate-400 hover:text-white text-lg font-bold p-1 rounded-lg hover:bg-slate-800"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Target Recipient: <span className="text-emerald-300 font-semibold">{msgTargetName}</span>
            </p>

            {msgNotice && (
              <div className="p-3 bg-rose-950/80 border border-rose-800 text-rose-300 rounded-xl text-xs flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{msgNotice}</span>
              </div>
            )}

            <form onSubmit={handleSendSuperAdminMessage} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Quick Select Prewritten Message Template (پیشگی پیغام منتخب کریں):</label>
                <select
                  onChange={(e) => applyTemplateToMessage(e.target.value)}
                  className="w-full bg-slate-800 text-emerald-300 font-semibold p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                >
                  <option value="">-- Choose Prewritten Template or Write Custom --</option>
                  <option value="UDHAR_REMINDER">1. Udhar Due Payment Reminder Notice</option>
                  <option value="PAYMENT_RECEIPT">2. Payment Receipt Confirmation</option>
                  <option value="REFILL">3. Medicine Prescription Stock Refill Reminder</option>
                  <option value="ANNOUNCEMENT">4. Software Feature Update & Announcement</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Message Subject / Title *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. System Notice for Shopkeeper"
                  value={msgSubject}
                  onChange={(e) => setMsgSubject(e.target.value)}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Message Body / Content (اردو یا انگریزی) *</label>
                <textarea
                  required
                  rows={5}
                  placeholder="Type official message to shopkeeper..."
                  value={msgBody}
                  onChange={(e) => setMsgBody(e.target.value)}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-sans"
                />
              </div>

              <div className="flex items-center justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowMessageModal(false)}
                  className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-xl text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sendingMsg}
                  className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center space-x-2 shadow-lg shadow-emerald-950/50"
                >
                  {sendingMsg ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  <span>Dispatch Message</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
