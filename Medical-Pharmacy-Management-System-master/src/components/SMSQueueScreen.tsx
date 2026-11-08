import React, { useState, useEffect } from 'react';
import { SMSQueueItem } from '../types';
import { api } from '../lib/api';
import { MessageSquare, Send, RefreshCw, Wifi, WifiOff, CheckCircle2, AlertCircle, Trash2, Edit3, X, Save } from 'lucide-react';

export const SMSQueueScreen: React.FC = () => {
  const [queue, setQueue] = useState<SMSQueueItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [processing, setProcessing] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);

  // Edit modal state
  const [editingItem, setEditingItem] = useState<SMSQueueItem | null>(null);
  const [editPhone, setEditPhone] = useState<string>('');
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
      const data = await api.getSMSQueue();
      setQueue(data);
    } catch (err) {
      console.error('Error fetching SMS queue:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleProcessQueue = async () => {
    try {
      setProcessing(true);
      const res = await api.processSMSQueue();
      alert(res.message);
      fetchQueue();
    } catch (err: any) {
      alert(err.message || 'Error processing SMS queue');
    } finally {
      setProcessing(false);
    }
  };

  const handleDeleteItem = async (id: number) => {
    if (!confirm('Are you sure you want to delete this SMS queue item?')) return;
    try {
      const res = await api.deleteSMSQueueItem(id);
      alert(res.message || 'Deleted successfully');
      fetchQueue();
    } catch (err: any) {
      alert(err.message || 'Failed to delete queue item');
    }
  };

  const handleClearQueue = async () => {
    if (!confirm('CRITICAL: Are you sure you want to CLEAR the ENTIRE SMS outbox queue?')) return;
    try {
      const res = await api.clearSMSQueue();
      alert(res.message || 'SMS queue cleared successfully');
      fetchQueue();
    } catch (err: any) {
      alert(err.message || 'Failed to clear SMS queue');
    }
  };

  const handleStartEdit = (item: SMSQueueItem) => {
    setEditingItem(item);
    setEditPhone(item.phone || '');
    setEditMessage(item.message || '');
    setEditStatus(item.status || 'PENDING');
  };

  const handleSaveEdit = async () => {
    if (!editingItem) return;
    try {
      setSavingEdit(true);
      await api.updateSMSQueueItem(editingItem.id, {
        phone: editPhone,
        message: editMessage,
        status: editStatus,
      });
      alert('Queue item updated successfully!');
      setEditingItem(null);
      fetchQueue();
    } catch (err: any) {
      alert(err.message || 'Failed to update queue item');
    } finally {
      setSavingEdit(false);
    }
  };

  const pendingCount = queue.filter(q => q.status === 'PENDING').length;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center space-x-2">
            <MessageSquare className="w-6 h-6 text-emerald-400" />
            <span>SMS Notifications & Outbox Queue</span>
          </h2>
          <p className="text-xs text-slate-400">
            SMS messages are queued locally while offline and automatically/manually sent when internet connection is active.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <div className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center space-x-1.5 ${
            isOnline ? 'bg-emerald-950 text-emerald-300 border-emerald-800' : 'bg-amber-950 text-amber-300 border-amber-800'
          }`}>
            {isOnline ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
            <span>{isOnline ? 'Online (Gateway Ready)' : 'Offline (Messages Queued)'}</span>
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
            className={`px-4 py-2.5 rounded-xl text-xs font-bold flex items-center space-x-2 shadow-lg ${
              pendingCount === 0
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/50'
            }`}
          >
            {processing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span>Send Queued Messages ({pendingCount})</span>
          </button>
        </div>
      </div>

      {/* Queue Table */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-xl overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-slate-400">Loading SMS Queue...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-800 text-slate-400 uppercase font-mono border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Created Time</th>
                  <th className="py-3 px-4">Customer</th>
                  <th className="py-3 px-4">Phone Number</th>
                  <th className="py-3 px-4">Message Content</th>
                  <th className="py-3 px-4">Type</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {queue.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-500">
                      SMS queue is empty. No pending or sent messages.
                    </td>
                  </tr>
                ) : (
                  queue.map(item => {
                    let cleanPhone = item.phone.replace(/[^0-9]/g, '');
                    if (cleanPhone.startsWith('0')) cleanPhone = '92' + cleanPhone.slice(1);
                    const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(item.message)}`;
                    const smsUrl = `sms:${item.phone}?body=${encodeURIComponent(item.message)}`;

                    return (
                      <tr key={item.id} className="hover:bg-slate-800/40">
                        <td className="py-3 px-4 text-[11px] text-slate-400 font-mono">
                          {new Date(item.created_at).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-bold text-white">
                          {item.customer_name || 'Customer'}
                        </td>
                        <td className="py-3 px-4 font-mono text-emerald-400">{item.phone}</td>
                        <td className="py-3 px-4 max-w-xs truncate text-slate-300" title={item.message}>
                          {item.message}
                        </td>
                        <td className="py-3 px-4 font-semibold text-slate-400">
                          {item.type}
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
                              title="Edit Phone / Message / Status"
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
                              href={waUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="bg-emerald-900/80 hover:bg-emerald-800 text-emerald-200 border border-emerald-700 text-[10px] font-bold px-2 py-1 rounded-lg transition-all"
                              title="Send via WhatsApp (No gateway needed)"
                            >
                              WhatsApp
                            </a>
                            <a
                              href={smsUrl}
                              className="bg-blue-900/80 hover:bg-blue-800 text-blue-200 border border-blue-700 text-[10px] font-bold px-2 py-1 rounded-lg transition-all"
                              title="Send via Mobile SMS"
                            >
                              SMS
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
                <span>Edit SMS Queue Message #{editingItem.id}</span>
              </h3>
              <button onClick={() => setEditingItem(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 font-semibold mb-1">Phone Number</label>
                <input
                  type="text"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-500 font-mono"
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
