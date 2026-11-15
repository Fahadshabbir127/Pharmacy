/**
 * Phase 9A.2: private backup folders (.work/ and encrypted/).
 *
 * Windows: the folder's access list is set to exactly "owner process user, SYSTEM, Administrators: full control",
 * inheritance from the parent blocked, and then READ BACK and checked independently:
 *   - the scripts are fixed text written here, passed with -EncodedCommand; the folder path is passed only in the
 *     BT_ACL_TARGET environment variable and used only as a literal path (never placed in script text)
 *   - powershell.exe is started by absolute path, without a shell, with -NoProfile -NonInteractive and a timeout
 *   - the process identity (user SID and token default-owner SID) and the folder owner come from Windows security
 *     APIs; the owner must be one of those two SIDs (an elevated process is not assumed to own as Administrators)
 *   - anything unexpected (PowerShell blocked, Constrained Language Mode, timeout, odd output, extra entries)
 *     fails closed with PERMISSIONS_UNVERIFIED. There is no icacls fallback.
 * Linux/macOS: mode 0700, owned by the current user, not a symlink.
 * On every platform the folder must be a real directory (not a symlink or junction) at its expected real path.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BackupError } from './errors';
import { realpathNative, samePath } from './paths';

export const ACL_TIMEOUT_MS = 15_000;
const SID_SYSTEM = 'S-1-5-18';
const SID_ADMINISTRATORS = 'S-1-5-32-544';
const SDDL_ALIASES: Record<string, string> = { SY: SID_SYSTEM, BA: SID_ADMINISTRATORS };
const SID = /^S-1-\d+(-\d+)+$/;

/**
 * The scripts use only the PowerShell language and .NET types: no cmdlets (New-Object, ConvertTo-Json, Get-Acl, ...),
 * so nothing is loaded from the module path; the child's PSModulePath is also restricted to the Windows system modules.
 * The JSON is built by hand; every string value is escaped.
 */
const PS_JSON_STRING = "function J([string]$s) { return '\"' + $s.Replace('\\', '\\\\').Replace('\"', '\\\"') + '\"' }";

/** Fixed script: report identity, owner, access list (SDDL) and folder attributes of $env:BT_ACL_TARGET. */
export const READ_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  PS_JSON_STRING,
  '$p = $env:BT_ACL_TARGET',
  "if ([string]::IsNullOrEmpty($p)) { throw 'no target' }",
  '$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
  '$di = [System.IO.DirectoryInfo]::new($p)',
  "if (-not $di.Exists) { throw 'missing' }",
  '$sec = $di.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)',
  '$owner = $sec.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
  '$sddl = $sec.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)',
  "$reparse = if ($di.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { 'true' } else { 'false' }",
  "$out = '{\"user\":' + (J $id.User.Value) + ',\"tokenOwner\":' + (J $id.Owner.Value) + ',\"owner\":' + (J $owner) + ',\"sddl\":' + (J $sddl) + ',\"reparse\":' + $reparse + '}'",
  '[Console]::Out.Write($out)',
].join('\n');

/** Fixed script: replace only the access list of $env:BT_ACL_TARGET (owner untouched). */
export const APPLY_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$p = $env:BT_ACL_TARGET',
  "if ([string]::IsNullOrEmpty($p)) { throw 'no target' }",
  '$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
  '$di = [System.IO.DirectoryInfo]::new($p)',
  "if (-not $di.Exists) { throw 'missing' }",
  "if ($di.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'reparse point' }",
  '$sec = $di.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)',
  "$sddl = 'D:P(A;OICI;FA;;;' + $id.User.Value + ')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'",
  '$sec.SetSecurityDescriptorSddlForm($sddl, [System.Security.AccessControl.AccessControlSections]::Access)',
  '$di.SetAccessControl($sec)',
  "[Console]::Out.Write('{\"applied\":true}')",
].join('\n');

export type AclScript = 'read' | 'apply';
/** Runs one of the two fixed scripts against a folder; returns its standard output. Injectable for tests. */
export type AclRunner = (script: AclScript, target: string) => Promise<string>;

const windowsRoot = () => process.env.SystemRoot || process.env.windir || 'C:\\Windows';
export function powershellPath(): string {
  return path.win32.join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The child's environment: inherited, minus any PSModulePath / BT_ACL_TARGET (in any letter case), plus our own. */
export function aclChildEnv(target: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!['psmodulepath', 'bt_acl_target'].includes(k.toLowerCase())) env[k] = v;
  env.PSModulePath = path.win32.join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  env.BT_ACL_TARGET = target;
  return env;
}

export const defaultAclRunner: AclRunner = (script, target) => new Promise((resolve, reject) => {
  const text = script === 'read' ? READ_ACL_SCRIPT : APPLY_ACL_SCRIPT;
  const encoded = Buffer.from(text, 'utf16le').toString('base64');
  execFile(powershellPath(), ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encoded], {
    env: aclChildEnv(target),
    timeout: ACL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024,
  }, (err, stdout) => (err ? reject(new BackupError('PERMISSIONS_UNVERIFIED', 'acl')) : resolve(String(stdout))));
});

export interface AclReport { user: string; tokenOwner: string; owner: string; sddl: string; reparse: boolean }

