/**
 * Product branding and the pharmacy's own identity.
 * The product is "BrainTech Pharmacy AI"; each pharmacy's name, address and message texts
 * come from its settings (Settings & Backups), never from hardcoded strings.
 */
import { useEffect, useState } from 'react';
import { api } from './api';

export const PRODUCT_NAME = 'BrainTech Pharmacy AI';
export const GENERIC_STORE_NAME = 'Pharmacy';

/** Neutral defaults; {name}, {balance} and {store_name} are filled in when a message is created. */
export const DEFAULT_TEMPLATES = {
  udhar_reminder: 'Dear {name}, your outstanding balance at {store_name} is Rs. {balance}. Kindly clear it at your earliest convenience. Thank you!',
  payment_receipt: 'Dear {name}, we have received your payment. Your remaining balance at {store_name} is Rs. {balance}. Thank you!',
  refill: 'Dear {name}, your regular medicine at {store_name} may be running low. Visit us for a refill.',
};

export function storeNameOf(settings?: Record<string, any> | null, tenantName?: string | null): string {
  return (settings?.store_name || settings?.pharmacy_name || tenantName || GENERIC_STORE_NAME).toString();
}

/** File-name friendly version of a name ("Al-Shifa Pharmacy" -> "Al-Shifa_Pharmacy"). */
export function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '') || 'Pharmacy';
}

let cached: Promise<Record<string, any>> | null = null;
/** Store settings for components that do not receive them as props (fetched once). */
export function useStoreSettings(): Record<string, any> | null {
  const [s, setS] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    let alive = true;
    cached ??= api.getSettings().then((x: any) => x || {}).catch(() => { cached = null; return {}; });
    cached.then((x) => { if (alive) setS(x); });
    return () => { alive = false; };
  }, []);
  return s;
}
