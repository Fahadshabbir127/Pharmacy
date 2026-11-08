import React, { useState, useEffect } from 'react';
import { api, getAuthToken } from '../lib/api';
import { User } from '../types';
import { Settings, Shield, Download, Upload, Building2, Save, RefreshCw, AlertTriangle, CheckCircle, Mail, Send, Lock, Eye, EyeOff, Printer, Database, Key } from 'lucide-react';

interface SettingsBackupScreenProps {
  currentUser?: User;
}

export const SettingsBackupScreen: React.FC<SettingsBackupScreenProps> = ({ currentUser }) => {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);

  // SMTP Test State
  const [testEmail, setTestEmail] = useState<string>('');
  const [testingSmtp, setTestingSmtp] = useState<boolean>(false);
  const [smtpTestResult, setSmtpTestResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Backup Passwords
  const [exportPassword, setExportPassword] = useState<string>('');
  const [importPassword, setImportPassword] = useState<string>('');
  const [importFilePayload, setImportFilePayload] = useState<any | null>(null);
  const [importFileName, setImportFileName] = useState<string>('');
  const [successMsg, setSuccessMsg] = useState<string>('');
  const [exportError, setExportError] = useState<string>('');
  const [importError, setImportError] = useState<string>('');
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [showBackupPwd, setShowBackupPwd] = useState<boolean>(false);
  const [showExportPwd, setShowExportPwd] = useState<boolean>(false);

  // Super Admin / Account Password Reset State
  const [usersList, setUsersList] = useState<User[]>([]);
  const [selectedResetUserId, setSelectedResetUserId] = useState<number>(currentUser?.id || 1);
  const [resetNewPassword, setResetNewPassword] = useState<string>('');
  const [showResetPwd, setShowResetPwd] = useState<boolean>(false);
  const [resetPwdMsg, setResetPwdMsg] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isResettingPwd, setIsResettingPwd] = useState<boolean>(false);

  const handleDownloadMysqlScript = async () => {
    try {
      setActionLoading(true);
      const token = getAuthToken();
      const res = await fetch('/api/backup/mysql-export', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!res.ok) throw new Error('Failed to generate MySQL export script');
      const text = await res.text();
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Khushi_Medical_MySQL_Dump_${new Date().toISOString().split('T')[0]}.sql`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert('MySQL Dump Error: ' + err.message);
    } finally {
      setActionLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
    api.getUsers().then(users => {
      setUsersList(users);
      if (currentUser?.id) setSelectedResetUserId(currentUser.id);
      else if (users.length > 0) setSelectedResetUserId(users[0].id);
    }).catch(console.error);
  }, [currentUser]);

  const handleResetUserPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetPwdMsg(null);

    if (!resetNewPassword || !isPasswordStrong(resetNewPassword)) {
      setResetPwdMsg({
        type: 'error',
        message: 'Password must be at least 8 characters long and contain both letters and numbers or symbols.'
      });
      return;
    }

    try {
      setIsResettingPwd(true);
      const res = await api.resetUserPassword(selectedResetUserId, resetNewPassword.trim());
      setResetPwdMsg({
        type: 'success',
        message: res.message || 'Password updated successfully!'
      });
      setResetNewPassword('');
    } catch (err: any) {
      setResetPwdMsg({
        type: 'error',
        message: err.message || 'Failed to update password.'
      });
    } finally {
      setIsResettingPwd(false);
    }
  };

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const data = await api.getSettings();
      setSettings(data);
    } catch (err) {
      console.error('Error fetching settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const isPasswordStrong = (pwd: string) => {
    if (!pwd || pwd.length < 8) return false;
    const hasLetter = /[A-Za-z]/.test(pwd);
    const hasNumOrSym = /[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pwd);
    return hasLetter && hasNumOrSym;
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      await api.saveSettings(settings);
      alert('Settings updated successfully!');
    } catch (err: any) {
      alert(err.message || 'Error saving settings');
    } finally {
      setSaving(false);
    }
  };

  const handleTestSmtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSmtpTestResult(null);
    try {
      setTestingSmtp(true);
      const target = testEmail || settings.smtp_from_email || settings.smtp_user || 'khushi.store@gmail.com';
      const res = await api.testSmtp(target);
      setSmtpTestResult({ type: 'success', message: res.message });
    } catch (err: any) {
      setSmtpTestResult({ type: 'error', message: err.message || 'SMTP Gateway test failed.' });
    } finally {
      setTestingSmtp(false);
    }
  };

  const handleExportBackup = async () => {
    setExportError('');
    if (!exportPassword) {
      setExportError('Please enter a master password to encrypt your database backup');
      return;
    }

    if (!isPasswordStrong(exportPassword)) {
      setExportError('Backup password must be at least 8 characters long and contain both letters and numbers or symbols.');
      return;
    }

    setActionLoading(true);
    try {
      const backupData = await api.exportBackup(exportPassword);
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Khushi_Medical_Backup_${new Date().toISOString().split('T')[0]}.kmhbackup`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setExportPassword('');
      alert('AES-256 Encrypted Database Backup downloaded successfully!');
    } catch (err: any) {
      setExportError(err.message || 'Error exporting encrypted backup');
    } finally {
      setActionLoading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setImportError('');
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch (e) {}

        if (json && typeof json === 'object') {
          if (json.backupPayload) {
            setImportFilePayload(json.backupPayload);
          } else {
            setImportFilePayload(json);
          }
        } else {
          setImportFilePayload(text);
        }
      } catch (err) {
        setImportError('Failed to read backup file.');
        setImportFilePayload(null);
      }
    };
    reader.readAsText(file);
  };

  const handleRestoreBackup = async () => {
    setImportError('');
    if (!importFilePayload) {
      setImportError('Please select a valid .kmhbackup file to restore.');
      return;
    }

    if (typeof importFilePayload === 'object' && (importFilePayload.data || importFilePayload.iv) && !importPassword) {
      setImportError('Please enter the decryption password for this backup file.');
      return;
    }

    if (!confirm('CRITICAL WARNING: Restoring this database backup will overwrite all existing data with the backup state! Are you sure you want to proceed?')) return;

    setActionLoading(true);
    try {
      const res = await api.importBackup(importFilePayload, importPassword);
      setSuccessMsg(res.message || 'Database restored successfully from encrypted backup! Reloading...');
      setImportFilePayload(null);
      setImportPassword('');
      setImportFileName('');
      setTimeout(() => window.location.reload(), 2000);
    } catch (err: any) {
      setImportError(err.message || 'Restoration failed. Incorrect decryption password or corrupted file.');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      
      <div>
        <h2 className="text-xl font-bold text-white flex items-center space-x-2">
          <Settings className="w-6 h-6 text-emerald-400" />
          <span>Store Profile & Gateway Configuration</span>
        </h2>
        <p className="text-xs text-slate-400">
          Manage your store branding info and email gateway settings. System backups are handled centrally by the Platform Super Admin.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Store Information Settings Form */}
        <div className="lg:col-span-7 bg-slate-900 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
          <h3 className="font-bold text-white text-sm pb-2 border-b border-slate-800 flex items-center space-x-2">
            <Building2 className="w-4 h-4 text-emerald-400" />
            <span>Store Profile & Information</span>
          </h3>

          <form onSubmit={handleSaveSettings} className="space-y-3 text-xs">
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Store English Name:</label>
                <input
                  type="text"
                  value={settings.store_name || ''}
                  onChange={(e) => setSettings({ ...settings, store_name: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Store Urdu Name (اردو نام):</label>
                <input
                  type="text"
                  value={settings.store_urdu_name || ''}
                  onChange={(e) => setSettings({ ...settings, store_urdu_name: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Store Address:</label>
                <input
                  type="text"
                  value={settings.address || ''}
                  onChange={(e) => setSettings({ ...settings, address: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Phone Number(s):</label>
                <input
                  type="text"
                  value={settings.phone || ''}
                  onChange={(e) => setSettings({ ...settings, phone: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Cashier / Operator Name (کیشیئر کا نام):</label>
                <input
                  type="text"
                  placeholder="e.g. Muhammad Ali (Cashier 1)"
                  value={settings.cashier_name || ''}
                  onChange={(e) => setSettings({ ...settings, cashier_name: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">NTN / STRN Tax Number:</label>
                <input
                  type="text"
                  value={settings.ntn_number || ''}
                  onChange={(e) => setSettings({ ...settings, ntn_number: e.target.value })}
                  className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-5 rounded-xl flex items-center space-x-2 text-xs shadow-lg shadow-emerald-950/50"
            >
              {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              <span>Save Profile Details</span>
            </button>
          </form>

          {/* Printer Information & POS Thermal Receipt Setup */}
          <div className="pt-4 border-t border-slate-800 space-y-4">
            <h3 className="font-bold text-white text-sm pb-1 flex items-center space-x-2">
              <Printer className="w-4 h-4 text-emerald-400" />
              <span>Printer Information & POS Thermal Receipt Setup</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Configure receipt paper format, cashier display title, and receipt guarantee notes printed on customer bills.
            </p>

            <form onSubmit={handleSaveSettings} className="space-y-3 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">Receipt Paper Size / Printer Mode:</label>
                  <select
                    value={settings.printer_mode || '80mm'}
                    onChange={(e) => setSettings({ ...settings, printer_mode: e.target.value })}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-semibold"
                  >
                    <option value="80mm">80mm POS Thermal Receipt Printer (Standard)</option>
                    <option value="58mm">58mm Mini Thermal Receipt Printer</option>
                    <option value="A4">A4 Full Page Invoice Sheet Printer</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">Receipt Cashier Title:</label>
                  <input
                    type="text"
                    value={settings.cashier_name || ''}
                    placeholder="Pharmacist Admin / Cashier Name"
                    onChange={(e) => setSettings({ ...settings, cashier_name: e.target.value })}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-slate-300 font-semibold mb-1">Receipt Footer Note (شکریہ کا پیغام):</label>
                  <input
                    type="text"
                    value={settings.receipt_footer || 'Get well soon! Check expiry before use. Goods once sold are not returnable without bill.'}
                    onChange={(e) => setSettings({ ...settings, receipt_footer: e.target.value })}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={saving}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-5 rounded-xl flex items-center space-x-2 text-xs shadow-lg shadow-emerald-950/50"
              >
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                <span>Save Printer Settings</span>
              </button>
            </form>
          </div>

          {/* Prewritten Messaging Templates - Only for Super Admin */}
          {currentUser?.role === 'SUPER_ADMIN' && (
            <div className="pt-4 border-t border-slate-800 space-y-4">
              <h3 className="font-bold text-white text-sm pb-1 flex items-center space-x-2">
                <Send className="w-4 h-4 text-emerald-400" />
                <span>Prewritten Messaging Templates (پیشگی تیار کردہ پیغامات)</span>
              </h3>
              <p className="text-[11px] text-slate-400">
                Customize pre-written templates used for WhatsApp, Direct SMS, and Email customer notices. Use placeholders <code className="text-emerald-400 font-mono">{'{name}'}</code>, <code className="text-emerald-400 font-mono">{'{balance}'}</code>, and <code className="text-emerald-400 font-mono">{'{store_name}'}</code>.
              </p>

              <form onSubmit={handleSaveSettings} className="space-y-3 text-xs">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">1. Udhar Due Reminder Message (ادھار یاد دہانی پیغام):</label>
                  <textarea
                    rows={3}
                    value={settings.msg_template_udhar_reminder || `محترم {name} صاحب! خوشی میڈیکل ہال پر آپ کا بقیہ ادھار رقم Rs. {balance} ہے۔ برائے مہربانی اپنا ادھار کھاتہ جلد از جلد صاف فرمائیں۔ شکریہ! - Khushi Medical Hall`}
                    onChange={(e) => setSettings({ ...settings, msg_template_udhar_reminder: e.target.value })}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-sans"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">2. Payment Receipt Message (رقم وصولی کا پیغام):</label>
                  <textarea
                    rows={3}
                    value={settings.msg_template_payment_receipt || `محترم {name}! خوشی میڈیکل ہال میں آپ کی طرف سے رقم موصول ہو گئی ہے۔ آپ کا بقیہ کھاتہ Rs. {balance} ہے۔ شکریہ! - Khushi Medical Hall`}
                    onChange={(e) => setSettings({ ...settings, msg_template_payment_receipt: e.target.value })}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-sans"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">3. Prescription Refill Reminder (دوائی ختم ہونے کا نوٹس):</label>
                  <textarea
                    rows={3}
                    value={settings.msg_template_refill || `Dear {name}, your regular medicine prescription stock at Khushi Medical Hall may be finishing soon. Visit us today for fresh refill & discounts! - Khushi Medical Hall`}
                    onChange={(e) => setSettings({ ...settings, msg_template_refill: e.target.value })}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-sans"
                  />
                </div>

                <button
                  type="submit"
                  disabled={saving}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-5 rounded-xl flex items-center space-x-2 text-xs shadow-lg shadow-emerald-950/50"
                >
                  {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  <span>Save Message Templates</span>
                </button>
              </form>
            </div>
          )}

          {/* Outgoing Email Gateway Configuration (SMTP) - Only for Super Admin */}
          {currentUser?.role === 'SUPER_ADMIN' && (
            <div className="pt-4 border-t border-slate-800 space-y-4">
              <h3 className="font-bold text-white text-sm pb-1 flex items-center space-x-2">
                <Mail className="w-4 h-4 text-emerald-400" />
                <span>Outgoing Email Gateway Configuration (SMTP)</span>
              </h3>
              <p className="text-[11px] text-slate-400">
                Configure your outgoing email server parameters (Gmail SMTP, Custom Mail Server) to dispatch automated Udhar debt alerts and payment receipts.
              </p>

              <form onSubmit={handleSaveSettings} className="space-y-3 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  
                  <div>
                    <label className="block text-slate-300 font-semibold mb-1">SMTP Gateway Status:</label>
                    <select
                      value={settings.smtp_enabled ?? 'true'}
                      onChange={(e) => setSettings({ ...settings, smtp_enabled: e.target.value })}
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
                      value={settings.smtp_host || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_host: e.target.value })}
                      className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-300 font-semibold mb-1">SMTP Port:</label>
                    <input
                      type="text"
                      placeholder="587 or 465"
                      value={settings.smtp_port || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_port: e.target.value })}
                      className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-300 font-semibold mb-1">Encryption Security:</label>
                    <select
                      value={settings.smtp_secure || 'tls'}
                      onChange={(e) => setSettings({ ...settings, smtp_secure: e.target.value })}
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
                      placeholder="khushi.store@gmail.com"
                      value={settings.smtp_user || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_user: e.target.value })}
                      className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-300 font-semibold mb-1">SMTP Password / App Password:</label>
                    <input
                      type="password"
                      placeholder="••••••••••••••••"
                      value={settings.smtp_pass || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_pass: e.target.value })}
                      className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-300 font-semibold mb-1">Sender Email Address:</label>
                    <input
                      type="email"
                      placeholder="khushi.store@gmail.com"
                      value={settings.smtp_from_email || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_from_email: e.target.value })}
                      className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-300 font-semibold mb-1">Sender Display Name:</label>
                    <input
                      type="text"
                      placeholder="Khushi Medical Hall"
                      value={settings.smtp_from_name || ''}
                      onChange={(e) => setSettings({ ...settings, smtp_from_name: e.target.value })}
                      className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                </div>

                <div className="flex items-center space-x-3 pt-1">
                  <button
                    type="submit"
                    disabled={saving}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-5 rounded-xl flex items-center space-x-2 text-xs shadow-lg shadow-emerald-950/50"
                  >
                    {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    <span>Save SMTP Configuration</span>
                  </button>
                </div>
              </form>

              {/* Test Connection Gateway Form */}
              <div className="bg-slate-800/60 p-3.5 rounded-xl border border-slate-700/80 space-y-3">
                <div className="font-bold text-white text-xs flex items-center space-x-1.5">
                  <Send className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Test SMTP Gateway Connection (ای میل کنکشن ٹیسٹ)</span>
                </div>

                {smtpTestResult && (
                  <div className={`p-2.5 rounded-xl text-xs flex items-start gap-2 ${
                    smtpTestResult.type === 'success' ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-300' : 'bg-rose-950/80 border border-rose-800 text-rose-300'
                  }`}>
                    {smtpTestResult.type === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />}
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
          )}
        </div>

        {/* Right Column: Password Management & Database Backups */}
        <div className="lg:col-span-5 space-y-6">
          {/* User Password Reset & Security */}
          <div className="bg-slate-900 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
            <h3 className="font-bold text-white text-sm pb-2 border-b border-slate-800 flex items-center space-x-2">
              <Key className="w-4 h-4 text-emerald-400" />
              <span>User Password Security & Reset (پاسورڈ تبدیل)</span>
            </h3>

            {resetPwdMsg && (
              <div className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
                resetPwdMsg.type === 'success' ? 'bg-emerald-950/90 border border-emerald-800 text-emerald-200' : 'bg-rose-950/90 border border-rose-800 text-rose-200'
              }`}>
                {resetPwdMsg.type === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />}
                <span>{resetPwdMsg.message}</span>
              </div>
            )}

            <form onSubmit={handleResetUserPassword} className="space-y-3 text-xs">
              {usersList.length > 0 && (
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Select Target Account to Reset Password *
                  </label>
                  <select
                    value={selectedResetUserId}
                    onChange={(e) => setSelectedResetUserId(Number(e.target.value))}
                    className="w-full bg-slate-800 text-white p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 text-xs font-semibold"
                  >
                    {usersList.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.fullName} (@{u.username}) - [{u.role}] {u.id === currentUser.id ? '(You)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  New Strong Password *
                </label>
                <div className="relative">
                  <input
                    type={showResetPwd ? "text" : "password"}
                    value={resetNewPassword}
                    onChange={(e) => setResetNewPassword(e.target.value)}
                    placeholder="Enter new password (min 8 chars)..."
                    className="w-full bg-slate-800 text-white p-2.5 pr-10 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowResetPwd(!showResetPwd)}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-white"
                  >
                    {showResetPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 mt-1">
                  Must be at least 8 characters with letters and digits/symbols.
                </p>
              </div>

              <button
                type="submit"
                disabled={isResettingPwd}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-4 rounded-xl flex items-center justify-center space-x-2 text-xs shadow-lg shadow-emerald-950/50"
              >
                {isResettingPwd ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                <span>{currentUser?.role === 'SUPER_ADMIN' ? 'Reset Account Password' : 'Update My Password'}</span>
              </button>
            </form>
          </div>

          {/* AES-256 Encrypted Database Backup & MySQL Export */}
          <div className="bg-slate-900 p-5 rounded-2xl border border-slate-800 shadow-xl space-y-4">
          <h3 className="font-bold text-white text-sm pb-2 border-b border-slate-800 flex items-center space-x-2">
            <Shield className="w-4 h-4 text-emerald-400" />
            <span>Platform Database Backup & MySQL Migration</span>
          </h3>

          {/* Export Encrypted Backup */}
          <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700 space-y-3 text-xs">
            <div className="font-bold text-white flex items-center space-x-1.5">
              <Download className="w-4 h-4 text-emerald-400" />
              <span>Export Complete Encrypted Database Backup</span>
            </div>

            <p className="text-slate-400 text-[11px]">
              Generates an AES-256 encrypted copy of the database containing all stores, users, inventory, and transaction history.
            </p>

            {exportError && (
              <div className="p-2.5 bg-rose-950/80 border border-rose-800 text-rose-300 rounded-xl flex items-center gap-1.5 text-[11px]">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                <span>{exportError}</span>
              </div>
            )}

            <div>
              <label className="block text-slate-300 font-semibold mb-1">Master Encryption Password *</label>
              <div className="relative">
                <input
                  type={showExportPwd ? "text" : "password"}
                  value={exportPassword}
                  onChange={(e) => {
                    setExportPassword(e.target.value);
                    setExportError('');
                  }}
                  placeholder="Enter strong password (min 8 chars)..."
                  className="w-full bg-slate-900 text-white p-2.5 pr-10 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowExportPwd(!showExportPwd)}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-white"
                >
                  {showExportPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              onClick={handleExportBackup}
              disabled={actionLoading}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl text-xs flex items-center justify-center space-x-1.5"
            >
              {actionLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
              <span>Download Backup (.kmhbackup)</span>
            </button>
          </div>

          {/* MySQL Database Converter / Dump Exporter */}
          <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700 space-y-3 text-xs">
            <div className="font-bold text-white flex items-center space-x-1.5">
              <Database className="w-4 h-4 text-indigo-400" />
              <span>Convert Database to MySQL Script (.sql)</span>
            </div>

            <p className="text-slate-400 text-[11px]">
              Exports all database tables, columns, constraints, and rows as a clean MySQL / MariaDB compatible SQL Dump.
            </p>

            <button
              type="button"
              onClick={handleDownloadMysqlScript}
              disabled={actionLoading}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2.5 rounded-xl text-xs flex items-center justify-center space-x-1.5"
            >
              {actionLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
              <span>Export & Convert to MySQL SQL Dump (.sql)</span>
            </button>
          </div>

          {/* Restore Encrypted Backup */}
          <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700 space-y-3 text-xs">
            <div className="font-bold text-white flex items-center space-x-1.5">
              <Upload className="w-4 h-4 text-amber-400" />
              <span>Restore Platform Database Backup</span>
            </div>

            {importError && (
              <div className="p-2.5 bg-rose-950/80 border border-rose-800 text-rose-300 rounded-xl flex items-center gap-1.5 text-[11px]">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                <span>{importError}</span>
              </div>
            )}
            {successMsg && (
              <div className="p-2.5 bg-emerald-950/80 border border-emerald-800 text-emerald-300 rounded-xl flex items-center gap-1.5 text-[11px]">
                <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}

            <div>
              <label className="block text-slate-300 font-semibold mb-1">Select Backup File (.kmhbackup):</label>
              <input
                type="file"
                accept=".kmhbackup,.json"
                onChange={handleFileUpload}
                className="w-full text-slate-300 text-xs bg-slate-900 p-2 rounded-xl border border-slate-700"
              />
              {importFileName && (
                <p className="text-[11px] text-emerald-400 mt-1 font-mono">Loaded: {importFileName}</p>
              )}
            </div>

            <div>
              <label className="block text-slate-300 font-semibold mb-1">Decryption Password *</label>
              <div className="relative">
                <input
                  type={showBackupPwd ? "text" : "password"}
                  value={importPassword}
                  onChange={(e) => {
                    setImportPassword(e.target.value);
                    setImportError('');
                  }}
                  placeholder="Enter backup decryption password..."
                  className="w-full bg-slate-900 text-white p-2.5 pr-10 rounded-xl border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowBackupPwd(!showBackupPwd)}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-white"
                >
                  {showBackupPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              onClick={handleRestoreBackup}
              disabled={actionLoading}
              className="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold py-2.5 rounded-xl text-xs flex items-center justify-center space-x-1.5"
            >
              {actionLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />}
              <span>Decrypt & Restore Database</span>
            </button>
          </div>

        </div>

      </div>

    </div>

  </div>
  );
};