function parseReport(out: string): AclReport {
  let o: any;
  try { o = JSON.parse(out.trim()); } catch { throw new BackupError('PERMISSIONS_UNVERIFIED', 'acl'); }
  const ok = o && typeof o === 'object' && ['user', 'tokenOwner', 'owner'].every((k) => typeof o[k] === 'string' && SID.test(o[k]))
    && typeof o.sddl === 'string' && o.sddl.length < 4096 && typeof o.reparse === 'boolean';
  if (!ok) throw new BackupError('PERMISSIONS_UNVERIFIED', 'acl');
  return { user: o.user, tokenOwner: o.tokenOwner, owner: o.owner, sddl: o.sddl, reparse: o.reparse };
}

/**
 * Independent check of an access-list SDDL: inheritance blocked (P; AI tolerated), exactly three allow entries with
 * full access (FA) inherited by sub-folders and files (OI CI, nothing else), for exactly the given user, SYSTEM and
 * Administrators. Returns true only for that exact shape.
 */
export function isExpectedSddl(sddl: string, userSid: string): boolean {
  const m = /^D:([A-Z]*)((?:\([^()]*\))+)$/.exec(sddl);
  if (!m) return false;
  const dacl: string[] = m[1].match(/P|AI|AR/g) ?? []; // DACL flags: P (protected) required; AI/AR (auto-inherit) tolerated
  if (dacl.join('') !== m[1] || !dacl.includes('P') || new Set(dacl).size !== dacl.length) return false;
  const aces = m[2].slice(1, -1).split(')(');
  if (aces.length !== 3) return false;
  const want = new Set([userSid, SID_SYSTEM, SID_ADMINISTRATORS]);
  if (want.size !== 3) return false;
  const seen = new Set<string>();
  for (const ace of aces) {
    const parts = ace.split(';');
    if (parts.length !== 6) return false;
    const [type, aceFlags, rights, objGuid, inhGuid, rawSid] = parts;
    if (type !== 'A' || objGuid !== '' || inhGuid !== '') return false;
    const fl = (aceFlags.match(/.{2}/g) ?? []).sort().join('');
    if (aceFlags.length !== 4 || fl !== 'CIOI') return false;
    if (rights !== 'FA' && rights.toLowerCase() !== '0x1f01ff') return false;
    const sid = SDDL_ALIASES[rawSid] ?? rawSid;
    if (!want.has(sid) || seen.has(sid)) return false;
    seen.add(sid);
  }
  return seen.size === 3;
}

function checkReport(r: AclReport): boolean {
  return !r.reparse && (r.owner === r.user || r.owner === r.tokenOwner) && isExpectedSddl(r.sddl, r.user);
}

export interface PrivateDirOptions {
  platform?: NodeJS.Platform;
  aclRunner?: AclRunner;
  /** POSIX owner to require (defaults to process.getuid()) */
  uid?: number;
}

/** The folder itself: a real directory (no symlink/junction) whose real path is its expected path. */
async function assertRealDirectory(dir: string, platform: NodeJS.Platform): Promise<void> {
  let st;
  try { st = await fs.lstat(dir); } catch { throw new BackupError('PATH_REJECTED', 'private-dir'); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new BackupError('PATH_REJECTED', 'private-dir');
  let real: string;
  try { real = await realpathNative(dir); } catch { throw new BackupError('PATH_REJECTED', 'private-dir'); }
  if (!samePath(real, dir, platform)) throw new BackupError('PATH_REJECTED', 'private-dir');
}

/** Verify (never change) that `dir` is a protected private folder. Throws PATH_REJECTED or PERMISSIONS_UNVERIFIED. */
export async function verifyPrivateDir(dir: string, opts: PrivateDirOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  await assertRealDirectory(dir, platform);
  if (platform === 'win32') {
    const runner = opts.aclRunner ?? defaultAclRunner;
    let report: AclReport;
    try { report = parseReport(await runner('read', dir)); } catch { throw new BackupError('PERMISSIONS_UNVERIFIED', 'acl'); }
    if (!checkReport(report)) throw new BackupError('PERMISSIONS_UNVERIFIED', 'acl');
    return;
  }
  const st = await fs.lstat(dir);
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  if (st.uid !== uid || (st.mode & 0o077) !== 0) throw new BackupError('PERMISSIONS_UNVERIFIED', 'mode');
}

/**
 * Create `dir` if needed (its parent must exist) and make it private, then verify by reading back.
 * An existing folder that cannot be made private (e.g. owned by another account) is refused, never used.
 */
export async function ensurePrivateDir(dir: string, opts: PrivateDirOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw new BackupError('WRITE_FAILED', 'private-dir');
  }
  await assertRealDirectory(dir, platform);
  if (platform === 'win32') {
    try { await verifyPrivateDir(dir, opts); return; } catch (e: any) { if (e?.code !== 'PERMISSIONS_UNVERIFIED') throw e; }
    const runner = opts.aclRunner ?? defaultAclRunner;
    try {
      const out = await runner('apply', dir);
      if (out.trim() !== '{"applied":true}') throw new Error('unexpected');
    } catch { throw new BackupError('PERMISSIONS_UNVERIFIED', 'acl'); }
    await verifyPrivateDir(dir, opts); // independent read-back
    return;
  }
  try { await fs.chmod(dir, 0o700); } catch { throw new BackupError('PERMISSIONS_UNVERIFIED', 'mode'); }
  await verifyPrivateDir(dir, opts);
}
