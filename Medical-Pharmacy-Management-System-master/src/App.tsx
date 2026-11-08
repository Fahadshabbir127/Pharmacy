import React, { useState, useEffect } from 'react';
import { User, SystemSettings } from './types';
import { getCurrentUser, getAuthToken, setCurrentUser as setCurrentUserInStorage, removeAuthToken, api, getPendingOfflineSales, syncPendingOfflineSales } from './lib/api';
import { Navbar } from './components/Navbar';
import { Sidebar } from './components/Sidebar';
import { LoginModal } from './components/LoginModal';
import { BillingScreen } from './components/BillingScreen';
import { InventoryScreen } from './components/InventoryScreen';
import { CustomerManagementScreen } from './components/CustomerManagementScreen';
import { PurchaseScreen } from './components/PurchaseScreen';
import { ReportsScreen } from './components/ReportsScreen';
import { EmailQueueScreen } from './components/EmailQueueScreen';
import { SettingsBackupScreen } from './components/SettingsBackupScreen';
import { CustomerPortalScreen } from './components/CustomerPortalScreen';
import { UserManagementScreen } from './components/UserManagementScreen';
import { AuditLogScreen } from './components/AuditLogScreen';
import { SuperAdminScreen } from './components/SuperAdminScreen';
import { SalesScreen } from './components/SalesScreen';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<string>('billing');
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set(['billing']));
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [lowStockCount, setLowStockCount] = useState<number>(0);
  const [expiringCount, setExpiringCount] = useState<number>(0);
  const [checkingAuth, setCheckingAuth] = useState<boolean>(true);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState<boolean>(false);

  // Sync & Offline state
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [pendingOfflineCount, setPendingOfflineCount] = useState<number>(() => getPendingOfflineSales().length);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  useEffect(() => {
    checkAuthSession();

    const handleOnline = () => {
      setIsOnline(true);
      handleSyncOfflineData();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const interval = setInterval(() => {
      setPendingOfflineCount(getPendingOfflineSales().length);
    }, 2000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, []);

  const handleSyncOfflineData = async () => {
    if (getPendingOfflineSales().length === 0) return;
    try {
      setIsSyncing(true);
      const res = await syncPendingOfflineSales();
      setPendingOfflineCount(res.remaining);
      if (res.synced > 0) {
        fetchAlertsAndSettings();
      }
    } catch (err) {
      console.error('Error syncing offline sales:', err);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    if (activeTab) {
      setVisitedTabs((prev) => {
        if (prev.has(activeTab)) return prev;
        const next = new Set(prev);
        next.add(activeTab);
        return next;
      });
    }
  }, [activeTab]);

  useEffect(() => {
    if (currentUser) {
      if (currentUser.role === 'SUPER_ADMIN') {
        setActiveTab('superadmin');
        setVisitedTabs(new Set(['superadmin']));
      } else if (currentUser.role === 'CUSTOMER') {
        setActiveTab('customer-portal');
        setVisitedTabs(new Set(['customer-portal']));
      } else {
        setActiveTab('billing');
        setVisitedTabs(new Set(['billing']));
        fetchAlertsAndSettings();
      }
    }
  }, [currentUser]);

  const checkAuthSession = async () => {
    // Check if link was shared with explicit force-login/logout intent (?login=true or ?logout=true)
    const urlParams = new URLSearchParams(window.location.search);
    const forceLogout = urlParams.get('logout') === 'true' || urlParams.get('login') === 'true' || urlParams.get('force_login') === 'true';

    if (forceLogout) {
      removeAuthToken();
      setCurrentUser(null);
      // Clean query parameters from URL without reloading page
      window.history.replaceState({}, document.title, window.location.pathname);
      setCheckingAuth(false);
      return;
    }

    const token = getAuthToken();
    if (token) {
      try {
        const me = await api.getMe();
        setCurrentUser(me.user);
        setCurrentUserInStorage(me.user);
      } catch (err) {
        console.warn('Session token invalid or expired. Prompting for login:', err);
        removeAuthToken();
        setCurrentUser(null);
      }
    } else {
      setCurrentUser(null);
    }
    setCheckingAuth(false);
  };

  const fetchAlertsAndSettings = async () => {
    try {
      const stats = await api.getDashboardStats();
      setLowStockCount(stats.lowStockCount);
      setExpiringCount(stats.expiringCount);
      
      const setts = await api.getSettings();
      setSettings(setts as any);
    } catch (e) {
      console.error('Failed to fetch stats/settings', e);
    }
  };

  const handleLogout = () => {
    removeAuthToken();
    setCurrentUser(null);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (currentUser?.role === 'CUSTOMER') return; // Strictly ignore keyboard tab shortcuts for customers
      if (e.key === 'F1') {
        e.preventDefault();
        if (currentUser?.role !== 'CUSTOMER') setActiveTab('billing');
      } else if (e.key === 'F2') {
        e.preventDefault();
        if (currentUser?.role !== 'CUSTOMER') setActiveTab('inventory');
      } else if (e.key === 'F8') {
        e.preventDefault();
        setActiveTab('customer-portal');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentUser]);

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-slate-300 font-mono text-xs">
        Initializing High Density POS System...
      </div>
    );
  }

  if (!currentUser) {
    return <LoginModal onLoginSuccess={(user) => setCurrentUser(user)} />;
  }

  return (
    <div className="min-h-screen md:h-screen bg-slate-200 text-slate-900 flex flex-col font-sans antialiased md:overflow-hidden high-density-text">
      
      {/* Top Navbar */}
      <Navbar 
        user={currentUser} 
        onLogout={handleLogout} 
        activeTab={activeTab} 
        onToggleMobileSidebar={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
        isMobileSidebarOpen={isMobileSidebarOpen}
      />

      <div className="flex-1 flex overflow-x-hidden md:overflow-hidden relative">
        {/* Navigation Sidebar (Hidden for Customer Portal users) */}
        {currentUser.role !== 'CUSTOMER' && (
          <Sidebar
            activeTab={activeTab}
            setActiveTab={(tab) => {
              setActiveTab(tab);
              setIsMobileSidebarOpen(false);
            }}
            userRole={currentUser.role}
            allowedServices={currentUser.allowed_services}
            lowStockCount={lowStockCount}
            expiringCount={expiringCount}
            isMobileOpen={isMobileSidebarOpen}
            onCloseMobile={() => setIsMobileSidebarOpen(false)}
          />
        )}

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto bg-slate-200 p-2 sm:p-3 w-full max-w-full">
          {currentUser.role === 'CUSTOMER' ? (
            <CustomerPortalScreen />
          ) : (
            <>
              {visitedTabs.has('superadmin') && currentUser.role === 'SUPER_ADMIN' && (
                <div className={activeTab === 'superadmin' ? 'block' : 'hidden'}>
                  <SuperAdminScreen currentUser={currentUser} />
                </div>
              )}

              {visitedTabs.has('billing') && (
                <div className={activeTab === 'billing' ? 'block' : 'hidden'}>
                  <BillingScreen settings={settings} onRefreshData={fetchAlertsAndSettings} />
                </div>
              )}

              {visitedTabs.has('sales') && (
                <div className={activeTab === 'sales' ? 'block' : 'hidden'}>
                  <SalesScreen currentUser={currentUser || undefined} />
                </div>
              )}

              {visitedTabs.has('inventory') && (
                <div className={activeTab === 'inventory' ? 'block' : 'hidden'}>
                  <InventoryScreen currentUser={currentUser || undefined} />
                </div>
              )}

              {visitedTabs.has('customers') && (
                <div className={activeTab === 'customers' ? 'block' : 'hidden'}>
                  <CustomerManagementScreen currentUser={currentUser} />
                </div>
              )}

              {visitedTabs.has('purchases') && (
                <div className={activeTab === 'purchases' ? 'block' : 'hidden'}>
                  <PurchaseScreen />
                </div>
              )}

              {visitedTabs.has('reports') && (
                <div className={activeTab === 'reports' ? 'block' : 'hidden'}>
                  <ReportsScreen />
                </div>
              )}

              {(visitedTabs.has('email') || visitedTabs.has('sms')) && (
                <div className={(activeTab === 'email' || activeTab === 'sms') ? 'block' : 'hidden'}>
                  <EmailQueueScreen />
                </div>
              )}

              {visitedTabs.has('users') && (currentUser.role === 'ADMIN' || currentUser.role === 'SUPER_ADMIN') && (
                <div className={activeTab === 'users' ? 'block' : 'hidden'}>
                  <UserManagementScreen currentUser={currentUser} />
                </div>
              )}

              {visitedTabs.has('audit') && (currentUser.role === 'ADMIN' || currentUser.role === 'SUPER_ADMIN') && (
                <div className={activeTab === 'audit' ? 'block' : 'hidden'}>
                  <AuditLogScreen currentUser={currentUser} />
                </div>
              )}

              {visitedTabs.has('settings') && (currentUser.role === 'ADMIN' || currentUser.role === 'SUPER_ADMIN') && (
                <div className={activeTab === 'settings' ? 'block' : 'hidden'}>
                  <SettingsBackupScreen currentUser={currentUser || undefined} />
                </div>
              )}

              {visitedTabs.has('customer-portal') && (
                <div className={activeTab === 'customer-portal' ? 'block' : 'hidden'}>
                  <CustomerPortalScreen />
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* High Density Status Footer */}
      <footer className="h-6 bg-slate-800 text-slate-300 flex items-center justify-between px-3 shrink-0 text-[10px] select-none border-t border-slate-700 font-mono">
        <div className="flex items-center space-x-3">
          {/* Database Synchronization Indicator */}
          {isOnline ? (
            pendingOfflineCount === 0 ? (
              <span className="flex items-center space-x-1.5 text-emerald-300 font-bold bg-emerald-950/70 border border-emerald-500/40 px-2 py-0.5 rounded">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span>DB SYNCHRONIZED</span>
              </span>
            ) : (
              <span className="flex items-center space-x-1.5 text-amber-200 font-bold bg-amber-950/90 border border-amber-500/60 px-2 py-0.5 rounded">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span>
                <span>{pendingOfflineCount} PENDING SYNC</span>
                <button
                  onClick={handleSyncOfflineData}
                  disabled={isSyncing}
                  className="bg-amber-600 hover:bg-amber-500 text-white px-1.5 py-0.2 rounded text-[9px] uppercase font-bold transition-all ml-1"
                >
                  {isSyncing ? 'Syncing...' : 'Sync Now'}
                </button>
              </span>
            )
          ) : (
            <span className="flex items-center space-x-1.5 text-rose-200 font-bold bg-rose-950/90 border border-rose-500/60 px-2 py-0.5 rounded">
              <span className="w-2 h-2 rounded-full bg-rose-500"></span>
              <span>OFFLINE ({pendingOfflineCount} SALES PENDING)</span>
            </span>
          )}
        </div>

        {/* Rights Reserved Info & Shortcuts */}
        <div className="flex items-center space-x-3">
          <span className="text-slate-200 font-bold bg-slate-900/90 px-2 py-0.5 rounded border border-slate-700/80">
            © All Rights Reserved | Muhammad Umar
          </span>

          <div className="hidden lg:flex items-center space-x-2 text-slate-400">
            <span className="bg-slate-700 px-1.5 py-0.5 rounded text-white font-bold">[F1] Billing</span>
            <span className="bg-slate-700 px-1.5 py-0.5 rounded text-white font-bold">[F2] Inventory</span>
            <span className="bg-slate-700 px-1.5 py-0.5 rounded text-white font-bold">[F8] Portal</span>
          </div>
        </div>
      </footer>

    </div>
  );
}
