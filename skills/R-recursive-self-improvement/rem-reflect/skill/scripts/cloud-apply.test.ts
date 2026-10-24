import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCloudResponse } from './cloud.ts';
import { verdictCommand } from './adopt.ts';
import { installedCatalogue } from './catalogue.ts';
import { skillRoots } from './config.ts';
import { readLedger } from './ledger.ts';
import { appendRows, readLessons } from './lessons.ts';
import { readPages, writePage } from './pages.ts';
import type { Page } from './pages.ts';
import { writeJson } from './store.ts';
import { fixtureConfig, makeStore, writeInstalledSkill } from './test-helpers.ts';
import { fileURLToPath } from 'node:url';
import type { Trace } from './harvest.ts';

test('a saved cloud answer resumes after a page write without duplicating items or losing judgment ids', () => {
  const config = fixtureConfig();
  const target = writeInstalledSkill(config.claude_home, 'target');
  writeInstalledSkill(config.codex_home, 'target');
  const store = makeStore(config);
  const page: Page = {
    page_id: '20260921-root-cause-1', summary: 'A grounded problem', class: 'SKILL_DEFECT',
    root_cause: { subject: 'skill', relation: 'misses', fact: 'one condition', valid_at: '2026-09-21', evidence_pages: [], evidence_traces: [] },
    fix: 'Add the condition', scenario: { task_type: 'repair', trigger: 'missing condition', tools: [] },
    skills_used: [], skill_target: target, knowledge_used: [], outcome: 'fail', agent_id: 'codex', project_id: 'p',
    user_id: 'local-u', evidence: [], citations: [], counter_examples: 'not searched', superseded: false,
    body: 'Cited page body', count: 2, task_ids: ['a', 'b'], last_seen: '2026-09-21', skills_observed: [],
  };
  const lesson = {
    lesson_id: `L-${page.page_id}`, page_id: page.page_id, status: 'candidate' as const,
    count: 2, helped: 0, harmful: 0, measured: false, created_run: '20260921-0100',
    project_id: 'p', agent_id: 'codex', user_id: 'local-u', skill_target: target,
    scenario: page.scenario, situation: page.scenario, advice: 'Check the missing condition', because: 'The failure recurs',
    applies_to: 'general', polarity: 'from_failure' as const, evidence: [], counter_examples: 'not searched' as const, listed: true,
    verdict_ref: { line: 184, kind: 'test' as const, passed: false },
  };
  const proposal = { kind: 'patch' as const, target: join(target, 'SKILL.md'), region: 'body' as const,
    class: 'SKILL_DEFECT' as const, scenario: page.scenario, skills_used: [], skill_target: target,
    knowledge_used: [], outcome: 'fail' as const,
    purpose: { summary: 'Add the missing condition', page_ids: [page.page_id] },
    ops: [{ op: 'append', text: 'Check the missing condition.\n' }], evidence: [] };
  const response = { schema_version: 1 as const, run_id: '20260921-0100', history_acknowledged: true, history_links: [],
    halves: [{ harness: 'codex', attention: [], pages: [{ judgment_id: 'j-page', page }],
      lessons: [{ judgment_id: 'j-lesson', lesson }], proposals: [{ judgment_id: 'j-proposal', proposal }],
      read_judgments: [{ trace_id: 'read-session.v1', lesson_id: lesson.lesson_id, followed: 'yes', effect: 'helped' }],
      log_entry: 'Grounded learning' }] };

  writeJson(join(store, 'raw', 'codex', 'read-session.v1.json'), {
    trace_id: 'read-session.v1', session_id: 'read-session', version: 1, agent_id: 'codex', user_id: 'local-u',
    source_line_range: [1, 1], records: [],
  });
  appendRows(join(store, 'ledger', 'usage.jsonl'), [{ type: 'read', session_id: 'read-session', lesson_id: lesson.lesson_id }]);

  const prior = { ...page, judgment_id: 'j-page' };
  writePage(store, prior);
  writeJson(join(store, 'staging', response.run_id, 'cloud-request.json'), {
    schema_version: 1, run_id: response.run_id, halves: [], catalogue: installedCatalogue(skillRoots(config)),
    usage_reads: [], outcome_summary: {},
  });
  applyCloudResponse(store, config, response);
  applyCloudResponse(store, config, response);

  assert.equal(readPages(store).length, 1);
  assert.equal((readPages(store)[0] as Page & { judgment_id?: string }).judgment_id, 'j-page');
  assert.deepEqual(readLessons(store).map(row => [row.lesson_id, row.judgment_id]), [[lesson.lesson_id, 'j-lesson']]);
  assert.deepEqual(readLessons(store)[0].verdict_ref, { line: 184, kind: 'test', passed: false }, 'the cloud lesson lands with the verdict it cites');
  assert.equal(readLessons(store)[0].helped, 0, 'a read with no local outcome cannot count as helped');
  const staged = join(store, 'staging', response.run_id, 'codex', 'proposal.json');
  assert.equal(existsSync(staged), true);
  assert.equal(JSON.parse(readFileSync(staged, 'utf8')).judgment_id, 'j-proposal');
  assert.deepEqual(readLedger(store).filter(row => row.type === 'proposal').map(row => row.judgment_id), ['j-proposal']);

  const changed = [config.claude_home, config.codex_home].map(home => join(home, 'skills', 'target', 'SKILL.md'));
  for (const path of changed) writeFileSync(path, readFileSync(path, 'utf8') + 'Owner edit after upload.\n');
  const result = verdictCommand(store, 'accept', `${response.run_id}/codex`);
  assert.equal(result.code, 1, 'the old cloud patch cannot adopt over changed installed copies');
  for (const path of changed) {
    assert.match(readFileSync(path, 'utf8'), /Owner edit after upload\./);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /Check the missing condition\./);
  }
});

