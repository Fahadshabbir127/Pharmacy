/**
 * Phase 9A.2 test helper (child process). argv[2] = JSON {dataDir, dbFile, mode}:
 *   mode "hold":  take the backup lock, report {type:'locked'} (or {type:'error', code}), keep doing asynchronous
 *                 work (timers, file reads) while holding it, release on {type:'release'} and exit
 *   mode "write": take the lock, create a temporary plaintext file in .work, write to it, report {type:'writing'},
 *                 then hang (the parent kills it to simulate a crash)
 */
import fs from 'node:fs/promises';
import { BackupLock } from '../../server/backup/lock';
import { backupLayout } from '../../server/backup/paths';
import { createWorkFile, writeAll } from '../../server/backup/fsSafe';

const { dataDir, dbFile, mode } = JSON.parse(process.argv[2]);
const layout = backupLayout(dataDir, dbFile);
const send = (m: unknown) => process.send?.(m);

(async () => {
  let lock: BackupLock;
  try { lock = await BackupLock.acquire(layout); } catch (e: any) { send({ type: 'error', code: e?.code ?? 'UNKNOWN' }); process.exit(0); return; }
  if (mode === 'write') {
    const f = await createWorkFile(lock, 'snapshot');
    await writeAll(f.handle, Buffer.alloc(64 * 1024, 0x53));
    send({ type: 'writing', path: f.path });
    setInterval(() => undefined, 1000); // hang until killed
    return;
  }
  let ticks = 0;
  const work = setInterval(() => { ticks++; void fs.stat(layout.workDir).catch(() => undefined); }, 20); // async work while holding
  send({ type: 'locked' });
  process.on('message', (m: any) => {
    if (m?.type !== 'release') return;
    clearInterval(work);
    lock.release();
    send({ type: 'released', ticks });
    setTimeout(() => process.exit(0), 10);
  });
})();
