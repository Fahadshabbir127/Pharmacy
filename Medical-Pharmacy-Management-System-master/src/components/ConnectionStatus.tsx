/**
 * Desktop connection state (from the Electron main process) and the blocking overlay shown
 * when the pharmacy server cannot be used. In a plain browser (development) nothing is shown.
 */
import React, { useEffect, useState } from 'react';
import { WifiOff, ShieldAlert, RefreshCw, Server } from 'lucide-react';

export interface ConnectionState {
  status: 'NOT_CONFIGURED' | 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'CERT_MISMATCH' | 'VERSION_MISMATCH' | 'BACKEND_RESTARTING' | 'BACKEND_FAILED';
  detail?: string;
  since: string;
  hostName?: string;
  isLocal: boolean;
  serverVersion?: string;
}

declare global {
  interface Window {
    braintech?: {
      isDesktop: true;
      getAppInfo(): Promise<{ version: string; platform: string; computerName: string; mode: string | null }>;
      getConnectionState(): Promise<ConnectionState>;
      onConnectionState(cb: (s: ConnectionState) => void): () => void;
      openConnectionSettings(): Promise<unknown>;
      print: { listPrinters(): Promise<any[]>; printHtml(o: Record<string, unknown>): Promise<any> };
    };
  }
}

export const isDesktop = () => typeof window !== 'undefined' && !!window.braintech?.isDesktop;

export function useConnectionState(): ConnectionState | null {
  const [state, setState] = useState<ConnectionState | null>(null);
  useEffect(() => {
    const bt = window.braintech;
    if (!bt) return;
    let alive = true;
    bt.getConnectionState().then((s) => { if (alive) setState(s); }).catch(() => {});
    const off = bt.onConnectionState((s) => setState(s));
    return () => { alive = false; off(); };
  }, []);
  return state;
}

const BLOCKING = new Set(['DISCONNECTED', 'CERT_MISMATCH', 'VERSION_MISMATCH', 'BACKEND_RESTARTING', 'BACKEND_FAILED']);

export const ConnectionChip: React.FC<{ state: ConnectionState | null }> = ({ state }) => {
  if (!state) return null;
  const good = state.status === 'CONNECTED';
  const label = good ? (state.isLocal ? 'DATABASE OK (THIS COMPUTER)' : `CONNECTED TO ${state.hostName || 'SERVER'}`) : state.status.replace(/_/g, ' ');
  return (
    <span data-testid="connection-chip" className={`flex items-center space-x-1.5 font-bold px-2 py-0.5 rounded border ${good ? 'text-emerald-300 bg-emerald-950/70 border-emerald-500/40' : 'text-amber-200 bg-amber-950/90 border-amber-500/60'}`}>
      <span className={`w-2 h-2 rounded-full ${good ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}></span>
      <span>{label}</span>
    </span>
  );
};

export const ConnectionOverlay: React.FC<{ state: ConnectionState | null }> = ({ state }) => {
  if (!state || !BLOCKING.has(state.status)) return null;
  const s = state.status;
  const title =
    s === 'CERT_MISMATCH' ? 'Security certificate changed' :
    s === 'VERSION_MISMATCH' ? 'Different software versions' :
    s === 'BACKEND_RESTARTING' ? 'Restarting the pharmacy database service...' :
    s === 'BACKEND_FAILED' ? 'The pharmacy database service stopped' :
    state.isLocal ? 'The pharmacy database service is not responding' : 'Pharmacy server unreachable - reconnecting...';
  const body =
    s === 'CERT_MISMATCH' ? 'The server presented a different security certificate than the one this computer trusts. This can mean the server was reinstalled or its certificate renewed - or that another device is pretending to be the server. Ask the administrator, then pair this computer again.' :
    s === 'VERSION_MISMATCH' ? `${state.detail || ''} Install the same version on all pharmacy computers.` :
    s === 'BACKEND_FAILED' ? `${state.detail || ''} Your data is safe on disk. Restart the application; if this repeats, contact support with the logs folder (File > Open Logs Folder).` :
    state.isLocal ? 'Please wait a few seconds.' :
    'Check that the main pharmacy computer is switched on and that this computer is on the same Wi-Fi/network. No sales can be made until the connection is back, so stock and invoices stay correct on every computer.';
  const Icon = s === 'CERT_MISMATCH' || s === 'VERSION_MISMATCH' ? ShieldAlert : s === 'BACKEND_RESTARTING' ? RefreshCw : state.isLocal ? Server : WifiOff;
  return (
    <div data-testid="connection-overlay" className="fixed inset-0 z-[100] bg-slate-950/85 flex items-center justify-center p-4" role="alertdialog" aria-labelledby="conn-title">
      <div className="max-w-lg w-full bg-slate-900 border border-slate-700 rounded-2xl p-6 text-slate-200 space-y-3 shadow-2xl">
        <div className="flex items-center gap-3">
          <Icon className={`w-8 h-8 ${s === 'BACKEND_RESTARTING' ? 'animate-spin text-amber-300' : 'text-rose-400'}`} />
          <h2 id="conn-title" className="text-lg font-black">{title}</h2>
        </div>
        <p className="text-sm text-slate-300">{body}</p>
        {state.detail && s === 'DISCONNECTED' && <p className="text-xs text-slate-500 font-mono">{state.detail}</p>}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={() => void window.braintech?.openConnectionSettings()} className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm font-bold">Connection settings</button>
        </div>
      </div>
    </div>
  );
};
