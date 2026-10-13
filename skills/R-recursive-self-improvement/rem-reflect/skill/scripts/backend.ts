import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isObject } from './config.ts';
import type { Config } from './config.ts';
import { message } from './text.ts';
import type { Harness } from './identity.ts';
import { CeilingReached, ceilings } from './session.ts';

export type Cli = 'claude' | 'codex' | 'hermes' | 'openclaw' | 'cursor';
// `kind` records the call role without inferring it from the prompt shape.
export interface SpawnRequest { cli: Cli; model?: string; provider?: string; cwd: string; input: string; kind?: 'labeler' | 'model' | 'preflight' }
export interface Backend {
  spawn(request: SpawnRequest): { stdout: string };
  // A trivial health check of the CLI (optionally under a model). True when the CLI answered.
  preflight?(cli: Cli, cwd: string, model?: string): boolean;
}
export class BackendError extends Error {
  reason: 'labeler-timeout' | 'labeler-unavailable' | 'labeler-invalid-response';
  // `detail` (a spawn error code, or the exit status and a stderr head) goes into the message only, so
  // a log line explains the failure while `reason` stays the exact token labels and filters match on.
  constructor(reason: BackendError['reason'], detail?: string) { super(detail ? `${reason} (${detail})` : reason); this.reason = reason; }
}
export function otherCli(half: Harness): Cli { return half === 'claude-code' ? 'codex' : 'claude'; }

// Kill a child's whole process group so no grandchild outlives the run. A detached child is
// its own group leader, so its pgid equals its pid; -pid signals every member still alive.
function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is already gone */ }
}

// Only Cursor needs a temporary home; the other agents keep the mainline login mechanism.
export function seedLoopHomes(store: string, config: Config, log: string[]): void {
  if (existsSync(config.cursor_root)) seedCursorHome(join(store, '.loop-home', 'cursor'), log);
}

// The build contract's isolated Cursor home, measured to fire none of the user's Cursor hooks and to keep the run's
// transcript out of the real ~/.cursor: the login (a copy of ~/.config/cursor/auth.json on Linux, a link to the login
// keychains on macOS) and a link to ~/.local/share, where cursor-agent is installed.
function seedCursorHome(target: string, log: string[]): void {
  const home = homedir();
  const links = ['.local/share', ...(process.platform === 'darwin' ? ['Library/Keychains'] : [])];
  for (const part of links) {
    mkdirSync(dirname(join(target, part)), { recursive: true, mode: 0o700 });
    rmSync(join(target, part), { force: true });
    symlinkSync(join(home, part), join(target, part));
  }
  if (process.platform === 'darwin') return;
  const source = join(home, '.config', 'cursor', 'auth.json');
  const login = join(target, '.config', 'cursor', 'auth.json');
  if (!existsSync(source)) { rmSync(login, { force: true }); log.push(message('credentialMissing', { cli: 'cursor', path: source })); return; }
  mkdirSync(dirname(login), { recursive: true, mode: 0o700 });
  copyFileSync(source, login);
  chmodSync(login, 0o600);
}

