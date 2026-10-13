import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './rem-reflect.ts';
import { RealBackend } from './backend.ts';
import { readState, writeJson } from './store.ts';
import { loadConfig } from './config.ts';
import {
  tmp, fixtureConfig, makeStore, FixtureBackend,
  writeClaudeSession, claudeUser, claudeAssistant, writeCodexSession, codexMeta, codexUser, codexAssistant,
} from './test-helpers.ts';
import type { Config } from './config.ts';

const NOW = new Date('2026-09-08T00:00:00Z');
const MT = new Date('2026-09-07T00:00:00Z').getTime();
function cfg(): Config { return fixtureConfig({ claude_root: tmp('c'), codex_root: tmp('x') }); }
function reportOf(store: string): string {
  const runId = readdirSync(join(store, 'staging')).filter(n => /^\d/.test(n)).sort().pop()!;
  return readFileSync(join(store, 'staging', runId, 'REPORT.md'), 'utf8');
}
function bothHalves(config: Config): void {
  writeClaudeSession(config.claude_root, 'proj', 'cc', [claudeUser('/n', 'cc', 'do it'), claudeAssistant('/n', 'cc', [{ type: 'text', text: 'ok' }])], MT);
  writeCodexSession(config.codex_root, 'cx', [codexMeta('cx', '/n'), codexUser('do it'), codexAssistant('ok')], MT);
}
const cli = tmp('local-consent');
writeFileSync(join(cli, 'sno'), '#!/bin/sh\nif [ "$*" = "station consent" ]; then echo metadata-only; else exit 2; fi\n');
chmodSync(join(cli, 'sno'), 0o755);
const originalPath = process.env.PATH;
process.env.PATH = `${cli}:${originalPath ?? ''}`;
after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });

// A copied login that renews invalidates the original, so the owner would wake up logged out of the agent the
// nightly run borrowed. The loop never copies a login: each turn runs on the owner's own login in place.
test('a run copies no login anywhere under the store', () => {
  const config = cfg();
  writeFileSync(join(config.claude_home, '.credentials.json'), '{"claude":"token"}');
  writeFileSync(join(config.codex_home, 'auth.json'), '{"codex":"token"}');
  const store = makeStore(config);
  bothHalves(config);
  const r = run(store, NOW, 'u', new FixtureBackend());
  assert.equal(r.code, 0, r.lines.join('\n'));
  const copies = listFiles(store).filter(path => /(\.credentials|auth)\.json$/.test(path));
  assert.deepEqual(copies, [], 'no login file was copied under the store');
});

// The owner's hooks, plugins, output style, model pin and MCP servers stay out of a turn through flags, and the
// turn saves no session for the next night to harvest.
test('a model turn runs on the login in place with the owner setup and session saving turned off', () => {
  const bin = tmp('fake-cli');
  const record = join(bin, 'calls.jsonl');
  for (const cli of ['claude', 'codex']) {
    writeFileSync(join(bin, cli), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ cli: ${JSON.stringify(cli)}, args: process.argv.slice(2),
  claudeHome: process.env.CLAUDE_CONFIG_DIR ?? null, codexHome: process.env.CODEX_HOME ?? null }) + '\\n');
process.stdout.write('ok');
`);
    chmodSync(join(bin, cli), 0o755);
  }
  const saved = { path: process.env.PATH, claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  process.env.PATH = `${bin}:${saved.path ?? ''}`;
  process.env.CLAUDE_CONFIG_DIR = '/owner/claude';
  process.env.CODEX_HOME = '/owner/codex';
  try {
    const backend = new RealBackend(30_000);
    backend.spawn({ cli: 'claude', cwd: tmp('turn'), input: 'reply with ok' });
    backend.spawn({ cli: 'codex', cwd: tmp('turn'), input: 'reply with ok' });
  } finally {
    process.env.PATH = saved.path;
    if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.claude;
    if (saved.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.codex;
  }
  const [claude, codex] = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual([claude.claudeHome, claude.codexHome, codex.claudeHome, codex.codexHome],
    ['/owner/claude', '/owner/codex', '/owner/claude', '/owner/codex'], 'neither login directory was redirected');
  for (const flag of ['--setting-sources', 'local', '--strict-mcp-config', '--no-session-persistence']) assert.ok(claude.args.includes(flag), `claude gets ${flag}`);
  for (const flag of ['--ignore-user-config', '--ephemeral']) assert.ok(codex.args.includes(flag), `codex gets ${flag}`);
});

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path); else out.push(path);
    }
  };
  walk(root);
  return out;
}

// a configured harvest root inside the store stops the run before it
//     writes anything and names the offending root ---
test('a harvest root inside the store stops the run before writing anything', () => {
  const config = cfg();
  const store = makeStore(config);
  writeJson(join(store, 'config.json'), { ...loadConfig(store), claude_root: join(store, 'raw') });
  assert.throws(
    () => run(store, NOW, 'u', new FixtureBackend()),
    (e: unknown) => e instanceof Error && e.message.includes('claude_root') && e.message.includes('lies inside store'),
    'the run refuses a harvest root under the store and names it',
  );
  const staged = readdirSync(join(store, 'staging')).filter(n => /^\d/.test(n));
  assert.equal(staged.length, 0, 'no run staging directory was created (nothing written)');
  assert.equal(readState(store).last_start, null, 'no run start was recorded');
});
