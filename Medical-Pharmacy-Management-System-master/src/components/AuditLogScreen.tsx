import { exportToExcel } from '../lib/excel';
import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { AuditLog, User, Tenant } from '../types';
import { 
  FileText, Search, Filter, RefreshCw, Trash2, Download, 
  AlertTriangle, Shield, CheckCircle, ShieldAlert, Clock, UserCheck, Lock,
  Building2, Globe, Laptop, Smartphone, Eye, EyeOff
} from 'lucide-react';

interface AuditLogScreenProps {
  currentUser?: User;
}

export const AuditLogScreen: React.FC<AuditLogScreenProps> = ({ currentUser }) => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [actionTypeFilter, setActionTypeFilter] = useState('ALL');
  const [tenantFilter, setTenantFilter] = useState<string>('ALL');
  const [tenantsList, setTenantsList] = useState<Tenant[]>([]);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);

  useEffect(() => {
    if (currentUser?.role === 'SUPER_ADMIN') {
      api.getSuperAdminTenants().then(setTenantsList).catch(() => {});
    }
  }, [currentUser]);

  const fetchAuditLogs = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getAuditLogs({
        search: searchTerm,
        action_type: actionTypeFilter,
        tenant_id: tenantFilter,
      });
      setLogs(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditLogs();
  }, [actionTypeFilter, tenantFilter]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchAuditLogs();
  };

  const handleClearLogs = async () => {
    if (!window.confirm('Are you sure you want to clear all audit logs? This action will wipe all history and log a log-clear event.')) {
      return;
    }

    try {
      await api.clearAuditLogs();
      await fetchAuditLogs();
    } catch (err: any) {
      setError(err.message || 'Failed to clear audit logs');
    }
  };

  const parseUserAgent = (ua?: string) => {
    if (!ua) return 'Unknown Device';
    let browser = 'Browser';
    let os = '';

    if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('Chrome/')) browser = 'Chrome';
    else if (ua.includes('Safari/')) browser = 'Safari';
    else if (ua.includes('Firefox/')) browser = 'Firefox';
    else if (ua.includes('Postman')) browser = 'Postman API';

    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

    return os ? `${browser} on ${os}` : browser;
  };

  const exportAuditExcel = () => {
    if (logs.length === 0) return;
    const headers = [
      'ID', 'Timestamp', 'Store Name', 'Store Tenant ID', 'User / Actor', 
      'Action Type', 'Description', 'Target Type', 'Target ID', 'IP Address', 'User Agent'
    ];
    const rows = logs.map((l) => [
      l.id,
      l.created_at,
      l.store_name || 'Default Store',
      l.tenant_id || l.user_id || 1,
      l.user_name || 'System',
      l.action_type,
      l.description,
      l.target_type || '',
      l.target_id || '',
      l.ip_address || '',
      l.user_agent || ''
    ]);

    exportToExcel([headers, ...rows], `Khushi_Store_Audit_Logs_${new Date().toISOString().split('T')[0]}`);
  };

  const getActionBadge = (type: string) => {
    const uppercaseType = type.toUpperCase();
    if (uppercaseType.includes('DELETE') || uppercaseType.includes('CLEAR') || uppercaseType.includes('REJECTED')) {
      return 'bg-rose-100 text-rose-800 border-rose-200';
    }
    if (uppercaseType.includes('ADD') || uppercaseType.includes('CREATE') || uppercaseType.includes('APPROVED')) {
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    }
    if (uppercaseType.includes('LOGIN_SUCCESS')) {
      return 'bg-blue-100 text-blue-800 border-blue-200';
    }
    if (uppercaseType.includes('LOGIN_FAILED') || uppercaseType.includes('BLOCKED')) {
      return 'bg-amber-100 text-amber-800 border-amber-300';
    }
    if (uppercaseType.includes('BACKUP') || uppercaseType.includes('VERIFY')) {
      return 'bg-purple-100 text-purple-800 border-purple-200';
    }
    return 'bg-slate-100 text-slate-700 border-slate-200';
  };

  // Calculate Security Statistics
  const totalLogsCount = logs.length;
  const loginSuccessCount = logs.filter(l => l.action_type?.toUpperCase().includes('LOGIN_SUCCESS')).length;
  const loginAlertsCount = logs.filter(l => {
    const t = l.action_type?.toUpperCase() || '';
    return t.includes('LOGIN_FAILED') || t.includes('BLOCKED') || t.includes('OTP_RATE_LIMIT');
  }).length;
  const uniqueIPsCount = new Set(logs.map(l => l.ip_address).filter(Boolean)).size;

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Shield className="w-6 h-6 text-emerald-600" />
            Store Access & System Audit Logs
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Real-time security auditing tracking store user logins, IP/User-Agent access fingerprints, stock updates, and admin permissions.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={exportAuditExcel}
            disabled={logs.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded border border-slate-300 transition"
          >
            <Download className="w-3.5 h-3.5" />
            Export Excel (.xlsx)
          </button>

          <button
            onClick={fetchAuditLogs}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded border border-emerald-300 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh Logs
          </button>

          <button
            onClick={handleClearLogs}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded border border-rose-300 transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear History
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 px-4 py-3 rounded-lg text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Security Stat Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-emerald-50 text-emerald-600">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500">Total Audit Events</div>
            <div className="text-lg font-bold text-slate-800">{totalLogsCount}</div>
          </div>
        </div>

        <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-blue-50 text-blue-600">
            <CheckCircle className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500">Successful Logins</div>
            <div className="text-lg font-bold text-blue-700">{loginSuccessCount}</div>
          </div>
        </div>

        <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex items-center gap-3">
          <div className={`p-2.5 rounded-lg ${loginAlertsCount > 0 ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-400'}`}>
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500">Security Alerts / Failed</div>
            <div className={`text-lg font-bold ${loginAlertsCount > 0 ? 'text-rose-700' : 'text-slate-800'}`}>{loginAlertsCount}</div>
          </div>
        </div>

        <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-purple-50 text-purple-600">
            <Globe className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500">Unique Origin IPs</div>
            <div className="text-lg font-bold text-purple-700">{uniqueIPsCount}</div>
          </div>
        </div>
      </div>

      {/* Filter and Search Form */}
      <form onSubmit={handleSearchSubmit} className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex flex-col sm:flex-row gap-2 justify-between items-center">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search details, actor, IP address, user agent, or store..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-end">
          {currentUser?.role === 'SUPER_ADMIN' && (
            <div className="flex items-center gap-1.5 text-xs text-slate-600 font-medium">
              <span>Store:</span>
              <select
                value={tenantFilter}
                onChange={(e) => setTenantFilter(e.target.value)}
                className="px-2.5 py-1 border border-slate-300 rounded text-xs bg-slate-50 focus:outline-none font-semibold text-emerald-700"
              >
                <option value="ALL">All Stores</option>
                {tenantsList.map(t => (
                  <option key={t.id} value={t.id}>
                    #{t.id} - {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-1.5 text-xs text-slate-600 font-medium">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>Category:</span>
            <select
              value={actionTypeFilter}
              onChange={(e) => setActionTypeFilter(e.target.value)}
              className="px-2.5 py-1 border border-slate-300 rounded text-xs bg-slate-50 focus:outline-none font-medium"
            >
              <option value="ALL">All Actions</option>
              <option value="LOGIN">All User Logins & Auth</option>
              <option value="LOGIN_FAILED">Login Failures & Security Locks</option>
              <option value="LOGIN_SUCCESS">Successful Logins</option>
              <option value="PRODUCT">Inventory & Stock</option>
              <option value="SALE">Sales & Invoice Deletions</option>
              <option value="CUSTOMER">Customers & Payments</option>
              <option value="USER">User Verification & Roles</option>
              <option value="BACKUP">Database Backups & Restores</option>
              <option value="SUPERADMIN">Super Admin Actions</option>
            </select>
          </div>

          <button
            type="submit"
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded shadow-sm"
          >
            Filter
          </button>
        </div>
      </form>

      {/* Audit Log Table */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-500 text-xs flex justify-center items-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin text-emerald-600" /> Querying security audit log database...
          </div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-xs">
            No audit log records found matching your criteria.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200 uppercase tracking-wider text-[10px]">
                  <th className="py-2.5 px-3">Timestamp</th>
                  <th className="py-2.5 px-3">Store Identifier</th>
                  <th className="py-2.5 px-3">User / Actor</th>
                  <th className="py-2.5 px-3 hidden md:table-cell">Action Type</th>
                  <th className="py-2.5 px-3">Log Details</th>
                  <th className="py-2.5 px-3 hidden lg:table-cell">Network & IP</th>
                  <th className="py-2.5 px-3 text-right">Device / UA Info</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-sans">
                {logs.map((log) => {
                  const isExpanded = expandedLogId === log.id;
                  const isLoginFailed = log.action_type?.toUpperCase().includes('LOGIN_FAILED') || log.action_type?.toUpperCase().includes('BLOCKED');
                  const isLoginSuccess = log.action_type?.toUpperCase().includes('LOGIN_SUCCESS');

                  return (
                    <React.Fragment key={log.id}>
                      <tr className={`hover:bg-slate-50 transition ${isLoginFailed ? 'bg-rose-50/40' : isLoginSuccess ? 'bg-blue-50/30' : ''}`}>
                        <td className="py-2.5 px-3 text-slate-600 text-[11px] whitespace-nowrap font-mono">
                          <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3 text-slate-400" />
                            {new Date(log.created_at).toLocaleString('en-PK')}
                          </div>
                        </td>

                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                            <Building2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                            <span className="truncate max-w-[140px]" title={log.store_name}>
                              {log.store_name || 'Default Store'}
                            </span>
                            <span className="text-[10px] text-slate-400 bg-slate-100 px-1 py-0.2 rounded font-mono">
                              #{log.tenant_id || 1}
                            </span>
                          </div>
                        </td>

                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <div className="font-bold text-slate-800 flex items-center gap-1">
                            <UserCheck className="w-3 h-3 text-slate-400" />
                            {log.user_name || 'System / Guest'}
                          </div>
                        </td>

                        <td className="py-2.5 px-3 whitespace-nowrap hidden md:table-cell">
                          <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${getActionBadge(log.action_type)}`}>
                            {log.action_type}
                          </span>
                        </td>

                        <td className="py-2.5 px-3 text-slate-700 font-medium max-w-sm">
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5 md:block">
                              <span className={`md:hidden px-1.5 py-0.2 rounded text-[9px] font-bold border ${getActionBadge(log.action_type)}`}>
                                {log.action_type}
                              </span>
                              <span className={isLoginFailed ? 'text-rose-900 font-semibold' : ''}>{log.description}</span>
                            </div>
                            {log.target_type && (
                              <span className="text-[10px] text-slate-400 font-mono">
                                Target: {log.target_type} #{log.target_id || ''}
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="py-2.5 px-3 text-slate-600 font-mono text-[11px] whitespace-nowrap hidden lg:table-cell">
                          <div className="flex items-center gap-1">
                            <Globe className="w-3 h-3 text-slate-400" />
                            <span>{log.ip_address || '127.0.0.1'}</span>
                          </div>
                        </td>

                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            <span className="text-[11px] text-slate-500 font-mono hidden sm:inline-block">
                              {parseUserAgent(log.user_agent)}
                            </span>
                            <button
                              onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                              className="p-1 hover:bg-slate-200 text-slate-500 rounded transition"
                              title="Toggle full User-Agent & IP technical details"
                            >
                              {isExpanded ? <EyeOff className="w-3.5 h-3.5 text-emerald-600" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expandable Technical Access Details Drawer */}
                      {isExpanded && (
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <td colSpan={7} className="p-3">
                            <div className="bg-slate-800 text-slate-100 text-xs p-3 rounded-lg space-y-2 font-mono shadow-inner">
                              <div className="flex items-center justify-between border-b border-slate-700 pb-1.5 text-emerald-400 font-bold">
                                <span>Security Fingerprint & Network Metadata</span>
                                <span>Log Entry #{log.id}</span>
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                                <div>
                                  <span className="text-slate-400">Store / Tenant:</span>{' '}
                                  <span className="text-slate-200 font-semibold">{log.store_name || 'Default Store'} (Tenant ID #{log.tenant_id || 1})</span>
                                </div>
                                <div>
                                  <span className="text-slate-400">Actor / Username:</span>{' '}
                                  <span className="text-slate-200 font-semibold">{log.user_name || 'System / Guest'} (ID #{log.user_id || 'N/A'})</span>
                                </div>
                                <div>
                                  <span className="text-slate-400">Origin IP Address:</span>{' '}
                                  <span className="text-amber-300 font-semibold">{log.ip_address || '127.0.0.1'}</span>
                                </div>
                                <div>
                                  <span className="text-slate-400">Client Platform:</span>{' '}
                                  <span className="text-sky-300 font-semibold">{parseUserAgent(log.user_agent)}</span>
                                </div>
                              </div>
                              <div className="pt-1">
                                <span className="text-slate-400 block text-[10px] mb-0.5">Raw User-Agent Header String:</span>
                                <div className="bg-slate-900/80 p-2 rounded text-[10px] text-slate-300 break-all select-all border border-slate-700">
                                  {log.user_agent || 'No User-Agent header supplied (e.g. Server Internal Job / Direct Curl Request)'}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
