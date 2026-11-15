/**
 * Phase 8c: reconnect backoff of the desktop app (kept free of Electron imports so it can be unit-tested; used by
 * electron/connection.ts).
 *
 * When the connection to the backend or the host is lost, extra connection checks are made after 1 s, 2 s, 5 s and
 * then every 10 s until one succeeds. This is separate from the 5 s heartbeat, which keeps running unchanged: the
 * backoff only adds the early retries (so a short drop recovers in about a second) and stops as soon as the
 * connection is back, monitoring stops, or the target changes. At most one retry timer exists at any time.
 */
export const DESKTOP_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

/** delay before retry number `attempt` (0-based): 1 s, 2 s, 5 s, then 10 s for every later retry */
export function desktopReconnectDelay(attempt: number): number {
  const i = Math.min(Math.max(0, Math.floor(attempt)), DESKTOP_RECONNECT_DELAYS_MS.length - 1);
  return DESKTOP_RECONNECT_DELAYS_MS[i];
}

export interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: any) => void;
}

export class ReconnectScheduler {
  private timer: unknown = null;
  private attempt = 0;
  private running = false;
  private generation = 0;
  /** delays used so far in the current run (diagnostics and tests) */
  readonly delays: number[] = [];

  /**
   * @param probe one connection check; resolves true when the connection is back (or no longer worth retrying)
   */
  constructor(private readonly probe: () => Promise<boolean>, private readonly timers: TimerApi = { setTimeout, clearTimeout }) {}

  get active(): boolean { return this.running; }

  /** Start retrying (no effect while already retrying: never two schedules at once). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.delays.length = 0;
    this.generation++;
    this.schedule(this.generation);
  }

  /** Stop retrying and clear the pending timer. */
  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(gen: number): void {
    const delay = desktopReconnectDelay(this.attempt++);
    this.delays.push(delay);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.run(gen);
    }, delay);
  }

  private async run(gen: number): Promise<void> {
    let done = false;
    try { done = await this.probe(); } catch { done = false; }
    if (gen !== this.generation || !this.running) return; // stopped (or restarted) while the check was running
    if (done) this.stop();
    else this.schedule(gen);
  }
}