// The real CLI backend. Each call runs in its own process group with a per-call deadline;
// on timeout the group is killed and a `per-call-timeout` ceiling is thrown so the run stops with no
// child left behind. Each turn uses the owner's own login in place: a copied login that renews invalidates
// the original, so the loop never copies one.
export class RealBackend implements Backend {
  private readonly perCallMs: number;
  private readonly loopHomeBase: string | undefined;
  constructor(perCallMs: number = ceilings.perCallMs, options: { loopHomeBase?: string } = {}) {
    this.perCallMs = perCallMs;
    this.loopHomeBase = options.loopHomeBase;
  }
  // A trivial health check: a one-word prompt under a short deadline. The CLI is healthy when the
  // CLI exits zero; a timeout or non-zero exit is a failed preflight.
  preflight(cli: Cli, cwd: string, model?: string): boolean {
    try { this.spawn({ cli, model, cwd, input: 'reply with ok', kind: 'preflight' }); return true; }
    catch (error) { if (error instanceof CeilingReached) throw error; return false; }
  }
  // Keeps the owner's interactive setup out of a turn and saves no session for the next night to harvest.
  // Claude loads no user, project or local settings (hooks, plugins, output style, model pin; the turn's working
  // directory has no local settings) and no MCP server. Codex loads no config.toml (hook trust, MCP, model pin),
  // so no hook runs.
  isolation(cli: Cli): string[] {
    return cli === 'claude'
      ? ['--setting-sources', 'local', '--strict-mcp-config', '--no-session-persistence']
      : ['--ignore-user-config', '--ephemeral'];
  }
  // The prompt goes to the CLI on stdin, never as an argument: a reading-phase prompt bundles several
  // traces and pages (hundreds of KB) and one argv element is capped at 128 KB on Linux (E2BIG).
  // `claude -p` with no positional prompt reads stdin; `codex exec -` reads stdin.
  spawn({ cli, model, provider, cwd, input }: SpawnRequest): { stdout: string } {
    const stationAgent = cli === 'hermes' || cli === 'openclaw';
    if (stationAgent) input = `[sno-oneshot] Station one-shot run, not a user session.\n${input}`;
    const args = cli === 'claude' ? ['-p', '--output-format', 'text', '--allowedTools', 'Read,Grep,Glob', ...this.isolation(cli)]
      : cli === 'codex' ? ['exec', '--skip-git-repo-check', ...this.isolation(cli), '-']
        : cli === 'hermes' ? ['chat', '--query-file', '-', '--oneshot', '-Q', '--ignore-user-config', '--ignore-rules']
          : cli === 'cursor' ? ['-p', '--trust', '--mode', 'ask', '--output-format', 'json']
            : ['agent', '--agent', 'main', '--session-id', `sno-oneshot-${randomUUID()}`, '-m', input, '--json'];
    if (model) args.push(cli === 'hermes' ? '-m' : '--model', model);
    if (cli === 'hermes' && provider) args.push('--provider', provider);
    const options = {
      cwd, env: cli === 'cursor' && this.loopHomeBase ? { ...process.env, HOME: join(this.loopHomeBase, 'cursor') } : undefined, encoding: 'utf8', input,
      timeout: stationAgent ? Math.min(this.perCallMs, 280_000) : this.perCallMs, killSignal: 'SIGKILL', detached: true,
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    } satisfies SpawnSyncOptionsWithStringEncoding & { detached: boolean };
    const child = spawnSync(cli === 'cursor' ? 'cursor-agent' : cli, args, options);
    // cursor-agent leaves a language server running after it exits (observed); its group goes with it.
    if (cli === 'cursor') killGroup(child.pid);
    if (child.error) {
      if (isObject(child.error) && child.error.code === 'ETIMEDOUT') { killGroup(child.pid); throw new CeilingReached('per-call-timeout'); }
      throw new BackendError('labeler-unavailable', isObject(child.error) && typeof child.error.code === 'string' ? child.error.code : String(child.error));
    }
    // A non-zero exit is a failed CLI, not usable output: a CLI that is not logged in exits non-zero
    // ("Not logged in" for Claude, HTTP 401 for Codex), which must fail preflight so its harness degrades.
    if (child.status !== 0) {
      // Over SSH on macOS the Cursor CLI cannot open the login keychain; that is a login failure, not a model failure.
      const detail = cli === 'cursor' && /keychain is locked/.test(`${child.stderr}${child.stdout}`) ? 'Cursor CLI login unreadable (keychain locked)'
        : `exit ${child.status}: ${(child.stderr ?? '').trim().split('\n')[0].slice(0, 200)}`;
      throw new BackendError('labeler-unavailable', detail);
    }
    if (cli === 'cursor') {
      let answer: unknown;
      try { answer = JSON.parse(child.stdout); } catch { throw new BackendError('labeler-invalid-response', 'cursor-agent: output is not JSON'); }
      if (!isObject(answer) || answer.is_error === true || typeof answer.result !== 'string') {
        throw new BackendError('labeler-invalid-response', 'cursor-agent: no successful result');
      }
      return { stdout: answer.result };
    }
    if (cli !== 'openclaw') return { stdout: child.stdout ?? '' };
    let answer: unknown;
    try { answer = JSON.parse(child.stdout); }
    catch { throw new BackendError('labeler-invalid-response', 'openclaw: invalid JSON'); }
    if (!isObject(answer) || answer.status !== 'ok' || !isObject(answer.result) || !Array.isArray(answer.result.payloads)) {
      throw new BackendError('labeler-invalid-response', 'openclaw: no successful result.payloads');
    }
    const parts = answer.result.payloads.filter(isObject);
    if (parts.some(part => part.isError === true)) throw new BackendError('labeler-unavailable', 'openclaw: error payload');
    const stdout = parts.map(part => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
    if (!stdout) throw new BackendError('labeler-invalid-response', 'openclaw: empty answer');
    return { stdout };
  }
}
