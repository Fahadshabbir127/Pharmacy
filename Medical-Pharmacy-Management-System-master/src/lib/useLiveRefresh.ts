/**
 * Phase 8b: refresh a screen when the host reports a change it shows (see liveEvents.ts).
 *
 *  - listens to the window CustomEvent dispatched by App.tsx; reacts to its topics and to full resyncs ('all')
 *  - bursts are coalesced (a sale reports sales + inventory + customers at once): one refresh per burst
 *  - never two refreshes at the same time: a change during a refresh schedules exactly one more afterwards
 *  - a hidden screen (kept mounted after a visit) does not reload in the background; it is marked stale and
 *    reloads once when it is shown again
 *  - the latest `refresh` is always used, so the effect does not re-subscribe on every render (no effect loops)
 */
import { useEffect, useRef } from 'react';
import { LIVE_EVENT_NAME, liveDetailMatches, type LiveChangeDetail, type LiveTopic } from './liveEvents';

export function dispatchLiveChange(detail: LiveChangeDetail): void {
  window.dispatchEvent(new CustomEvent<LiveChangeDetail>(LIVE_EVENT_NAME, { detail }));
}

export function useLiveRefresh(topics: readonly LiveTopic[], refresh: () => unknown, opts: { active?: boolean; debounceMs?: number } = {}): void {
  const active = opts.active ?? true;
  const debounceMs = opts.debounceMs ?? 250;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const activeRef = useRef(active);
  activeRef.current = active;
  const topicsKey = topics.join(',');
  const state = useRef({ stale: false, running: false, again: false, timer: null as ReturnType<typeof setTimeout> | null });

  const run = async () => {
    const s = state.current;
    if (s.running) { s.again = true; return; }
    s.running = true;
    s.stale = false;
    try { await refreshRef.current(); } catch { /* the screen shows its own errors */ } finally {
      s.running = false;
      if (s.again) { s.again = false; void run(); }
    }
  };

  useEffect(() => {
    const interested = topicsKey.split(',') as LiveTopic[];
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<LiveChangeDetail>).detail;
      if (!detail || !liveDetailMatches(detail, interested)) return;
      const s = state.current;
      if (!activeRef.current) { s.stale = true; return; } // hidden: reload when shown again
      if (s.timer) clearTimeout(s.timer);
      s.timer = setTimeout(() => { s.timer = null; void run(); }, debounceMs);
    };
    window.addEventListener(LIVE_EVENT_NAME, onChange);
    return () => {
      window.removeEventListener(LIVE_EVENT_NAME, onChange);
      if (state.current.timer) clearTimeout(state.current.timer);
      state.current.timer = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicsKey, debounceMs]);

  // shown again after changes arrived while hidden: one refresh
  useEffect(() => {
    if (active && state.current.stale) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
