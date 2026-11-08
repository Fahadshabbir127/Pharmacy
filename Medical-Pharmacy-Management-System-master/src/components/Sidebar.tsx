import React from 'react';
import { UserRole } from '../types';
import { 
  ShoppingCart, 
  Package, 
  Users, 
  Truck, 
  BarChart3, 
  Mail, 
  Settings, 
  UserCheck,
  AlertTriangle,
  Clock,
  ShieldCheck,
  FileText
} from 'lucide-react';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  userRole: UserRole;
  allowedServices?: string;
  lowStockCount?: number;
  expiringCount?: number;
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ 
  activeTab, 
  setActiveTab, 
  userRole,
  allowedServices,
  lowStockCount = 0,
  expiringCount = 0,
  isMobileOpen = false,
  onCloseMobile
}) => {
  const handleItemClick = (tabId: string) => {
    setActiveTab(tabId);
    if (onCloseMobile) onCloseMobile();
  };
  
  if (userRole === 'CUSTOMER') {
    return (
      <>
        {isMobileOpen && (
          <div 
            onClick={onCloseMobile}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs z-40 md:hidden"
          />
        )}
        <aside className={`bg-slate-900 border-r border-slate-800 p-4 text-slate-300 z-40 transition-all ${
          isMobileOpen ? 'fixed inset-y-0 left-0 w-64 shadow-2xl flex flex-col' : 'hidden md:block w-64 min-h-[calc(100vh-4rem)]'
        }`}>
          <div className="mb-6 px-3 py-2 bg-emerald-950/60 border border-emerald-800/60 rounded-xl text-center">
            <p className="text-xs text-emerald-400 font-semibold">Self-Service Customer Portal</p>
            <p className="text-[10px] text-slate-400">اپنا ادھار اور بل دیکھیں</p>
          </div>
          <nav className="space-y-1">
            <button
              onClick={() => handleItemClick('customer-portal')}
              className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                activeTab === 'customer-portal' 
                  ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/30' 
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <UserCheck className="w-4 h-4" />
              <span>My Account Statement</span>
            </button>
          </nav>
        </aside>
      </>
    );
  }

  const allServicesList = (allowedServices || 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES,REPORTS,EMAIL_ALERTS,USER_VERIFY,AUDIT_LOGS,SETTINGS,CUSTOMER_PORTAL').split(',');

  const navItems = [
    {
      id: 'superadmin',
      label: 'Super Admin Supervisor',
      urduLabel: 'سپر ایڈمن ہب',
      icon: ShieldCheck,
      roles: ['SUPER_ADMIN'],
      serviceKey: null
    },
    {
      id: 'billing',
      label: 'Billing / POS',
      urduLabel: 'بلنگ',
      icon: ShoppingCart,
      roles: ['ADMIN', 'STAFF'],
      shortcut: 'F1',
      serviceKey: 'POS_BILLING'
    },
    {
      id: 'sales',
      label: 'Sales Register',
      urduLabel: 'برائے فروخت لاگ',
      icon: ShoppingCart,
      roles: ['ADMIN', 'STAFF'],
      serviceKey: 'POS_BILLING'
    },
    {
      id: 'inventory',
      label: 'Inventory & Stock',
      urduLabel: 'سٹاک انٹرسٹ',
      icon: Package,
      roles: ['ADMIN', 'STAFF'],
      shortcut: 'F2',
      badge: lowStockCount > 0 ? lowStockCount : undefined,
      badgeColor: 'bg-rose-600',
      serviceKey: 'INVENTORY'
    },
    {
      id: 'customers',
      label: 'Customers & Udhar',
      urduLabel: 'ادھار کھاتہ',
      icon: Users,
      roles: ['ADMIN', 'STAFF'],
      serviceKey: 'UDHAR_KHATTA'
    },
    {
      id: 'purchases',
      label: 'Purchases & Stock-In',
      urduLabel: 'خریداری',
      icon: Truck,
      roles: ['ADMIN'],
      serviceKey: 'PURCHASES'
    },
    {
      id: 'reports',
      label: 'Sales & Profit Reports',
      urduLabel: 'رپورٹس',
      icon: BarChart3,
      roles: ['ADMIN'],
      serviceKey: 'REPORTS'
    },
    {
      id: 'email',
      label: 'Email Alert Center',
      urduLabel: 'ای میل الرٹس',
      icon: Mail,
      roles: ['SUPER_ADMIN', 'ADMIN', 'STAFF'],
      serviceKey: 'EMAIL_ALERTS'
    },
    {
      id: 'users',
      label: 'User Verification',
      urduLabel: 'صارفین کی منظوری',
      icon: ShieldCheck,
      roles: ['SUPER_ADMIN', 'ADMIN'],
      serviceKey: 'USER_VERIFY'
    },
    {
      id: 'audit',
      label: 'System Audit Logs',
      urduLabel: 'سیکیورٹی لاگز',
      icon: FileText,
      roles: ['SUPER_ADMIN', 'ADMIN'],
      serviceKey: 'AUDIT_LOGS'
    },
    {
      id: 'settings',
      label: 'Settings & Backups',
      urduLabel: 'سیٹنگز اور بیک اپ',
      icon: Settings,
      roles: ['SUPER_ADMIN', 'ADMIN'],
      serviceKey: 'SETTINGS'
    }
  ];

  const allowedItems = navItems.filter(item => {
    if (!item.roles.includes(userRole)) return false;
    if (userRole === 'SUPER_ADMIN') return true;
    if (!item.serviceKey) return true;
    return allServicesList.includes(item.serviceKey);
  });

  return (
    <>
      {isMobileOpen && (
        <div 
          onClick={onCloseMobile}
          className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs z-40 md:hidden"
        />
      )}
      <aside className={`bg-slate-900 border-r border-slate-800 p-2 text-slate-300 flex flex-col justify-between shrink-0 select-none z-40 transition-all ${
        isMobileOpen 
          ? 'fixed inset-y-0 left-0 w-64 shadow-2xl overflow-y-auto' 
          : 'hidden md:flex w-56'
      }`}>
        <div>
          <div className="mb-2 px-2.5 py-1.5 bg-slate-800/80 border border-slate-700/80 rounded flex items-center justify-between text-[11px]">
            <span className="font-bold text-slate-200 uppercase tracking-wider text-[9px]">POS Terminal</span>
            <span className="text-[9px] bg-emerald-950 text-emerald-400 font-mono font-bold px-1.5 py-0.5 rounded border border-emerald-800">
              ONLINE
            </span>
          </div>

          <nav className="space-y-1">
            {allowedItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleItemClick(item.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-2 rounded text-xs font-semibold transition-all ${
                    isActive
                      ? 'bg-emerald-600 text-white font-bold shadow-sm'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/80'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                    <div className="text-left leading-tight">
                      <div className="text-[12px]">{item.label}</div>
                      <div className="text-[9px] opacity-75 font-sans">{item.urduLabel}</div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-1">
                    {item.shortcut && (
                      <span className="text-[9px] bg-slate-800 text-slate-300 font-mono px-1 py-0.5 rounded border border-slate-700 font-bold">
                        {item.shortcut}
                      </span>
                    )}
                    {item.badge !== undefined && (
                      <span className={`text-[10px] text-white font-bold px-1.5 py-0.5 rounded-full ${item.badgeColor || 'bg-rose-600'}`}>
                        {item.badge}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </nav>
        </div>

        {/* High Density Stock Alerts Summary Widget */}
        <div className="pt-2 border-t border-slate-800 space-y-1.5">
          {lowStockCount > 0 && (
            <div 
              onClick={() => handleItemClick('inventory')}
              className="p-2 rounded bg-orange-950/50 border border-orange-800/80 text-orange-200 text-[11px] flex items-center justify-between cursor-pointer hover:bg-orange-900/60 transition-colors"
            >
              <div className="flex items-center space-x-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-orange-400" />
                <span className="font-bold">Low Stock</span>
              </div>
              <span className="font-bold bg-orange-800 text-white px-1.5 py-0.5 rounded text-[10px]">
                {lowStockCount} Items
              </span>
            </div>
          )}

          {expiringCount > 0 && (
            <div 
              onClick={() => handleItemClick('inventory')}
              className="p-2 rounded bg-rose-950/50 border border-rose-800/80 text-rose-200 text-[11px] flex items-center justify-between cursor-pointer hover:bg-rose-900/60 transition-colors"
            >
              <div className="flex items-center space-x-1.5">
                <Clock className="w-3.5 h-3.5 text-rose-400" />
                <span className="font-bold">Expiring 90d</span>
              </div>
              <span className="font-bold bg-rose-800 text-white px-1.5 py-0.5 rounded text-[10px]">
                {expiringCount} Batches
              </span>
            </div>
          )}

          <div className="p-2 bg-slate-800/60 rounded border border-slate-800 text-[10px] text-slate-400 text-center leading-tight">
            <p className="font-bold text-slate-300">Khushi Medical Hall</p>
            <p className="text-[9px] text-emerald-400 font-mono mt-0.5">LOCAL DB ACTIVE</p>
          </div>
        </div>
      </aside>
    </>
  );
};
