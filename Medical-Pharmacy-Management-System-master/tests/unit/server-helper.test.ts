/**
 * The test server helper must finish stop()/kill() for a server that has already gone, whatever ended it.
 * Regression: stop() checked only `exitCode`; a process ended by a signal has exitCode === null (on Windows every
 * kill('SIGTERM') ends the process that way), so a second stop() - e.g. a test's own stop() followed by
 * afterEach's - waited forever for an 'exit' event that had already fired ("Hook timed out in 90000ms").
 */
import { describe, it, expect } from 'vitest';
import { startServer, PORT } from '../helpers/server';
import net from 'node:net';

const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms))]);
const portFree = () => new Promise<boolean>((resolve) => {
  const s = net.connect(PORT, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(true));
});

describe('test server helper: stop() and kill() on a server that has already exited', () => {
  it('stop() after the server was ended by a signal (exitCode null, as on Windows) returns at once', async () => {
    const srv = await startServer();
    await srv.kill(); // SIGKILL: exitCode === null, signalCode === 'SIGKILL'
    await within(srv.stop(), 10_000, 'stop() after kill()');
    expect(await portFree()).toBe(true);
  });

  it('stop() twice and kill() after stop() return at once; the server is gone and the port is free', async () => {
    const srv = await startServer();
    await within(srv.stop(), 10_000, 'first stop()');
    await within(srv.stop(), 10_000, 'second stop()');
    await within(srv.kill(), 10_000, 'kill() after stop()');
    expect(await portFree()).toBe(true);
  });
});
