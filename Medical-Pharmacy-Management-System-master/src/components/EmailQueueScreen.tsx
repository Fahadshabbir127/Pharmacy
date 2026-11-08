import React, { useState, useEffect } from 'react';
import { EmailQueueItem } from '../types';
import { api } from '../lib/api';
import { Mail, Send, RefreshCw, Wifi, WifiOff, CheckCircle2, AlertCircle, Trash2, Edit3, X, Save } from 'lucide-react';

export const EmailQueueScreen: React.FC = () => {
  const [queue, setQueue] = useState<EmailQueueItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [processing, setProcessing] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);

  // Edit modal state
  const [editingItem, setEditingItem] = useState<EmailQueueItem | null>(null);
  const [editEmail, setEditEmail] = useState<string>('');
  const [editSubject, setEditSubject] = useState<string>('');
  const [editMessage, setEditMessage] = useState<string>('');
  const [editStatus, setEditStatus] = useState<string>('PENDING');
  const [savingEdit, setSavingEdit] = useState<boolean>(false);

  useEffect(() => {
    fetchQueue();

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const fetchQueue = async () => {
    try {
      setLoading(true);
      const data = await api.getEmailQueue();
      setQueue(data);
    } catch (err) {
      console.error('Error fetching email queue:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleProcessQueue = async () => {
    try {
      setProcessing(true);
      const res = await api.processEmailQueue();
      alert(res.message);
      fetchQueue();
    } catch (err: any) {
      alert(err.message || 'Error processing email queue');
    } finally {
      setProcessing(false);
    }
  };

  const handleDeleteItem = async (id: number) => {
    if (!confirm('Are you sure you want to delete this Email queue item?')) return;
    try {
      const res = await api.deleteEmailQueueItem(id);
      alert(res.message || 'Deleted successfully');
      fetchQueue();
    } catch (err: any) {
      alert(err.message || 'Failed to delete queue item');
    }
  };

  const handleClearQueue = async () => {
    if (!confirm('CRITICAL: Are you sure you want to CLEAR the ENTIRE Email outbox queue?')) return;
    try {
      const res = await api.clearEmailQueue();
      alert(res.message || 'Email queue cleared successfully');
      fetchQueue();
    } catch (err: any) {
      alert(err.message || 'Failed to clear Email queue');
    }
  };

  const handleStartEdit = (item: EmailQueueItem) => {
    setEditingItem(item);
    setEditEmail(item.email || '');
    setEditSubject(item.subject || '');
    setEditMessage(item.message || '');
    setEditStatus(item.status || 'PENDING');
  };

  const handleSaveEdit = async () => {
    if (!editingItem) return;
    try {
      setSavingEdit(true);
      await api.updateEmailQueueItem(editingItem.id, {
        email: editEmail,
        subject: editSubject,
        message: editMessage,
        status: editStatus,
      });
      alert('Email queue item updated successfully!');
      setEditingItem(null);
      fetchQueue();
    } catch (err: any) {
      alert(err.message || 'Failed to update email queue item');
    } finally {
      setSavingEdit(false);
    }
  };

  const pendingCount = queue.filter(q => q.status === 'PENDING').length;

  return (
    <div className="p-2 sm:p-4 md:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-6">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-white flex items-center space-x-2">
            <Mail className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400 shrink-0" />
            <span>Email Alerts & Outbox Queue</span>
          </h2>
          <p className="text-xs text-slate-400">
            Email notifications for Udhar billing reminders, payment receipts, and customer verification alerts.
          </p>
        </div>

        <div className="flex flex-wrap items-center space-x-2 sm:space-x-3 w-full sm:w-auto justify-end">
          <div className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center space-x-1.5 ${
            isOnline ? 'bg-emerald-950 text-emerald-300 border-emerald-800' : 'bg-amber-950 text-amber-300 border-amber-800'
          }`}>
            {isOnline ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
            <span>{isOnline ? 'SMTP Active' : 'Offline'}</span>
          </div>

          {queue.length > 0 && (
            <button
              onClick={handleClearQueue}
              className="px-3 py-2.5 rounded-xl text-xs font-bold bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-800 flex items-center space-x-1.5 transition-all"
              title="Clear all outbox items"
            >
              <Trash2 className="w-4 h-4" />
              <span>Clear Queue</span>
            </button>
          )}

          <button
            disabled={processing || pendingCount === 0}
            onClick={handleProcessQueue}
            className={`px-3 sm:px-4 py-2.5 rounded-xl text-xs font-bold flex items-center space-x-2 shadow-lg ${
              pendingCount === 0
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/50'
            }`}
          >
            {processing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span>Dispatch ({pendingCount})</span>
          </button>
        </div>
      </div>

      {/* Queue Table */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-xl overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-slate-400">Loading Email Queue...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-800 text-slate-400 uppercase font-mono border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">Recipient</th>
                  <th className="py-3 px-4">Email Address</th>
                  <th className="py-3 px-4">Subject</th>
                  <th className="py-3 px-4">Message Summary</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {queue.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-500">
                      Email outbox queue is empty. No pending or sent email alerts.
                    </td>
                  </tr>
                ) : (
                  queue.map(item => {
                    const mailtoUrl = `mailto:${item.email}?subject=${encodeURIComponent(item.subject)}&body=${encodeURIComponent(item.message)}`;

                    return (
                      <tr key={item.id} className="hover:bg-slate-800/40">
                        <td className="py-3 px-4 text-[11px] text-slate-400 font-mono">
                          {new Date(item.created_at).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-bold text-white">
                          {item.customer_name || 'Customer'}
                        </td>
                        <td className="py-3 px-4 font-mono text-emerald-400">{item.email}</td>
                        <td className="py-3 px-4 font-semibold text-slate-200">{item.subject}</td>
                        <td className="py-3 px-4 max-w-xs truncate text-slate-300" title={item.message}>
                          {item.message}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                            item.status === 'SENT'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : item.status === 'PENDING'
                              ? 'bg-amber-950 text-amber-300 border border-amber-800'
                              : 'bg-rose-950 text-rose-300 border border-rose-800'
                          }`}>
                            {item.status === 'SENT' && <CheckCircle2 className="w-3 h-3 mr-1" />}
                            {item.status === 'PENDING' && <AlertCircle className="w-3 h-3 mr-1" />}
                            {item.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end space-x-1.5">
                            <button
                              onClick={() => handleStartEdit(item)}
                              className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 p-1.5 rounded-lg transition-all"
                              title="Edit Email / Subject / Message / Status"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteItem(item.id)}
                              className="bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-800 p-1.5 rounded-lg transition-all"
                              title="Delete from Queue"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            <a
                              href={mailtoUrl}
                              className="bg-blue-900/80 hover:bg-blue-800 text-blue-200 border border-blue-700 text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-all inline-flex items-center space-x-1"
                              title="Open in Email Client"
                            >
                              <Mail className="w-3 h-3" />
                              <span>Mail Client</span>
                            </a>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* EDIT MODAL */}
      {editingItem && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="font-bold text-white text-base flex items-center space-x-2">
                <Edit3 className="w-5 h-5 text-emerald-400" />
                <span>Edit Email Queue Item #{editingItem.id}</span>
              </h3>
              <button onClick={() => setEditingItem(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 font-semibold mb-1">Recipient Email</label>
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-semibold mb-1">Subject</label>
                <input
                  type="text"
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500 font-semibold"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-semibold mb-1">Status</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500 font-bold"
                >
                  <option value="PENDING">PENDING</option>
                  <option value="SENT">SENT</option>
                  <option value="CANCELLED">CANCELLED</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-400 font-semibold mb-1">Message Content</label>
                <textarea
                  rows={4}
                  value={editMessage}
                  onChange={(e) => setEditMessage(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-3 border-t border-slate-800">
              <button
                onClick={() => setEditingItem(null)}
                className="px-4 py-2 rounded-xl text-slate-300 bg-slate-800 hover:bg-slate-700 text-xs font-bold"
              >
                Cancel
              </button>
              <button
                disabled={savingEdit}
                onClick={handleSaveEdit}
                className="px-4 py-2 rounded-xl text-white bg-emerald-600 hover:bg-emerald-500 text-xs font-bold flex items-center space-x-1.5"
              >
                {savingEdit ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                <span>Save Changes</span>
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
