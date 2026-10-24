import { readCalls } from './calls.ts';
import type { CallRecord } from './calls.ts';
import type { Evidence } from './evidence.ts';
import type { Trace } from './harvest.ts';
import { commandId, commandWord, segments } from './verdicts.ts';

// The matchable condition a lesson is bound to: the failed call whose line range holds one of its evidence
// lines. Code computes it at landing; the model never names it. Evidence inside a successful call, or in
// what people said, gives null and the lesson stays on the session-start list.
export interface TriggerMatch { tool: string; command_id: string | null; error_signature: string | null; path_glob: string | null }

// The excerpt is the tail of the output, so its last non-empty line is the one line sure to be whole.
function errorSignature(excerpt: string | null): string | null {
  const last = (excerpt ?? '').split('\n').findLast(line => line.trim()) ?? '';
  const cleaned = last.replace(/["'`]/g, '').replace(/\b[0-9a-f]{7,}\b/g, '').replace(/(?<![^\s(=:,])\/\S+/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || null;
}

export function triggerMatch(call: CallRecord): TriggerMatch {
  const text = call.command_text;
  const edit = ['Edit', 'Write', 'edit'].includes(call.tool) ? /\.([A-Za-z0-9]+)$/.exec(call.target ?? '')?.[1] : undefined;
  return {
    tool: call.tool,
    command_id: text === null ? null : commandId(text) ?? segments(text).map(commandWord).find(word => word !== null) ?? null,
    error_signature: errorSignature(call.error_excerpt),
    path_glob: edit ? `*.${edit}` : null,
  };
}

export function triggerMatchFor(trace: Trace, line: number): TriggerMatch | null {
  const call = readCalls(trace).find(item => item.failed && item.line_start <= line && line <= item.line_end);
  return call ? triggerMatch(call) : null;
}

// The producers' shared step: the first evidence line of the lesson that falls inside a failed call of its trace.
export function lessonTrigger(trace: Trace | undefined, evidence: readonly Evidence[], log: (line: string) => void): TriggerMatch | null {
  const id = evidence[0]?.trace_id;
  if (!trace) { log(`trigger match: trace ${String(id)} not in the store; lesson lands without one`); return null; }
  try {
    for (const item of evidence) {
      if (item.trace_id !== trace.trace_id) continue;
      const match = triggerMatchFor(trace, item.line_start);
      if (match) return match;
    }
    return null;
  } catch (error) {
    log(`trigger match: ${trace.trace_id}: ${String(error)}; lesson lands without one`);
    return null;
  }
}
