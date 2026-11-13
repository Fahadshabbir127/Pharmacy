/**
 * One payment attempt with retry protection (Phase 7, Batch 2c).
 *  - A transaction id is created when a new payment attempt begins (the window opens / "Record another").
 *  - Every submit of that attempt - including a retry after a timeout or lost connection - sends the SAME id,
 *    so the host records the payment at most once and a retry returns the original result.
 *  - A new id is created only when the user intentionally starts a new payment (startNew).
 *  - A second click while the first request is running is ignored (no double payments).
 *  - After success the server's answer is shown and further submits are blocked until startNew().
 */
import { useRef, useState } from 'react';
import { ApiError, newClientTxnId } from './api';

export type AttemptState = 'idle' | 'submitting' | 'done' | 'unknown' | 'failed';

export function usePaymentAttempt<T>() {
  const [txnId, setTxnId] = useState<string>(() => newClientTxnId());
  const [state, setState] = useState<AttemptState>('idle');
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const doneRef = useRef(false);

  const submit = async (send: (txn: string) => Promise<T>): Promise<T | null> => {
    if (inFlight.current || doneRef.current) return null; // double click, or already recorded
    inFlight.current = true;
    setState('submitting');
    setError(null);
    try {
      const r = await send(txnId);
      doneRef.current = true;
      setResult(r);
      setState('done');
      return r;
    } catch (e: any) {
      if (e instanceof ApiError && e.outcome === 'UNKNOWN') {
        // the host may or may not have saved it: keep the SAME transaction id for the retry
        setState('unknown');
        setError(e.message || 'The pharmacy server did not answer.');
      } else {
        // a definite refusal: nothing was saved (the same id may be used again after correcting the input)
        setState('failed');
        setError(e?.message || 'The payment was not saved.');
      }
      return null;
    } finally {
      inFlight.current = false;
    }
  };

  const startNew = () => {
    doneRef.current = false;
    setTxnId(newClientTxnId());
    setState('idle');
    setResult(null);
    setError(null);
  };

  return { txnId, state, result, error, submit, startNew, busy: state === 'submitting' };
}
