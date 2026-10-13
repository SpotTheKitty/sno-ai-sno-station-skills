import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isObject } from './config.ts';
import type { Config } from './config.ts';
import type { ParsedLine, ParsedSession } from './harvest.ts';

export interface AgentSession {
  path: string;
  harness: 'hermes' | 'openclaw';
  mtime: number;
  read(): ParsedSession;
}

function argumentsValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

// Keep Claude's existing message/block shape so rendering, citations and tool-result joins stay shared.
function messageRecord(message: Record<string, unknown>, timestamp: unknown): Record<string, unknown> {
  const content: unknown[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
    : Array.isArray(message.content) ? message.content.map(block => {
      if (isObject(block) && block.type === 'toolCall') return { type: 'tool_use', id: block.id, name: block.name, input: block.arguments };
      return block;
    }) : [];
  const calls = argumentsValue(message.tool_calls);
  if (Array.isArray(calls)) for (const call of calls.filter(isObject)) {
    if (isObject(call.function)) content.push({ type: 'tool_use', id: call.id, name: call.function.name,
      input: argumentsValue(call.function.arguments) });
  }
  const tool = message.role === 'tool' || message.role === 'toolResult';
  let toolResult: unknown;
  if (tool) {
    try { toolResult = argumentsValue(message.content); }
    catch { /* A plain-text tool result is not a JSON envelope. */ }
  }
  const failed = isObject(toolResult) && (typeof toolResult.error === 'string' && !!toolResult.error
    || typeof toolResult.exit_code === 'number' && toolResult.exit_code !== 0);
  const { tool_calls: _toolCalls, ...fields } = message;
  return { type: tool ? 'tool' : message.role, timestamp,
    ...(isObject(toolResult) ? { toolUseResult: toolResult } : {}),
    message: { ...fields, role: tool ? 'tool' : message.role, content: tool ? [{ type: 'tool_result',
      tool_use_id: message.tool_call_id ?? message.toolCallId, content: message.content,
      is_error: message.isError === true || failed }] : content } };
}

function sessionLines(id: string, cwd: string, messages: Record<string, unknown>[]): ParsedSession {
  const lines: ParsedLine[] = [{ source_line: 1, record: { type: 'session_meta', payload: { id, cwd } } },
    ...messages.map((record, index) => ({ source_line: index + 2, record }))];
  return { ok: true, lines, complete_lines: lines.length };
}

// Read a consistent snapshot in read-only mode, including still-open sessions; exporter cwd/time filters
// omitted them on the proof host. Hermes timestamps are epoch seconds, unlike the file sources' ms.
export function hermesSessions(config: Config, floor: number, quiet: number, log: string[]): AgentSession[] {
  const database = join(config.hermes_home, 'state.db');
  if (!existsSync(database)) return [];
  try {
    const output = execFileSync('python3', ['-c', `
import json, pathlib, sqlite3, sys
db = sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
db.execute('BEGIN')
rows = db.execute('SELECT s.id, s.source, s.model, s.started_at, s.ended_at, s.cwd, s.billing_provider, MAX(m.timestamp) AS last_message FROM sessions s JOIN messages m ON m.session_id=s.id GROUP BY s.id HAVING last_message >= ? AND last_message <= ? ORDER BY last_message, s.id', (float(sys.argv[2])/1000, float(sys.argv[3])/1000)).fetchall()
for row in rows:
 session = dict(row)
 session['messages'] = [dict(m) for m in db.execute('SELECT role, content, tool_calls, tool_call_id, tool_name, timestamp FROM messages WHERE session_id=? ORDER BY timestamp, id', (row['id'],))]
 print(json.dumps(session))
db.close()
`, database, String(floor), String(quiet)], { encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
    return output.split('\n').filter(Boolean).flatMap(line => {
      const session: unknown = JSON.parse(line);
      if (!isObject(session) || typeof session.id !== 'string' || typeof session.last_message !== 'number'
        || !Array.isArray(session.messages)) throw new Error('invalid database session');
      const messages = session.messages.filter(isObject);
      const first = messages.find(message => message.role === 'user');
      if (typeof first?.content === 'string' && first.content.startsWith('[sno-oneshot]')) return [];
      const id = session.id;
      return [{ path: join(database, `${encodeURIComponent(id)}.jsonl`), harness: 'hermes' as const,
        mtime: session.last_message * 1000,
        read: () => sessionLines(id, typeof session.cwd === 'string' ? session.cwd : '',
          messages.map(message => messageRecord(message, typeof message.timestamp === 'number'
            ? new Date(message.timestamp * 1000).toISOString() : message.timestamp))) }];
    });
  } catch (error) { log.push(`hermes database ${database} read failed: ${String(error)}; sessions skipped`); return []; }
}

function eventRecord(event: Record<string, unknown>): Record<string, unknown> {
  const data = isObject(event.data) ? event.data : {};
  if (event.type === 'user.message' || event.type === 'assistant.message') {
    return messageRecord(isObject(data.message) ? data.message : {}, event.ts);
  }
  if (event.type === 'tool.call') return { type: 'tool', timestamp: event.ts, message: { role: 'tool', content: [
    { type: 'tool_use', id: data.toolCallId, name: data.name, input: argumentsValue(data.arguments) },
  ] } };
  if (event.type === 'tool.result') {
    if (isObject(data.message)) return messageRecord(data.message, event.ts);
    const result = data.output ?? data.result ?? '';
    return messageRecord({ role: 'tool', tool_call_id: data.toolCallId,
      content: typeof result === 'string' ? result : JSON.stringify(result),
      isError: data.isError === true || data.success === false || data.status === 'failed' }, event.ts);
  }
  return { type: event.type === 'session.started' || event.type === 'session.ended' ? 'session_meta' : 'unknown',
    payload: { ...data, provider: event.provider, model: event.modelId }, timestamp: event.ts };
}

function openclawExport(key: string, id: string, env: NodeJS.ProcessEnv): ParsedSession {
  const workspace = mkdtempSync(join(tmpdir(), 'rem-openclaw-'));
  try {
    const output = execFileSync('openclaw', ['sessions', 'export-trajectory', '--session-key', key, '--json', '--workspace', workspace],
      { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
    const exported: unknown = JSON.parse(output);
    if (!isObject(exported) || typeof exported.outputDir !== 'string') throw new Error('export has no outputDir');
    const events = readFileSync(join(exported.outputDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => {
      const event: unknown = JSON.parse(line);
      if (!isObject(event)) throw new Error('invalid trajectory event');
      return event;
    });
    const start = events.find(event => event.type === 'session.started');
    const data = isObject(start?.data) ? start.data : {};
    const cwd = typeof data.workspaceDir === 'string' ? data.workspaceDir : events.find(event => typeof event.workspaceDir === 'string')?.workspaceDir;
    // Exports replace these real path prefixes; $WORKSPACE_DIR names our export temp, not the session cwd.
    const directory = typeof cwd !== 'string' || cwd.startsWith('$WORKSPACE_DIR') ? '' : cwd
      .replace(/^\$OPENCLAW_STATE_DIR(?=\/|$)/, env.OPENCLAW_STATE_DIR ?? '')
      .replace(/^\$HOME(?=\/|$)/, env.HOME ?? '');
    return sessionLines(id, directory, events.map(eventRecord));
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

export function openclawSessions(config: Config, floor: number, quiet: number, log: string[]): AgentSession[] {
  if (!existsSync(config.openclaw_home)) return [];
  const env = { ...process.env, OPENCLAW_STATE_DIR: config.openclaw_home };
  try {
    const output = execFileSync('openclaw', ['sessions', 'list', '--json'], { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
    const listed: unknown = JSON.parse(output);
    if (!isObject(listed) || !Array.isArray(listed.sessions)) throw new Error('list has no sessions');
    return listed.sessions.filter(isObject).flatMap(session => {
      if (typeof session.key !== 'string' || typeof session.sessionId !== 'string' || typeof session.updatedAt !== 'number') {
        log.push(`openclaw list: invalid session row ${JSON.stringify(session)}; skipped`); return [];
      }
      const key = session.key;
      const id = session.sessionId;
      if (key.includes(':explicit:sno-oneshot-') || session.updatedAt < floor || session.updatedAt > quiet) return [];
      return [{ path: join(config.openclaw_home, 'sessions', `${encodeURIComponent(key)}.jsonl`),
        harness: 'openclaw' as const, mtime: session.updatedAt, read: () => openclawExport(key, id, env) }];
    });
  } catch (error) { log.push(`openclaw sessions list failed: ${String(error)}; sessions skipped`); return []; }
}
