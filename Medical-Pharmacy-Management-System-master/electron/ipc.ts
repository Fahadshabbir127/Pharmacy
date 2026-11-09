/**
 * IPC between the trusted renderer pages and the main process.
 *
 * Rules: every channel is listed here; each handler checks that the sender frame is one of the
 * app's own pages (app://braintech/...) and validates its arguments with zod. The renderer never
 * passes file paths: file choices happen in main-process dialogs.
 */
import os from 'node:os';
import { app, BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { ORIGIN } from './connection';

export class IpcValidationError extends Error {}

export function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url || '';
  return url === ORIGIN || url.startsWith(`${ORIGIN}/`);
}

type Handler<S extends z.ZodTypeAny> = (args: z.infer<S>, e: IpcMainInvokeEvent) => unknown;

export const CHANNELS: string[] = [];

export function handle<S extends z.ZodTypeAny>(channel: string, schema: S, fn: Handler<S>) {
  CHANNELS.push(channel);
  ipcMain.handle(channel, async (e, raw) => {
    if (!isTrustedSender(e)) throw new Error(`Blocked IPC call to ${channel} from an untrusted page`);
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) throw new IpcValidationError(`Invalid arguments for ${channel}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    return fn(parsed.data, e);
  });
}

export const S = {
  none: z.object({}).strict(),
  localMode: z.object({ mode: z.enum(['standalone', 'host']) }).strict(),
  createAdmin: z.object({
    storeName: z.string().trim().min(2).max(100),
    ownerName: z.string().trim().min(2).max(100),
    username: z.string().trim().min(3).max(50),
    password: z.string().min(8).max(200),
    email: z.string().trim().max(150).optional(),
    phone: z.string().trim().max(40).optional(),
    address: z.string().trim().max(200).optional(),
    loadDemoData: z.boolean().optional(),
  }).strict(),
  pair: z.object({
    host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.:-]+$/, 'host must be an IP address or computer name'),
    port: z.number().int().min(1).max(65535),
    code: z.string().trim().min(8).max(20),
    computerName: z.string().trim().min(1).max(60),
  }).strict(),
  revoke: z.object({ id: z.number().int().positive() }).strict(),
  printHtml: z.object({
    html: z.string().max(2_000_000),
    printer: z.string().max(200).optional(),
    silent: z.boolean().optional(),
    landscape: z.boolean().optional(),
    pageSize: z.enum(['A4', 'A5', 'Letter', '80mm', '58mm']).optional(),
  }).strict(),
};

export function appInfo() {
  return { version: app.getVersion(), platform: process.platform, computerName: os.hostname() };
}

export async function confirm(win: BrowserWindow | null, message: string, detail: string, okLabel = 'Continue'): Promise<boolean> {
  const opts = { type: 'question' as const, buttons: [okLabel, 'Cancel'], defaultId: 1, cancelId: 1, message, detail };
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 0;
}
