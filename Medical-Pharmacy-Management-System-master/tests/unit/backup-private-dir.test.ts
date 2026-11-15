/**
 * Phase 9A.2: private backup folders (server/backup/privateDir.ts).
 * The Windows access-list logic is tested on every platform with an injected runner; real Windows access lists,
 * junctions and PowerShell run only on Windows; POSIX mode and owner only on Linux/macOS.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APPLY_ACL_SCRIPT, READ_ACL_SCRIPT, type AclRunner, aclChildEnv, defaultAclRunner, ensurePrivateDir, isExpectedSddl, powershellPath, verifyPrivateDir,
} from '../../server/backup/privateDir';
import { BackupError } from '../../server/backup/errors';

const isWin = process.platform === 'win32';
const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const GOOD = `D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
const report = (o: Record<string, unknown> = {}) => JSON.stringify({ user: USER, tokenOwner: USER, owner: USER, sddl: GOOD, reparse: false, ...o });

let dir: string;
beforeEach(() => { dir = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-priv-'))), 'private'); });
afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

describe('SDDL check (independent of PowerShell)', () => {
  it('accepts exactly: inheritance blocked, full control for the user, SYSTEM and Administrators (in any order, either spelling)', () => {
    expect(isExpectedSddl(GOOD, USER)).toBe(true);
    expect(isExpectedSddl(`D:P(A;CIOI;FA;;;BA)(A;OICI;0x1f01ff;;;S-1-5-18)(A;OICI;FA;;;${USER})`, USER)).toBe(true);
    expect(isExpectedSddl(`D:PAR(A;OICI;FA;;;${USER})(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)`, USER)).toBe(true);
  });

  it('rejects anything else', () => {
    const bad = [
      `D:AI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, // inheritance not blocked
      `D:(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `${GOOD}(A;OICI;FA;;;BU)`, // an extra entry (Users)
      `${GOOD}(A;OICI;FR;;;WD)`, // Everyone read
      `D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)`, // missing Administrators
      `D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;SY)`, // duplicate
      `D:P(A;OICIID;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, // inherited entry
      `D:P(A;OICIIO;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, // inherit-only
      `D:P(A;CI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, // not inherited by files
      `D:P(D;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, // deny entry
      `D:P(A;OICI;FR;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, // read only
      `D:P(A;OICI;FA;;;${OTHER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, // another account
      `D:P(OA;OICI;FA;1234;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `D:P(A;OICI;FA;x;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      `D:PP(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
      'D:NO_ACCESS_CONTROL', 'D:P', '', 'garbage', `O:BAD:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
    ];
    for (const s of bad) expect(isExpectedSddl(s, USER), s).toBe(false);
    expect(isExpectedSddl(GOOD.replace(USER, 'SY'), 'S-1-5-18')).toBe(false); // a SYSTEM process: refused, not merged
  });
});

describe('Windows logic with an injected runner (runs on every platform)', () => {
  const opts = (runner: AclRunner) => ({ platform: 'win32' as const, aclRunner: runner });
  const unverified = async (p: Promise<unknown>) => { await expect(p).rejects.toBeInstanceOf(BackupError); await expect(p).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' }); };

  it('verify passes for the expected report; the owner may be the user or the token default owner reported by Windows', async () => {
    fs.mkdirSync(dir);
    await verifyPrivateDir(dir, opts(async () => report()));
    await verifyPrivateDir(dir, opts(async () => report({ owner: 'S-1-5-32-544', tokenOwner: 'S-1-5-32-544' }))); // elevated: owner reported as Administrators
  });

  it('verify fails closed: other owner, Administrators owner without that token owner, reparse point, bad output, runner failure, odd access list', async () => {
    fs.mkdirSync(dir);
    await unverified(verifyPrivateDir(dir, opts(async () => report({ owner: OTHER }))));
    await unverified(verifyPrivateDir(dir, opts(async () => report({ owner: 'S-1-5-32-544' })))); // not assumed for an elevated process
    await unverified(verifyPrivateDir(dir, opts(async () => report({ reparse: true }))));
    await unverified(verifyPrivateDir(dir, opts(async () => report({ sddl: `${GOOD}(A;OICI;FA;;;BU)` }))));
    await unverified(verifyPrivateDir(dir, opts(async () => 'not json')));
    await unverified(verifyPrivateDir(dir, opts(async () => JSON.stringify({ user: USER }))));
    await unverified(verifyPrivateDir(dir, opts(async () => report({ user: 'not-a-sid' }))));
    await unverified(verifyPrivateDir(dir, opts(async () => { throw new Error('PowerShell blocked or timed out'); })));
  });

  it('ensure: verifies first; if wrong, applies the fixed script and verifies again by reading back', async () => {
    const calls: string[] = [];
    let applied = false;
    const runner: AclRunner = async (script, target) => {
      calls.push(`${script}:${target === dir}`);
      if (script === 'apply') { applied = true; return '{"applied":true}'; }
      return applied ? report() : report({ sddl: `D:AI(A;ID;FA;;;BU)` });
    };
    await ensurePrivateDir(dir, opts(runner));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(calls).toEqual(['read:true', 'apply:true', 'read:true']);
  });

  it('ensure fails closed when applying fails or the read-back is still wrong (the apply result alone is not trusted)', async () => {
    await unverified(ensurePrivateDir(dir, opts(async (s) => { if (s === 'apply') throw new Error('access denied'); return report({ owner: OTHER }); })));
    await unverified(ensurePrivateDir(dir, opts(async (s) => (s === 'apply' ? '{"applied":true}' : report({ owner: OTHER })))));
    await unverified(ensurePrivateDir(dir, opts(async (s) => (s === 'apply' ? 'something else' : report({ sddl: 'D:AI' })))));
  });

  it('the scripts are fixed text using no cmdlets (nothing from the module path); the target comes only from an environment variable', () => {
    for (const s of [READ_ACL_SCRIPT, APPLY_ACL_SCRIPT]) {
      expect(s).toContain('$env:BT_ACL_TARGET');
      expect(s).toContain("$ErrorActionPreference = 'Stop'");
      expect(s).toContain('[System.IO.DirectoryInfo]::new($p)');
      // no Verb-Noun command (New-Object, ConvertTo-Json, Get-Acl, Set-Acl, Invoke-Expression, ...) and no aliases
      expect(s).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
      expect(s).not.toMatch(/\b(iex|icm|gci|gi|ni|sal|ipmo|Import-Module)\b/i);
    }
    expect(APPLY_ACL_SCRIPT).toContain("throw 'reparse point'");
    expect(powershellPath()).toMatch(/[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    expect(path.win32.isAbsolute(powershellPath())).toBe(true);
  });

  it('the child environment pins PSModulePath to the Windows system modules and drops look-alike variables in any letter case', () => {
    const env = aclChildEnv('C:\\data\\backups\\.work', { Path: 'C:\\x', psmodulepath: 'C:\\Users\\me\\Documents\\Mods', PSMODULEPATH: 'D:\\evil', bt_acl_target: 'C:\\other', KEEP: '1' });
    const keys = Object.keys(env);
    expect(keys.filter((k) => k.toLowerCase() === 'psmodulepath')).toEqual(['PSModulePath']);
    expect(keys.filter((k) => k.toLowerCase() === 'bt_acl_target')).toEqual(['BT_ACL_TARGET']);
    expect(env.PSModulePath).toMatch(/[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]Modules$/i);
    expect(env.BT_ACL_TARGET).toBe('C:\\data\\backups\\.work');
    expect(env.KEEP).toBe('1');
  });
});

describe.skipIf(isWin)('POSIX (Linux/macOS)', () => {
  it('creates the folder with mode 0700 owned by this user; a 0755 folder is tightened', async () => {
    await ensurePrivateDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.chmodSync(dir, 0o755);
    await expect(verifyPrivateDir(dir)).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
    await ensurePrivateDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a folder owned by another user, a symlinked folder and a file', async () => {
    await ensurePrivateDir(dir);
    await expect(verifyPrivateDir(dir, { uid: 12345 })).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
    const target = path.join(path.dirname(dir), 'target');
    fs.mkdirSync(target, { mode: 0o700 });
    const link = path.join(path.dirname(dir), 'link');
    fs.symlinkSync(target, link);
    await expect(ensurePrivateDir(link)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(verifyPrivateDir(link)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    const file = path.join(path.dirname(dir), 'file');
    fs.writeFileSync(file, 'x');
    await expect(ensurePrivateDir(file)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
  });
});

describe.skipIf(!isWin)('Windows (real access lists through PowerShell)', () => {
  it('a new folder gets exactly owner/SYSTEM/Administrators with inheritance blocked; verified by an independent read', async () => {
    await ensurePrivateDir(dir);
    const r = JSON.parse(await defaultAclRunner('read', dir));
    expect(isExpectedSddl(r.sddl, r.user)).toBe(true);
    expect([r.user, r.tokenOwner]).toContain(r.owner);
    await verifyPrivateDir(dir);
  }, 60_000);

  it('an existing folder with inherited (open) permissions is tightened', async () => {
    fs.mkdirSync(dir);
    await expect(verifyPrivateDir(dir)).rejects.toMatchObject({ code: 'PERMISSIONS_UNVERIFIED' });
    await ensurePrivateDir(dir);
    await verifyPrivateDir(dir);
  }, 60_000);

  it('a path with spaces, quotes, brackets and $ is handled literally', async () => {
    const odd = path.join(path.dirname(dir), "odd [x] $(calc) 'q' name");
    await ensurePrivateDir(odd);
    await verifyPrivateDir(odd);
  }, 60_000);

  it('a junction is refused before PowerShell is used', async () => {
    const target = path.join(path.dirname(dir), 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, dir, 'junction');
    await expect(ensurePrivateDir(dir)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
  }, 60_000);
});
