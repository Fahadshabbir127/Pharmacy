import React, { useState, useEffect } from 'react';
import { User } from '../types';
import { Pill, Shield, LogOut, Wifi, WifiOff, Printer, User as UserIcon, Clock, Menu, X, ShieldAlert, ArrowLeft } from 'lucide-react';
import { getSuperAdminBackup, clearSuperAdminBackup, setAuthToken, setCurrentUser } from '../lib/api';

interface NavbarProps {
  user: User | null;
  onLogout: () => void;
  activeTab: string;
  onToggleMobileSidebar?: () => void;
  isMobileSidebarOpen?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({ 
  user, 
  onLogout, 
  activeTab, 
  onToggleMobileSidebar, 
  isMobileSidebarOpen 
}) => {
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [currentTime, setCurrentTime] = useState<string>(new Date().toLocaleTimeString('en-PK'));

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const timer = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString('en-PK', { hour12: true }));
    }, 1000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(timer);
    };
  }, []);

  const storeDisplayName = user?.role === 'SUPER_ADMIN' 
    ? 'SUPER VISOR PLATFORM CONTROL' 
    : (user?.tenant_name || 'KHUSHI MEDICAL HALL POS');

  const storeInitial = (storeDisplayName || 'K').trim().charAt(0).toUpperCase();

  const getRoleLabel = (role?: string) => {
    switch (role) {
      case 'SUPER_ADMIN':
        return 'SUPER ADMIN (Platform Owner)';
      case 'ADMIN':
        return 'STORE ADMIN (Shopkeeper)';
      case 'STAFF':
        return 'STAFF (Pharmacist)';
      case 'CUSTOMER':
        return 'CUSTOMER (Patient Account)';
      default:
        return role || 'USER';
    }
  };

  const superAdminBackup = getSuperAdminBackup();

  const handleReturnToSuperAdmin = () => {
    if (!superAdminBackup) return;
    setAuthToken(superAdminBackup.token);
    setCurrentUser(superAdminBackup.user);
    clearSuperAdminBackup();
    window.location.reload();
  };

  return (
    <>
      {superAdminBackup && (
        <div className="bg-indigo-950 text-indigo-100 text-xs px-3 sm:px-4 py-2 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 font-semibold border-b border-indigo-700 shadow-md z-50">
          <div className="flex items-center space-x-2">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              Super Admin Impersonation Mode: Currently managing <strong>{storeDisplayName}</strong> (Store #{user?.tenant_id || 1})
            </span>
          </div>
          <button
            onClick={handleReturnToSuperAdmin}
            className="px-3 py-1 bg-amber-400 hover:bg-amber-300 text-slate-950 font-extrabold rounded-md text-xs shadow flex items-center space-x-1.5 transition-all shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Return to Super Admin Panel</span>
          </button>
        </div>
      )}

      <header className="h-12 bg-emerald-800 text-white flex items-center justify-between px-3 sm:px-4 shrink-0 border-b-2 border-emerald-900 sticky top-0 z-40 select-none shadow-md">
      {/* Brand & Title */}
      <div className="flex items-center space-x-2 sm:space-x-3">
        {onToggleMobileSidebar && (
          <button
            onClick={onToggleMobileSidebar}
            className="md:hidden p-1 bg-emerald-900 hover:bg-emerald-950 rounded border border-emerald-700 text-emerald-100 transition-all"
            aria-label="Toggle navigation menu"
          >
            {isMobileSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        )}

        <div className="w-7 h-7 bg-white rounded-full flex items-center justify-center text-emerald-800 font-black text-base shadow-sm shrink-0 uppercase">
          {storeInitial}
        </div>
        <div>
          <h1 className="font-bold text-xs sm:text-sm leading-tight tracking-wide flex items-center space-x-1.5 sm:space-x-2">
            <span className="truncate max-w-[200px] sm:max-w-[320px]">{storeDisplayName}</span>
            <span className="text-[9px] bg-emerald-900 px-1 py-0.5 sm:px-1.5 rounded font-mono text-emerald-200 border border-emerald-700 shrink-0">
              {user?.role === 'SUPER_ADMIN' ? 'SUPER VISOR' : `Store #${user?.tenant_id || 1}`}
            </span>
          </h1>
          <p className="text-[9px] opacity-80 uppercase tracking-widest hidden sm:block">
            {user?.role === 'SUPER_ADMIN' ? 'SaaS Platform Supervisor Portal' : 'Multi-Store & POS Platform'}
          </p>
        </div>
      </div>

      {/* Center High Density Indicators */}
      <div className="hidden lg:flex items-center space-x-5 text-[10px]">
        <div className="border-r border-emerald-700 pr-4 text-right">
          <span className="block opacity-70 text-[9px] uppercase font-bold">DB Status</span>
          <span className="text-emerald-200 font-mono font-semibold">SQLite: Encrypted (WAL)</span>
        </div>

        <div className="border-r border-emerald-700 pr-4 text-right">
          <span className="block opacity-70 text-[9px] uppercase font-bold">SMS Queue</span>
          <span className={`font-semibold ${isOnline ? 'text-emerald-300' : 'text-amber-300'}`}>
            {isOnline ? 'Connected (Online)' : 'Offline (Queued)'}
          </span>
        </div>

        <div className="border-r border-emerald-700 pr-4 text-right font-mono">
          <span className="block opacity-70 text-[9px] uppercase font-bold">System Time</span>
          <span className="text-white font-bold">{currentTime}</span>
        </div>
      </div>

      {/* User Info & Session Logout */}
      {user && (
        <div className="flex items-center space-x-3">
          <div className="text-right text-[10px] leading-tight">
            <div className="font-bold uppercase tracking-wider flex items-center justify-end space-x-1">
              <span>{user.fullName}</span>
              {(user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') && <Shield className="w-3.5 h-3.5 text-amber-300 inline" />}
            </div>
            <div className="opacity-80 font-mono text-[9px]">
              {user.role !== 'CUSTOMER' && user.role !== 'SUPER_ADMIN' && <span>Terminal: POS-01 | </span>}Role: {getRoleLabel(user.role)}
            </div>
          </div>

          <button
            onClick={onLogout}
            className="bg-emerald-900 hover:bg-emerald-950 text-emerald-200 hover:text-white px-2.5 py-1 rounded border border-emerald-700 text-xs font-bold transition-all flex items-center space-x-1"
            title="Sign Out"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">EXIT</span>
          </button>
        </div>
      )}
    </header>
  </>
  );
};