test('a superseded cloud page reopens its accepted lesson without deleting the old row', () => {
  const config = fixtureConfig();
  const store = makeStore(config);
  const page: Page = {
    page_id: 'previous-page', summary: 'Old guidance', class: 'SKILL_DEFECT',
    root_cause: { subject: 'skill', relation: 'omits', fact: 'a step', valid_at: '2026-09-21', evidence_pages: [], evidence_traces: [] },
    fix: 'Review the old guidance', scenario: { task_type: 'repair', trigger: 'old result', tools: [] },
    skills_used: [], skill_target: null, knowledge_used: [], outcome: 'fail', agent_id: 'codex', project_id: 'p',
    user_id: 'local-u', evidence: [], citations: [], counter_examples: 'not searched', superseded: true,
    body: 'Old guidance body', count: 2, task_ids: ['a', 'b'], last_seen: '2026-09-21', skills_observed: [],
  };
  appendRows(join(store, 'wiki', 'lessons.jsonl'), [{ lesson_id: 'L-previous-page', page_id: page.page_id,
    status: 'accepted', count: 2, helped: 1, harmful: 0, measured: true,
    situation: page.scenario, advice: 'Use the old step', because: 'It previously worked', applies_to: 'general',
    polarity: 'from_failure', evidence: [], counter_examples: 'not searched', created_run: 'previous-run',
    project_id: 'p', agent_id: 'codex', user_id: 'local-u', skill_target: null, scenario: page.scenario, listed: true }]);
  const runId = '20260921-0200';
  writeJson(join(store, 'staging', runId, 'cloud-request.json'), {
    schema_version: 1, run_id: runId, halves: [], catalogue: [], usage_reads: [], outcome_summary: {},
  });
  const response = { schema_version: 1 as const, run_id: runId, history_acknowledged: true, history_links: [],
    halves: [{ harness: 'codex', attention: [], pages: [{ judgment_id: 'j-superseded', page }],
      lessons: [], proposals: [], read_judgments: [], log_entry: 'The previous advice is superseded' }] };

  applyCloudResponse(store, config, response);
  applyCloudResponse(store, config, response);

  const rows = readFileSync(join(store, 'wiki', 'lessons.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.filter(row => row.lesson_id === 'L-previous-page').map(row => row.status), ['accepted', 'under_review']);
  assert.equal(readLessons(store)[0].status, 'under_review');

  appendRows(join(store, 'wiki', 'lessons.jsonl'), [{ ...readLessons(store)[0], status: 'accepted' }]);
  applyCloudResponse(store, config, response);
  assert.equal(readLessons(store)[0].status, 'accepted', 'replaying the same superseded page does not undo a re-accept');
});

test('replaying an older version of a page after a newer one leaves the newer page and its accepted lesson alone', () => {
  const config = fixtureConfig();
  const store = makeStore(config);
  const base: Page = {
    page_id: 'versioned-page', summary: 'Guidance', class: 'SKILL_DEFECT',
    root_cause: { subject: 'skill', relation: 'omits', fact: 'a step', valid_at: '2026-09-21', evidence_pages: [], evidence_traces: [] },
    fix: 'Follow the guidance', scenario: { task_type: 'repair', trigger: 'result', tools: [] },
    skills_used: [], skill_target: null, knowledge_used: [], outcome: 'fail', agent_id: 'codex', project_id: 'p',
    user_id: 'local-u', evidence: [], citations: [], counter_examples: 'not searched', superseded: false,
    body: 'Newer body', count: 2, task_ids: ['a', 'b'], last_seen: '2026-09-22', skills_observed: [],
  };
  writePage(store, { ...base, judgment_id: '01a0cb00-0000-7000-8000-000000000002' } as Page);
  appendRows(join(store, 'wiki', 'lessons.jsonl'), [{ lesson_id: 'L-versioned-page', page_id: base.page_id,
    status: 'accepted', count: 2, helped: 0, harmful: 0, measured: false, situation: base.scenario, advice: 'Follow it',
    because: 'It works', applies_to: 'project:p', polarity: 'from_failure', evidence: [], counter_examples: 'not searched',
    created_run: 'r', project_id: 'p', agent_id: 'codex', user_id: 'local-u', skill_target: null, scenario: base.scenario,
    listed: true, judgment_id: '01a0cb00-0000-7000-8000-000000000012' }]);
  const runId = '20260921-0300';
  writeJson(join(store, 'staging', runId, 'cloud-request.json'), {
    schema_version: 1, run_id: runId, halves: [], catalogue: [], usage_reads: [], outcome_summary: {},
  });
  const older = { schema_version: 1 as const, run_id: runId, history_acknowledged: true, history_links: [],
    halves: [{ harness: 'codex', attention: [], lessons: [], proposals: [], read_judgments: [], log_entry: 'older',
      pages: [{ judgment_id: '01a0cb00-0000-7000-8000-000000000001', page: { ...base, body: 'Older body', superseded: true } }] }] };
  applyCloudResponse(store, config, older);
  assert.equal(readPages(store)[0].body, 'Newer body');
  assert.equal(readLessons(store)[0].status, 'accepted');
});

test('a proposal this machine refuses is logged and skipped while the rest of the response still applies', () => {
  const config = fixtureConfig();
  const store = makeStore(config);
  const runId = '20260926-0100';
  const lesson = {
    lesson_id: 'L-after-refusal', page_id: 'pg-after-refusal', status: 'candidate' as const, count: 1, helped: 0, harmful: 0,
    measured: false, created_run: runId, project_id: 'p', agent_id: 'codex', user_id: 'local-u', skill_target: null,
    scenario: { task_type: 'batch', trigger: 'duplicate keys', tools: [] }, situation: { task_type: 'batch', trigger: 'duplicate keys', tools: [] },
    advice: 'Check key uniqueness first', because: 'Duplicates broke the batch', applies_to: 'general', polarity: 'from_failure' as const,
    evidence: [], counter_examples: 'not searched' as const, listed: true,
  };
  const refused = { kind: 'patch' as const, target: '/nowhere/ghost-skill/SKILL.md', region: 'body' as const,
    purpose: { summary: 'Patch a skill this machine does not have', page_ids: ['pg-missing'] },
    ops: [{ op: 'append', text: 'Never shipped.\n' }] };
  const response = { schema_version: 1 as const, run_id: runId, history_acknowledged: true, history_links: [],
    halves: [
      { harness: 'claude-code', attention: [], pages: [], lessons: [], proposals: [{ judgment_id: 'j-refused', proposal: refused }],
        read_judgments: [], log_entry: 'refused half' },
      { harness: 'codex', attention: [], pages: [], lessons: [{ judgment_id: 'j-after', lesson }], proposals: [],
        read_judgments: [], log_entry: 'later half' },
    ] };
  writeJson(join(store, 'staging', runId, 'cloud-request.json'), {
    schema_version: 1, run_id: runId, halves: [], catalogue: [], usage_reads: [], usage_shown: [], outcome_summary: {} });
  applyCloudResponse(store, config, response as never);
  assert.equal(readLessons(store).find(row => row.lesson_id === 'L-after-refusal')?.status, 'candidate');
  assert.equal(readLedger(store).some(row => row.type === 'proposal'), false);
  assert.match(readFileSync(join(store, 'staging', runId, 'run.log'), 'utf8'),
    /^proposal refused: run 20260926-0100 half claude-code target \/nowhere\/ghost-skill: /m);
});

test('a judgment on a lesson the session was shown at start, never read in full, is kept with its basis and counted', () => {
  const config = fixtureConfig();
  const store = makeStore(config);
  const runId = '20261022-0100';
  const situation = { task_type: 'fix', trigger: 'broken build', tools: [] };
  appendRows(join(store, 'wiki', 'lessons.jsonl'), [{ lesson_id: 'L-shown', page_id: 'pg-shown', status: 'accepted', count: 1,
    helped: 0, harmful: 0, measured: false, created_run: 'r', project_id: 'p', agent_id: 'codex', user_id: 'local-u', skill_target: null,
    scenario: situation, situation, advice: 'read the compiler error', because: 'it names the line', applies_to: 'general',
    polarity: 'from_failure', evidence: [], counter_examples: 'not searched', listed: true }]);
  writeJson(join(store, 'raw', 'codex', 'shown-session.v1.json'), {
    trace_id: 'shown-session.v1', session_id: 'shown-session', version: 1, agent_id: 'codex', user_id: 'local-u',
    source_line_range: [1, 1], records: [],
  });
  writeJson(join(store, 'raw', 'codex', 'shown-session.v1.label.json'), { decision: 'keep', outcome: 'success', reason: 'built',
    evidence: [], key_ranges: [], labeled_by: 'codex', model: 'm' });
  appendRows(join(store, 'ledger', 'usage.jsonl'), [{ type: 'shown', session_id: 'shown-session', lesson_ids: ['L-shown'] }]);
  writeJson(join(store, 'staging', runId, 'cloud-request.json'), {
    schema_version: 1, run_id: runId, halves: [], catalogue: [], usage_reads: [], usage_shown: [], outcome_summary: {} });
  const judgment = (lessonId: string) => ({ schema_version: 1 as const, run_id: runId, history_acknowledged: true, history_links: [],
    halves: [{ harness: 'codex', attention: [], pages: [], lessons: [], proposals: [], log_entry: 'judged',
      read_judgments: [{ trace_id: 'shown-session.v1', lesson_id: lessonId, followed: 'yes', effect: 'helped', basis: 'shown' }] }] });
  applyCloudResponse(store, config, judgment('L-shown'));
  assert.deepEqual(readLedger(store).filter(row => row.type === 'lesson-judgment').map(row => [row.lesson_id, row.basis, row.run_id]),
    [['L-shown', 'shown', runId]]);
  assert.deepEqual(readLessons(store).map(row => [row.helped, row.measured]), [[1, true]]);
  // A judgment on a lesson this session neither saw nor read is still refused.
  assert.throws(() => applyCloudResponse(store, config, judgment('L-never')), /no lesson shown or read/);
});

test('a cloud lesson whose evidence sits in a failed call lands with the trigger condition code computes from the raw trace', () => {
  const config = fixtureConfig();
  const store = makeStore(config);
  const runId = '20261022-0200';
  // The real Codex session (redacted) whose `uv run python -m pytest …` failed at line 710 and passed at 720.
  const fixtures = JSON.parse(readFileSync(fileURLToPath(new URL('./selftest/fixtures/verdict-traces.json', import.meta.url)), 'utf8')) as Record<string, Trace>;
  const trace = fixtures.codex_pytest;
  writeJson(join(store, 'raw', 'codex', `${trace.trace_id}.json`), trace);
  const situation = { task_type: 'fix', trigger: 'a pytest run fails on a self-referencing edge', tools: [] };
  const lessonRow = (id: string, line: number) => ({ lesson_id: id, page_id: `pg-${id}`, status: 'candidate', count: 1, helped: 0, harmful: 0,
    measured: false, created_run: runId, project_id: trace.project_id, agent_id: 'codex', user_id: trace.user_id, skill_target: null,
    scenario: situation, situation, advice: 'Resolve self references before extracting edges', because: 'the test failed on them', applies_to: 'general',
    polarity: 'from_failure', evidence: [{ trace_id: trace.trace_id, line_start: line, line_end: line, quote: 'pytest' }], counter_examples: 'not searched', listed: true });
  writeJson(join(store, 'staging', runId, 'cloud-request.json'), {
    schema_version: 1, run_id: runId, halves: [], catalogue: [], usage_reads: [], usage_shown: [], outcome_summary: {} });
  applyCloudResponse(store, config, { schema_version: 1, run_id: runId, history_acknowledged: true, history_links: [],
    halves: [{ harness: 'codex', attention: [], pages: [], proposals: [], read_judgments: [], log_entry: 'two lessons',
      lessons: [{ judgment_id: 'j-failed', lesson: lessonRow('L-failed', 710) }, { judgment_id: 'j-passed', lesson: lessonRow('L-passed', 720) }] }] } as never);
  const landed = new Map(readLessons(store).map(row => [row.lesson_id, row.trigger_match]));
  // The signature is the last non-empty line of the stored error excerpt: pytest's own summary, counts kept.
  assert.deepEqual(landed.get('L-failed'), { tool: 'shell', command_id: 'pytest', error_signature: '2 passed, 2 errors in 0.66s', path_glob: null });
  assert.equal(landed.get('L-passed'), null, 'evidence inside the passing run binds to nothing');
});
