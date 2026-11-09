/**
 * Preload (sandboxed, context-isolated). Exposes a small, fixed API as window.braintech.
 * No Node.js APIs, no generic ipcRenderer access, no file paths.
 */
import { contextBridge, ipcRenderer } from 'electron';

const call = (channel: string, args?: unknown) => ipcRenderer.invoke(channel, args ?? {});

const api = {
  isDesktop: true as const,
  getAppInfo: () => call('app:info'),
  getConnectionState: () => call('conn:state'),
  onConnectionState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on('braintech:connection-state', listener);
    return () => { ipcRenderer.removeListener('braintech:connection-state', listener); };
  },
  setup: {
    getState: () => call('setup:state'),
    startLocal: (mode: 'standalone' | 'host') => call('setup:start-local', { mode }),
    importLegacyDatabase: (mode: 'standalone' | 'host') => call('setup:import-legacy', { mode }),
    createAdmin: (data: Record<string, unknown>) => call('setup:create-admin', data),
    discoverHosts: () => call('setup:discover'),
    pairWithHost: (data: { host: string; port: number; code: string; computerName: string }) => call('setup:pair', data),
    finish: () => call('setup:finish'),
  },
  server: {
    status: () => call('server:status'),
    rotatePairingCode: () => call('server:rotate-code'),
    revokeClient: (id: number) => call('server:revoke-client', { id }),
  },
  openConnectionSettings: () => call('window:connection-settings'),
  resetConnection: () => call('setup:reset-connection'),
  print: {
    listPrinters: () => call('print:printers'),
    printHtml: (opts: { html: string; printer?: string; silent?: boolean; landscape?: boolean; pageSize?: string }) => call('print:html', opts),
  },
};

contextBridge.exposeInMainWorld('braintech', Object.freeze(api));
