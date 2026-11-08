import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { User, UserRole, UserStatus } from '../types';
import { Users, UserCheck, UserX, Shield, Key, Search, RefreshCw, CheckCircle, AlertTriangle, Trash2, Edit3, UserPlus, Info, Check, X, ShieldAlert, Eye, EyeOff, Lock, Sliders, Store, Zap } from 'lucide-react';

export const UserManagementScreen: React.FC<{ currentUser?: User }> = ({ currentUser }) => {
  const canRegister = currentUser?.role === 'SUPER_ADMIN' || currentUser?.allowed_services?.includes('USER_REGISTER');
  const canReset = currentUser?.role === 'SUPER_ADMIN' || currentUser?.allowed_services?.includes('USER_RESET_PASSWORD');
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  const [activeTab, setActiveTab] = useState<'accounts' | 'staff-permissions'>('accounts');

  // Modals
  const [resetModalUser, setResetModalUser] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [showAddPwd, setShowAddPwd] = useState(false);
  const [pwdError, setPwdError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const [roleModalUser, setRoleModalUser] = useState<User | null>(null);
  const [selectedRole, setSelectedRole] = useState<UserRole>('STAFF');

  // Staff Permissions State
  const [selectedStaffUser, setSelectedStaffUser] = useState<User | null>(null);
  const [staffPermissions, setStaffPermissions] = useState<string[]>([]);
  const [permSuccess, setPermSuccess] = useState('');
  const [permError, setPermError] = useState('');

  // Create User Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [addUsername, setAddUsername] = useState('');
  const [addFullName, setAddFullName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addRole, setAddRole] = useState<'ADMIN' | 'STAFF' | 'CUSTOMER'>('STAFF');
  const [addPassword, setAddPassword] = useState('');
  const [addPermissions, setAddPermissions] = useState<string[]>(['POS_BILLING', 'INVENTORY', 'UDHAR_KHATTA', 'PURCHASES']);
  const [addError, setAddError] = useState('');

  const ALL_STAFF_PERMISSIONS = [
    { key: 'POS_BILLING', name: 'Process Billing & Sales POS', urdu: 'بلنگ اور فروخت کا اندراج', desc: 'Allow staff to search items, create sales, print receipts, and view sales history.' },
    { key: 'INVENTORY', name: 'Manage Inventory & Stock', urdu: 'ادویات اور سٹاک مینجمنٹ', desc: 'Allow staff to add/edit medicines, update batch numbers, stock levels, and pricing.' },
    { key: 'UDHAR_KHATTA', name: 'Customers & Udhar Khatta', urdu: 'گاہک اور ادھار کھاتہ', desc: 'Allow staff to view customer ledgers, collect payments, and send WhatsApp/SMS debt reminders.' },
    { key: 'PURCHASES', name: 'Purchases & Supplier Stock-In', urdu: 'خریداری اور نیا سٹاک', desc: 'Allow staff to record purchase orders and incoming inventory shipments from distributors.' },
    { key: 'REPORTS', name: 'Sales & Profit Reports', urdu: 'سیلز اور منافع رپورٹس', desc: 'Allow staff to view store revenue, daily sales graphs, and profit summaries.' },
    { key: 'EMAIL_ALERTS', name: 'Email & SMS Alert Center', urdu: 'ای میل اور ایس ایم ایس الرٹس', desc: 'Allow staff to queue and send customer account statements and notifications.' },
    { key: 'USER_VERIFY', name: 'User Verification & Customer Approval', urdu: 'صارفین کی منظوری', desc: 'Allow staff to approve or verify customer self-registration portal accounts.' },
    { key: 'AUDIT_LOGS', name: 'System Audit Logs', urdu: 'سیکیورٹی اور سرگرمی لاگز', desc: 'Allow staff to view activity logs and security audits.' },
    { key: 'SETTINGS', name: 'Store Settings & Printers', urdu: 'سٹور سیٹنگز', desc: 'Allow staff to configure receipt printers and thermal invoice headers.' },
  ];

  const fetchUsers = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getUsers();
      setUsers(data);

      // Auto-select first staff member if none selected
      const staffList = data.filter(u => u.role === 'STAFF');
      if (staffList.length > 0 && !selectedStaffUser) {
        setSelectedStaffUser(staffList[0]);
        const initialPerms = (staffList[0].allowed_services || 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES').split(',').map(s => s.trim()).filter(Boolean);
        setStaffPermissions(initialPerms);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleSelectStaffUser = (user: User) => {
    setSelectedStaffUser(user);
    const perms = (user.allowed_services || 'POS_BILLING,INVENTORY,UDHAR_KHATTA,PURCHASES').split(',').map(s => s.trim()).filter(Boolean);
    setStaffPermissions(perms);
    setPermSuccess('');
    setPermError('');
  };

  const handleTogglePermission = (key: string) => {
    setStaffPermissions(prev => 
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const handleApplyPreset = (presetKeys: string[]) => {
    setStaffPermissions(presetKeys);
  };

  const handleSaveStaffPermissions = async () => {
    if (!selectedStaffUser) return;
    setActionLoading(true);
    setPermSuccess('');
    setPermError('');
    try {
      const res = await api.updateUserPermissions(selectedStaffUser.id, staffPermissions);
      setPermSuccess(res.message || `Permissions updated for @${selectedStaffUser.username}`);
      await fetchUsers();
    } catch (err: any) {
      setPermError(err.message || 'Failed to update staff permissions');
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdateStatus = async (id: number, status: UserStatus) => {
    setActionLoading(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await api.updateUserStatus(id, status);
      setSuccessMsg(res.message || `User status updated to ${status}`);
      await fetchUsers();
    } catch (err: any) {
      setError(err.message || 'Failed to update user status');
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdateRole = async () => {
    if (!roleModalUser) return;
    setActionLoading(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await api.updateUserRole(roleModalUser.id, selectedRole);
      setSuccessMsg(res.message);
      setRoleModalUser(null);
      await fetchUsers();
    } catch (err: any) {
      setError(err.message || 'Failed to update role');
    } finally {
      setActionLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetModalUser) return;

    if (!newPassword || newPassword.length < 8) {
      setPwdError('Password must be at least 8 characters long');
      return;
    }
    const hasLetter = /[A-Za-z]/.test(newPassword);
    const hasNumOrSym = /[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword);
    if (!hasLetter || !hasNumOrSym) {
      setPwdError('Password must contain both letters and numbers/symbols.');
      return;
    }

    setActionLoading(true);
    setPwdError('');
    try {
      const res = await api.resetUserPassword(resetModalUser.id, newPassword);
      setSuccessMsg(res.message);
      setResetModalUser(null);
      setNewPassword('');
    } catch (err: any) {
      setPwdError(err.message || 'Failed to reset password');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError('');
    if (!addUsername || !addFullName || !addPassword) {
      setAddError('Username, Full Name, and Password are required.');
      return;
    }

    if (addPassword.length < 8) {
      setAddError('Password must be at least 8 characters long.');
      return;
    }

    setActionLoading(true);
    try {
      const res = await api.createSystemUser({
        username: addUsername,
        password: addPassword,
        fullName: addFullName,
        role: addRole,
        email: addEmail,
        phone: addPhone,
        allowed_services: addRole === 'STAFF' ? addPermissions : undefined,
      });
      setSuccessMsg(res.message);
      setShowAddModal(false);
      setAddUsername('');
      setAddFullName('');
      setAddEmail('');
      setAddPhone('');
      setAddPassword('');
      await fetchUsers();
    } catch (err: any) {
      setAddError(err.message || 'Failed to create user account.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteUser = async (id: number, username: string) => {
    if (!window.confirm(`Are you sure you want to delete user "${username}"? This action cannot be undone.`)) {
      return;
    }

    setActionLoading(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await api.deleteUser(id);
      setSuccessMsg(res.message);
      await fetchUsers();
    } catch (err: any) {
      setError(err.message || 'Failed to delete user');
    } finally {
      setActionLoading(false);
    }
  };

  const filteredUsers = users.filter((u) => {
    const username = (u.username || '').toLowerCase();
    const fullName = (u.fullName || u.full_name || '').toLowerCase();
    const email = (u.email || '').toLowerCase();
    const phone = u.phone || '';
    const q = (searchTerm || '').toLowerCase();

    const matchesSearch =
      username.includes(q) ||
      fullName.includes(q) ||
      email.includes(q) ||
      phone.includes(searchTerm);

    const matchesStatus = statusFilter === 'ALL' || u.status === statusFilter;
    const matchesRole = roleFilter === 'ALL' || u.role === roleFilter;

    return matchesSearch && matchesStatus && matchesRole;
  });

  const pendingCount = users.filter((u) => u.status === 'PENDING').length;
  const approvedCount = users.filter((u) => u.status === 'APPROVED').length;
  const adminCount = users.filter((u) => u.role === 'ADMIN').length;
  const staffCount = users.filter((u) => u.role === 'STAFF').length;

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Users className="w-6 h-6 text-emerald-600" />
            User Management & Authorization
          </h1>
          <p className="text-xs text-slate-5-00 mt-0.5">
            Admin verification for new user registrations and role control. Self password reset is disabled.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {canRegister && (
            <button
              onClick={() => {
                setShowAddModal(true);
                setAddError('');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded shadow-sm transition"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Add New User</span>
            </button>
          )}

          <button
            onClick={fetchUsers}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded border border-slate-300 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh List
          </button>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 px-4 py-3 rounded-lg text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-lg text-xs flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-200 bg-white px-3 pt-2 rounded-t-lg">
        <button
          onClick={() => setActiveTab('accounts')}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-bold border-b-2 transition-colors ${
            activeTab === 'accounts'
              ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50'
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>User Accounts Registry</span>
          <span className="ml-1 text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-full font-bold">
            {users.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('staff-permissions')}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-bold border-b-2 transition-colors ${
            activeTab === 'staff-permissions'
              ? 'border-indigo-600 text-indigo-700 bg-indigo-50/50'
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
          }`}
        >
          <Sliders className="w-4 h-4 text-indigo-600" />
          <span>Staff Permissions Module</span>
          <span className="ml-1 text-[10px] bg-indigo-100 text-indigo-800 px-1.5 py-0.5 rounded-full font-bold">
            {staffCount} Staff
          </span>
        </button>
      </div>

      {activeTab === 'accounts' ? (
        <>
          {/* Pending Approval Notice Banner */}
          {pendingCount > 0 && (
            <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-r-lg shadow-sm flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-xs font-bold text-amber-900 uppercase tracking-wider">
                  Verification Required ({pendingCount} New Registrations)
                </h3>
                <p className="text-xs text-amber-800 mt-0.5">
                  {pendingCount} user account(s) are waiting for your approval before they can log in to Khushi Medical Hall.
                </p>
              </div>
              <button
                onClick={() => setStatusFilter('PENDING')}
                className="px-2.5 py-1 text-xs font-bold bg-amber-600 text-white hover:bg-amber-700 rounded shadow-sm"
              >
                View Pending ({pendingCount})
              </button>
            </div>
          )}

          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <div className="text-[10px] font-bold uppercase text-slate-400">Total Users</div>
                <div className="text-xl font-bold text-slate-800 mt-0.5">{users.length}</div>
              </div>
              <Users className="w-8 h-8 text-slate-300" />
            </div>

            <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <div className="text-[10px] font-bold uppercase text-amber-600">Pending Verification</div>
                <div className="text-xl font-bold text-amber-700 mt-0.5">{pendingCount}</div>
              </div>
              <AlertTriangle className="w-8 h-8 text-amber-200" />
            </div>

            <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <div className="text-[10px] font-bold uppercase text-emerald-600">Active Approved</div>
                <div className="text-xl font-bold text-emerald-700 mt-0.5">{approvedCount}</div>
              </div>
              <UserCheck className="w-8 h-8 text-emerald-200" />
            </div>

            <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <div className="text-[10px] font-bold uppercase text-indigo-600">Admins & Staff</div>
                <div className="text-xl font-bold text-indigo-700 mt-0.5">{adminCount + staffCount}</div>
              </div>
              <Shield className="w-8 h-8 text-indigo-200" />
            </div>
          </div>

      {/* Filter and Search Controls */}
      <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm flex flex-col sm:flex-row gap-2 justify-between items-center">
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search username, name, email, phone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="flex items-center gap-1 text-xs text-slate-600 font-medium shrink-0">
            <span>Status:</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-2 py-1 border border-slate-300 rounded text-xs bg-slate-50 focus:outline-none"
            >
              <option value="ALL">All Statuses</option>
              <option value="PENDING">Pending Only</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>

          <div className="flex items-center gap-1 text-xs text-slate-600 font-medium shrink-0">
            <span>Role:</span>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="px-2 py-1 border border-slate-300 rounded text-xs bg-slate-50 focus:outline-none"
            >
              <option value="ALL">All Roles</option>
              <option value="ADMIN">Admin</option>
              <option value="STAFF">Pharmacist Staff</option>
              <option value="CUSTOMER">Customer</option>
            </select>
          </div>
        </div>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-500 text-xs flex justify-center items-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin text-emerald-600" /> Loading user registry...
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-xs">
            No user accounts found matching your filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200 uppercase tracking-wider text-[10px]">
                  <th className="py-2.5 px-3">User Details</th>
                  <th className="py-2.5 px-3 hidden sm:table-cell">Contact Email & Phone</th>
                  <th className="py-2.5 px-3 hidden md:table-cell">Role</th>
                  <th className="py-2.5 px-3">Verification Status</th>
                  <th className="py-2.5 px-3 hidden lg:table-cell">Created Date</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredUsers.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50 transition">
                    <td className="py-2.5 px-3">
                      <div className="font-bold text-slate-800">{u.fullName || u.full_name || u.username}</div>
                      <div className="text-[11px] text-slate-500 font-mono">@{u.username}</div>
                      <div className="sm:hidden text-[10px] text-slate-500 mt-0.5">
                        {u.phone || u.email || '—'}
                      </div>
                      <div className="md:hidden mt-1">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                          u.role === 'ADMIN' ? 'bg-purple-100 text-purple-800' : u.role === 'STAFF' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'
                        }`}>
                          {u.role}
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 hidden sm:table-cell">
                      <div className="text-slate-700">{u.email || '—'}</div>
                      <div className="text-[11px] text-slate-500">{u.phone || '—'}</div>
                    </td>
                    <td className="py-2.5 px-3 hidden md:table-cell">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          u.role === 'SUPER_ADMIN' || u.email === 'umarumair75108db@gmail.com'
                            ? 'bg-amber-100 text-amber-900 border border-amber-300 font-black'
                            : u.role === 'ADMIN'
                            ? 'bg-purple-100 text-purple-800 border border-purple-200'
                            : u.role === 'STAFF'
                            ? 'bg-blue-100 text-blue-800 border border-blue-200'
                            : 'bg-slate-100 text-slate-700 border border-slate-200'
                        }`}
                      >
                        <Shield className="w-2.5 h-2.5" />
                        {u.role === 'SUPER_ADMIN' || u.email === 'umarumair75108db@gmail.com' 
                          ? 'Protected Super Admin' 
                          : u.role === 'ADMIN' ? 'System Admin' : u.role === 'STAFF' ? 'Pharmacist' : 'Customer'}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                          u.status === 'APPROVED'
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                            : u.status === 'PENDING'
                            ? 'bg-amber-100 text-amber-800 border border-amber-300 animate-pulse'
                            : 'bg-rose-100 text-rose-800 border border-rose-200'
                        }`}
                      >
                        {u.status === 'APPROVED' && <CheckCircle className="w-3 h-3 text-emerald-600" />}
                        {u.status === 'PENDING' && <AlertTriangle className="w-3 h-3 text-amber-600" />}
                        {u.status === 'REJECTED' && <UserX className="w-3 h-3 text-rose-600" />}
                        {u.status || 'APPROVED'}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-slate-500 text-[11px] hidden lg:table-cell">
                      {u.created_at ? new Date(u.created_at).toLocaleDateString() : 'N/A'}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      {u.email === 'umarumair75108db@gmail.com' || u.role === 'SUPER_ADMIN' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded">
                          <ShieldAlert className="w-3.5 h-3.5 text-amber-600" /> System Protected
                        </span>
                      ) : (
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Approval buttons if pending */}
                          {u.status === 'PENDING' && (
                            <>
                              <button
                                onClick={() => handleUpdateStatus(u.id, 'APPROVED')}
                                disabled={actionLoading}
                                className="px-2 py-1 text-[11px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded shadow-sm flex items-center gap-1"
                                title="Approve User Access"
                              >
                                <Check className="w-3 h-3" /> Approve
                              </button>
                              <button
                                onClick={() => handleUpdateStatus(u.id, 'REJECTED')}
                                disabled={actionLoading}
                                className="px-2 py-1 text-[11px] font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-300 rounded flex items-center gap-1"
                                title="Reject Registration"
                              >
                                <X className="w-3 h-3" /> Reject
                              </button>
                            </>
                          )}

                          {/* Reset status if already decided */}
                          {u.status !== 'PENDING' && (
                            <button
                              onClick={() => handleUpdateStatus(u.id, u.status === 'APPROVED' ? 'SUSPENDED' : 'APPROVED')}
                              disabled={actionLoading}
                              className={`px-2 py-1 text-[11px] font-bold rounded flex items-center gap-1 transition-colors ${
                                u.status === 'APPROVED'
                                  ? 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
                                  : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'
                              }`}
                              title={u.status === 'APPROVED' ? 'Suspend Access' : 'Grant Access (Approve)'}
                            >
                              {u.status === 'APPROVED' ? (
                                <>
                                  <UserX className="w-3 h-3 text-amber-600" /> Suspend
                                </>
                              ) : (
                                <>
                                  <UserCheck className="w-3 h-3 text-emerald-600" /> Activate
                                </>
                              )}
                            </button>
                          )}

                          {/* Change Role Button */}
                          <button
                            onClick={() => {
                              setRoleModalUser(u);
                              setSelectedRole(u.role);
                            }}
                            className="p-1.5 text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded border border-slate-200"
                            title="Change User Role"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>

                          {/* Reset Password Button */}
                          {canReset && (
                            <button
                              onClick={() => {
                                setResetModalUser(u);
                                setNewPassword('');
                                setPwdError('');
                              }}
                              className="p-1.5 text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded border border-indigo-200"
                              title="Admin Reset Password"
                            >
                              <Key className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {/* Delete User */}
                          <button
                            onClick={() => handleDeleteUser(u.id, u.username)}
                            disabled={actionLoading}
                            className="px-2 py-1 text-[11px] font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded flex items-center gap-1"
                            title="Delete User Account"
                          >
                            <Trash2 className="w-3 h-3 text-rose-600" /> Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
    ) : (
        /* Staff Permissions View */
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-5 space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
                <Sliders className="w-5 h-5 text-indigo-600" />
                Staff Role & Service Permission Matrix
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Grant or restrict specific module access for each pharmacist and staff account in your store.
              </p>
            </div>

            {/* Select Staff Member Dropdown */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold text-slate-700 whitespace-nowrap">Select Staff Account:</label>
              <select
                value={selectedStaffUser?.id || ''}
                onChange={(e) => {
                  const u = users.find(usr => usr.id === Number(e.target.value));
                  if (u) handleSelectStaffUser(u);
                }}
                className="px-3 py-1.5 border border-slate-300 rounded text-xs font-bold bg-slate-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 min-w-[220px]"
              >
                {users.filter(u => u.role === 'STAFF').map((staff) => (
                  <option key={staff.id} value={staff.id}>
                    @{staff.username} — {staff.fullName} ({staff.status})
                  </option>
                ))}
                {users.filter(u => u.role === 'STAFF').length === 0 && (
                  <option value="" disabled>No staff accounts found</option>
                )}
              </select>
            </div>
          </div>

          {selectedStaffUser ? (
            <div className="space-y-5">
              {/* Staff Member Info Banner */}
              <div className="bg-indigo-50/70 border border-indigo-200 p-4 rounded-lg flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-sm shadow-sm">
                    {selectedStaffUser.fullName.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-bold text-slate-800 flex items-center gap-2">
                      <span>{selectedStaffUser.fullName}</span>
                      <span className="text-xs font-mono text-indigo-700 font-semibold bg-indigo-100 px-2 py-0.5 rounded">
                        @{selectedStaffUser.username}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5 flex items-center gap-3">
                      <span>Role: <strong className="text-indigo-800">{selectedStaffUser.role}</strong></span>
                      {selectedStaffUser.phone && <span>Phone: {selectedStaffUser.phone}</span>}
                      {selectedStaffUser.email && <span>Email: {selectedStaffUser.email}</span>}
                    </div>
                  </div>
                </div>

                {/* Quick Presets */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mr-1">Presets:</span>
                  <button
                    onClick={() => handleApplyPreset(['POS_BILLING', 'INVENTORY', 'UDHAR_KHATTA', 'PURCHASES', 'REPORTS', 'EMAIL_ALERTS', 'USER_VERIFY', 'AUDIT_LOGS', 'SETTINGS'])}
                    className="px-2 py-1 text-[11px] font-bold bg-white text-indigo-700 hover:bg-indigo-100 border border-indigo-300 rounded shadow-2xs"
                  >
                    Full Access
                  </button>
                  <button
                    onClick={() => handleApplyPreset(['POS_BILLING', 'INVENTORY', 'UDHAR_KHATTA', 'PURCHASES'])}
                    className="px-2 py-1 text-[11px] font-bold bg-white text-emerald-700 hover:bg-emerald-100 border border-emerald-300 rounded shadow-2xs"
                  >
                    Standard Counter Staff
                  </button>
                  <button
                    onClick={() => handleApplyPreset(['POS_BILLING', 'UDHAR_KHATTA'])}
                    className="px-2 py-1 text-[11px] font-bold bg-white text-amber-700 hover:bg-amber-100 border border-amber-300 rounded shadow-2xs"
                  >
                    POS Only
                  </button>
                </div>
              </div>

              {/* Feedback messages */}
              {permError && (
                <div className="bg-rose-50 border border-rose-200 text-rose-800 px-4 py-2.5 rounded text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{permError}</span>
                </div>
              )}

              {permSuccess && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-2.5 rounded text-xs flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>{permSuccess}</span>
                </div>
              )}

              {/* Permissions Checkbox Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {ALL_STAFF_PERMISSIONS.map((p) => {
                  const isChecked = staffPermissions.includes(p.key);
                  return (
                    <div
                      key={p.key}
                      onClick={() => handleTogglePermission(p.key)}
                      className={`p-3.5 rounded-lg border transition-all cursor-pointer select-none flex items-start gap-3 ${
                        isChecked
                          ? 'bg-indigo-50/40 border-indigo-400 shadow-xs ring-1 ring-indigo-400/30'
                          : 'bg-slate-50/60 border-slate-200 hover:border-slate-300 opacity-75'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        className="mt-1 w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 pointer-events-none"
                      />
                      <div className="flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <h4 className="text-xs font-bold text-slate-800">{p.name}</h4>
                          <span className="text-[11px] font-semibold text-emerald-700 font-urdu">{p.urdu}</span>
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1 leading-snug">{p.desc}</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Save Permissions Action Bar */}
              <div className="flex items-center justify-between pt-4 border-t border-slate-200">
                <div className="text-xs text-slate-500">
                  Allowed Services: <strong className="text-indigo-700 font-mono">{staffPermissions.length} / {ALL_STAFF_PERMISSIONS.length} Modules</strong>
                </div>

                <button
                  onClick={handleSaveStaffPermissions}
                  disabled={actionLoading}
                  className="px-5 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow flex items-center gap-2 transition"
                >
                  {actionLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Updating Database...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      <span>Save Staff Permissions</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-slate-500 space-y-2">
              <Users className="w-10 h-10 mx-auto text-slate-300" />
              <p className="text-xs font-semibold">No Staff Account Selected</p>
              <p className="text-[11px] text-slate-400">
                Create a Staff account from the "User Accounts Registry" tab first or select an existing staff account above.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Reset Password Modal */}
      {resetModalUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 border border-slate-200">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200">
              <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                <Key className="w-4 h-4 text-indigo-600" />
                Admin Password Reset
              </h3>
              <button
                onClick={() => setResetModalUser(null)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleResetPassword} className="mt-4 space-y-3 text-xs">
              <div className="bg-slate-50 p-2.5 rounded border border-slate-200">
                <div className="font-semibold text-slate-800">{resetModalUser.fullName}</div>
                <div className="text-slate-500 font-mono">Username: @{resetModalUser.username}</div>
              </div>

              {pwdError && (
                <div className="bg-rose-50 border border-rose-200 text-rose-700 p-2 rounded text-xs flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{pwdError}</span>
                </div>
              )}

              <div className="relative">
                <label className="block text-slate-700 font-bold mb-1">Set New Strong Password *</label>
                <input
                  type={showPwd ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new strong password"
                  required
                  className="w-full px-3 py-2 pr-10 border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                />
                <button type="button" onClick={() => setShowPwd(!showPwd)} className="absolute right-2 top-8 text-slate-500">
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <p className="text-[10px] text-slate-500 mt-1">
                  Must be at least 8 characters long and contain both letters and numbers or symbols.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setResetModalUser(null)}
                  className="px-3 py-1.5 font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-4 py-1.5 font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded shadow-sm"
                >
                  {actionLoading ? 'Updating...' : 'Set New Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Role Change Modal */}
      {roleModalUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-5 border border-slate-200">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200">
              <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                <Shield className="w-4 h-4 text-purple-600" />
                Change User Role
              </h3>
              <button
                onClick={() => setRoleModalUser(null)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3 text-xs">
              <div className="bg-slate-50 p-2.5 rounded border border-slate-200">
                <div className="font-semibold text-slate-800">{roleModalUser.fullName}</div>
                <div className="text-slate-500">Current Role: {roleModalUser.role}</div>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">Select Access Role</label>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value as UserRole)}
                  className="w-full px-3 py-2 border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-purple-500 font-medium"
                >
                  <option value="STAFF">Pharmacist Staff (POS & Stock Access)</option>
                  <option value="ADMIN">System Admin (Full Permission & Backups)</option>
                  <option value="CUSTOMER">Customer (Restricted Self-Service Only)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setRoleModalUser(null)}
                  className="px-3 py-1.5 font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdateRole}
                  disabled={actionLoading}
                  className="px-4 py-1.5 font-bold text-white bg-purple-600 hover:bg-purple-700 rounded shadow-sm"
                >
                  {actionLoading ? 'Saving...' : 'Update Role'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add New User Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 border border-slate-200">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200">
              <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-emerald-600" />
                Create System User Account
              </h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="mt-4 space-y-3 text-xs">
              {addError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded flex items-center gap-2 text-xs">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{addError}</span>
                </div>
              )}

              <div>
                <label className="block text-slate-700 font-bold mb-1">Username *</label>
                <input
                  type="text"
                  placeholder="e.g. pharmacist_ali"
                  value={addUsername}
                  onChange={(e) => setAddUsername(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">Full Name *</label>
                <input
                  type="text"
                  placeholder="e.g. Dr. Ali Raza"
                  value={addFullName}
                  onChange={(e) => setAddFullName(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">Email Address</label>
                  <input
                    type="email"
                    placeholder="ali@khushimedical.com"
                    value={addEmail}
                    onChange={(e) => setAddEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-bold mb-1">Phone Number</label>
                  <input
                    type="text"
                    placeholder="03001234567"
                    value={addPhone}
                    onChange={(e) => setAddPhone(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">User Role *</label>
                <select
                  value={addRole}
                  onChange={(e) => setAddRole(e.target.value as any)}
                  className="w-full px-3 py-2 border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 font-medium"
                >
                  <option value="STAFF">Pharmacist Staff (POS, Inventory, Billing)</option>
                  <option value="ADMIN">System Admin (Full Permissions)</option>
                  <option value="CUSTOMER">Customer Account</option>
                </select>
              </div>

              <div className="relative">
                <label className="block text-slate-700 font-bold mb-1">Password *</label>
                <input
                  type={showAddPwd ? "text" : "password"}
                  placeholder="Min 8 characters (letters + numbers)"
                  value={addPassword}
                  onChange={(e) => setAddPassword(e.target.value)}
                  className="w-full px-3 py-2 pr-10 border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono"
                  required
                />
                <button type="button" onClick={() => setShowAddPwd(!showAddPwd)} className="absolute right-2 top-8 text-slate-500">
                  {showAddPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-3 py-1.5 font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-4 py-1.5 font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded shadow-sm flex items-center gap-1.5"
                >
                  {actionLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                  <span>Create Account</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
