/**
 * Wrap a synchronous Express handler so all of its database writes form one
 * transaction, and the response is only sent after COMMIT succeeds.
 *
 *  - handler throws                 -> ROLLBACK, error goes to Express (HTTP 500)
 *  - handler responds with >= 500   -> ROLLBACK (the client was told it failed), response sent
 *  - handler responds with < 500    -> COMMIT, then the response is sent
 *  - COMMIT itself fails            -> nothing committed, the held response is discarded, error -> 500
 *
 * 4xx responses COMMIT on purpose: routes write audit rows for failed logins,
 * blocked access, rate limits, etc. and those must be kept.
 * Async handlers are rejected: better-sqlite3 transactions must be synchronous.
 */
import type { Request, Response, NextFunction } from 'express';
import type { DbAdapter } from './adapter';

type Handler<Req extends Request> = (req: Req, res: Response, next?: NextFunction) => unknown;

class RollbackAfterErrorResponse extends Error {}

type HeldCall = { method: 'json' | 'send' | 'end' | 'sendFile'; args: unknown[] };

export interface TransactionHooks {
  /** Called inside the transaction after the handler, just before COMMIT. */
  beforeCommit?(req: Request): void;
  /** Called after COMMIT, before the held response is sent. */
  afterCommit?(req: Request): void;
}

export function transactionalRoute<Req extends Request>(getDb: () => DbAdapter, handler: Handler<Req>, hooks: TransactionHooks = {}) {
  if (handler.constructor.name === 'AsyncFunction') {
    throw new TypeError('transactionalRoute cannot wrap an async handler');
  }
  return (req: Req, res: Response, next: NextFunction) => {
    const held: HeldCall[] = [];
    const original = { json: res.json, send: res.send, end: res.end, sendFile: res.sendFile };
    const hold = (method: HeldCall['method']) =>
      function (this: Response, ...args: unknown[]) {
        held.push({ method, args });
        return res;
      };
    res.json = hold('json') as any;
    res.send = hold('send') as any;
    res.end = hold('end') as any;
    res.sendFile = hold('sendFile') as any;
    const restore = () => Object.assign(res, original);

    try {
      getDb().transaction(() => {
        const out = handler(req, res, next);
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          throw new TypeError('transactionalRoute handler returned a Promise');
        }
        if (res.statusCode >= 500) throw new RollbackAfterErrorResponse();
        hooks.beforeCommit?.(req);
      });
    } catch (e) {
      restore();
      if (!(e instanceof RollbackAfterErrorResponse)) {
        held.length = 0;
        if (res.statusCode < 500) res.status(500);
        return next(e);
      }
    }
    restore();
    hooks.afterCommit?.(req);
    for (const call of held) (res as any)[call.method](...call.args);
  };
}
