import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isObject, reflectionFiles } from './config.ts';
import type { ParsedLine } from './harvest.ts';
import { gitTop } from './identity.ts';
import { firstMessageRecall, recall } from './recall.ts';
import type { CommandResult } from './rem-reflect.ts';
import { atomicWrite } from './store.ts';

// IDE and CLI write the same layout: <root>/<project>/agent-transcripts/<id>/<id>.jsonl.
export function cursorTranscripts(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap(project => {
    const dir = join(root, project, 'agent-transcripts');
    return existsSync(dir) ? readdirSync(dir).map(id => join(dir, id, `${id}.jsonl`)).filter(path => existsSync(path)) : [];
  });
}

// A Cursor row is `{role, message: {content}}`; Claude's `{type, message: {role, content}}` lets every reader stay shared.
export function cursorLines(lines: readonly ParsedLine[]): ParsedLine[] {
  return lines.map(line => {
    const { role, message } = line.record;
    return typeof role === 'string' && isObject(message) ? { ...line, record: { type: role, message: { ...message, role } } } : line;
  });
}

// What the user typed: the `<user_query>` body, without Cursor's `<timestamp>` line.
export function cursorUserText(text: string): string | undefined {
  return /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(text)?.[1];
}

// The repository the Cursor hooks recorded for a conversation; '' (unscoped) when there is none.
export function cursorProject(id: string, log: string[]): string {
  const path = join(process.env.SNO_PROFILE_DIR ?? join(homedir(), '.sno'), 'cursor', 'conversations', `${id}.json`);
  if (!existsSync(path)) return '';
  try {
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(record) && typeof record.project === 'string' ? record.project : '';
  } catch (error) {
    log.push(`cursor conversation record ${path} unreadable: ${String(error)}; conversation collected unscoped`);
    return '';
  }
}

function shownBefore(store: string, session: string): boolean {
  const path = join(store, reflectionFiles.usage);
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf8').split('\n').some(line => {
    try { const row: unknown = JSON.parse(line); return isObject(row) && row.type === 'shown' && row.session_id === session; }
    catch { return false; }
  });
}

// The Cursor hook answer: always exit 0 with `{}` or `{"additional_context": …}`; failures go to stderr.
// The project is the git root of `workspace_roots[0]` (Cursor sends no `cwd`). The first-prompt hook also brings
// the index when no session start showed it, because the IDE's first chat in a new window has no `sessionStart`.
// `heartbeat` is called only when the index is built: it can take seconds and the prompt hook has eight.
export function cursorRecall(store: string, firstMessage: boolean, stdin: string, heartbeat: () => string): CommandResult {
  const stderr: string[] = [];
  const answer = (parts: string[]): CommandResult =>
    ({ code: 0, lines: [JSON.stringify(parts.length ? { additional_context: parts.join('\n') } : {})], stderr });
  try {
    const input: unknown = JSON.parse(stdin);
    const fields = isObject(input) ? input : {};
    const session = typeof fields.session_id === 'string' ? fields.session_id : fields.conversation_id;
    const roots = Array.isArray(fields.workspace_roots) ? fields.workspace_roots : [];
    const cwd = typeof roots[0] === 'string' ? gitTop(roots[0]) : undefined;
    if (typeof session !== 'string' || !cwd) {
      stderr.push(`recall --agent cursor: ${typeof session !== 'string' ? 'no conversation_id' : 'workspace_roots[0] is in no git work tree'}; nothing shown`);
      return answer([]);
    }
    const parts: string[] = [];
    if (!firstMessage || !shownBefore(store, session)) {
      const index = recall(store, 'cursor', { session_id: session, cwd }, new Date(), heartbeat());
      stderr.push(...(index.stderr ?? []));
      if (index.code !== 0) { stderr.push(...index.lines); return answer([]); }
      parts.push(...index.lines);
    }
    if (firstMessage) {
      const prompt = typeof fields.prompt === 'string' ? fields.prompt : undefined;
      for (const line of firstMessageRecall(store, 'cursor', { session_id: session, cwd, prompt }).lines) {
        const output: unknown = JSON.parse(line);
        if (isObject(output) && isObject(output.hookSpecificOutput) && typeof output.hookSpecificOutput.additionalContext === 'string') {
          parts.push(output.hookSpecificOutput.additionalContext);
        }
      }
    }
    return answer(parts);
  } catch (error) {
    stderr.push(`recall --agent cursor failed: ${error instanceof Error ? error.message : String(error)}; nothing shown`);
    return answer([]);
  }
}

// The entries name sno by absolute path: an IDE started from the macOS desktop may not have ~/.local/bin on PATH.
function snoPath(): string {
  for (const dir of (process.env.PATH ?? '').split(':').filter(part => isAbsolute(part))) {
    try { accessSync(join(dir, 'sno'), constants.X_OK); return join(dir, 'sno'); } catch { /* not in this folder */ }
  }
  throw new Error('recall install: sno is not on PATH, and the Cursor hook entries need its absolute path');
}
const ownEntry = (entry: unknown): boolean =>
  isObject(entry) && typeof entry.command === 'string' && entry.command.includes('rem-reflect recall --agent cursor');

// `sno rem-reflect recall install`: write the two lesson-recall entries into ~/.cursor/hooks.json, replacing an
// earlier copy in place and keeping every entry another program wrote.
export function installCursorHooks(): CommandResult {
  const path = join(homedir(), '.cursor', 'hooks.json');
  const file: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1 };
  if (!isObject(file)) throw new Error(`${path}: expected a JSON object`);
  const hooks = isObject(file.hooks) ? file.hooks : {};
  const sno = snoPath();
  const recallHooks = {
    sessionStart: { command: `'${sno}' rem-reflect recall --agent cursor`, timeout: 15 },
    beforeSubmitPrompt: { command: `'${sno}' rem-reflect recall --agent cursor --first-message`, timeout: 8 },
  };
  for (const [event, entry] of Object.entries(recallHooks)) {
    const list: unknown[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    const at = list.findIndex(ownEntry);
    const kept = list.filter(item => !ownEntry(item));
    kept.splice(at < 0 ? kept.length : at, 0, entry);
    hooks[event] = kept;
  }
  atomicWrite(path, `${JSON.stringify({ ...file, hooks }, null, 2)}\n`);
  return { code: 0, lines: [`wrote the sessionStart and beforeSubmitPrompt lesson-recall hooks to ${path}`] };
}
