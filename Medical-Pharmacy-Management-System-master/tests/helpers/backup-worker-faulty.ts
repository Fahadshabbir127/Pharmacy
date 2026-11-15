/**
 * Phase 9A.3 test helper: a backup worker that misbehaves on purpose (workerData.fault), reusing the real job code.
 * No test hooks exist in the production worker; it is imported here with workerData.manual = true so it does not
 * start itself.
 *   crash                 throws an uncaught error              -> WORKER_FAILED 'crash'
 *   exit-silently         ends the thread without a result      -> WORKER_FAILED 'exit'
 *   exit-code             process.exit(7) inside the thread     -> WORKER_FAILED 'exit'
 *   hang                  never answers                         -> TIMEOUT 'idle'
 *   progress-forever      valid progress, never finishes        -> TIMEOUT 'overall'
 *   bad-result            a malformed 'done' message            -> WORKER_FAILED 'protocol'
 *   wrong-job             a message for another job             -> WORKER_FAILED 'protocol'
 *   leak                  a 'failed' message with an extra field (the password) -> WORKER_FAILED 'protocol'
 *   oom                   allocates until the heap limit        -> WORKER_FAILED 'memory'
 *   fail-code             reports workerData.code / stage       -> that BackupError
 *   after-snapshot-hang   real snapshot (plaintext written), then hangs
 *   after-verify-fail     the whole real job, then reports VERIFY_FAILED instead of the result
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runCreate, runJob } from '../../server/backup/worker';
import { snapshotDatabase } from '../../server/backup/snapshot';
import { parseJob } from '../../server/backup/workerProtocol';

const port = parentPort!;
const fault: string = workerData.fault;
const progress = (jobId: string) => (stage: string, bytesDone: number, bytesTotal: number) => port.postMessage({ type: 'progress', jobId, stage, bytesDone, bytesTotal });

port.once('message', async (raw: unknown) => {
  const job = parseJob(raw);
  const jobId = job.jobId;
  switch (fault) {
    case 'crash':
      setImmediate(() => { throw new Error('worker crashed (test)'); });
      return;
    case 'exit-silently':
      port.close();
      return;
    case 'exit-code':
      process.exit(7);
    case 'hang':
      setInterval(() => undefined, 1000);
      return;
    case 'progress-forever':
      setInterval(() => port.postMessage({ type: 'progress', jobId, stage: 'encrypt', bytesDone: 1, bytesTotal: 10 }), 50);
      return;
    case 'bad-result':
      port.postMessage({ type: 'done', jobId, result: { fileBytes: 'lots' } });
      return;
    case 'wrong-job':
      port.postMessage({ type: 'progress', jobId: '00000000-0000-4000-8000-000000000000', stage: 'encrypt', bytesDone: 0, bytesTotal: 0 });
      return;
    case 'leak':
      port.postMessage({ type: 'failed', jobId, code: 'CORRUPT', stage: 'record', secret: (job as { secret: string }).secret });
      return;
    case 'oom': {
      const keep: unknown[] = [];
      for (;;) keep.push(new Array(1e6).fill({ x: Math.random() }));
    }
    case 'fail-code':
      port.postMessage({ type: 'failed', jobId, code: workerData.code, stage: workerData.stage ?? 'test' });
      return;
    case 'after-snapshot-hang':
      if (job.type !== 'create') throw new Error('create jobs only');
      await snapshotDatabase(job.dbFile, job.snapshotPath);
      port.postMessage({ type: 'progress', jobId, stage: 'inspect', bytesDone: 0, bytesTotal: 0 });
      setInterval(() => undefined, 1000);
      return;
    case 'after-verify-fail':
      if (job.type !== 'create') throw new Error('create jobs only');
      await runCreate(job, progress(jobId) as never);
      port.postMessage({ type: 'failed', jobId, code: 'VERIFY_FAILED', stage: 'mismatch' });
      return;
    default:
      port.postMessage({ type: 'done', jobId, result: await runJob(job, progress(jobId) as never) });
  }
});
