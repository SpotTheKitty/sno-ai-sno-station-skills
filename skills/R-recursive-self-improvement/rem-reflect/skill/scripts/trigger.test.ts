import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredRecord, Trace } from './harvest.ts';
import { lessonTrigger, triggerMatchFor } from './trigger.ts';

// A Claude Code session shaped like the real logs: a tool_use block, then the user record carrying its tool_result.
function claude(records: { line: number; record: Record<string, unknown> }[]): Trace {
  const stored: StoredRecord[] = records.map(item => ({ line_number: item.line, source_line: item.line, record: item.record }));
  return { user_id: 'u', project_id: 'p', agent_id: 'claude-code', source_harness: 'claude-code', originator: 'claude-code',
    trace_id: 't.v1', session_id: 't', version: 1, source_path: '/s', source_line_range: [1, records.at(-1)?.line ?? 1],
    source_mtime: 0, records: stored, skipped_records: 0, skipped_blocks: 0, redactions: 0, trivial: false, skills_loaded: [] };
}
const use = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: string, isError: boolean) =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const said = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });

test('a failed test call holding the evidence line gives its command id and the cleaned last error line', () => {
  const trace = claude([
    { line: 3, record: use('t1', 'Bash', { command: 'bun test x.test.ts' }) },
    { line: 4, record: result('t1', " 0 pass\n 1 fail\nerror: Cannot find module './x' from '/work/p/x.test.ts'\n", true) },
  ]);
  // The signature is the excerpt's last non-empty line, without quotes and absolute paths; numbers stay.
  assert.deepEqual(triggerMatchFor(trace, 4), { tool: 'Bash', command_id: 'bun test', error_signature: 'error: Cannot find module ./x from', path_glob: null });
  assert.equal(triggerMatchFor(trace, 2), null, 'a line before the call is in no call');
});

test('a failed edit holding the evidence line gives the file suffix glob and no command id', () => {
  const trace = claude([
    { line: 7, record: use('e1', 'Edit', { file_path: '/work/p/src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' }) },
    { line: 8, record: result('e1', '<tool_use_error>String to replace not found in file.\nString: const a = 1</tool_use_error>', true) },
  ]);
  assert.deepEqual(triggerMatchFor(trace, 8), { tool: 'Edit', command_id: null, error_signature: 'String: const a = 1</tool_use_error>', path_glob: '*.ts' });
});

test('evidence in what the owner said, right after a successful test, is bound to nothing', () => {
  const trace = claude([
    { line: 4, record: use('t2', 'Bash', { command: 'bun test x.test.ts' }) },
    { line: 5, record: result('t2', ' 3 pass\n 0 fail\nRan 3 tests across 1 file.', false) },
    { line: 6, record: said('No, that test does not cover the bug') },
  ]);
  assert.equal(triggerMatchFor(trace, 6), null);
  assert.equal(triggerMatchFor(trace, 5), null, 'a successful call is not a trigger');
  // The producers' step: evidence lines are tried in order, only those of the lesson's own trace, and a missing trace is logged.
  const evidence = [{ trace_id: 't.v1', line_start: 6, line_end: 6, quote: 'No' }, { trace_id: 't.v1', line_start: 5, line_end: 5, quote: 'pass' }];
  const log: string[] = [];
  assert.equal(lessonTrigger(trace, evidence, line => log.push(line)), null);
  assert.equal(log.length, 0);
  assert.equal(lessonTrigger(undefined, evidence, line => log.push(line)), null);
  assert.match(log[0], /trace t\.v1 not in the store/);
});
