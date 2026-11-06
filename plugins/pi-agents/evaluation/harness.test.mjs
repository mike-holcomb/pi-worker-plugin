import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const harness = join(here, 'harness.mjs');
const manifest = join(here, 'v2-cases.json');
const packetSchema = join(here, '..', 'schemas', 'task-packet.schema.json');

function malformedPacket(mutator) {
  const root = mkdtempSync(join(tmpdir(), 'v2-evaluation-packet-'));
  const evaluation = join(root, 'evaluation');
  const schemas = join(root, 'schemas');
  try {
    mkdirSync(evaluation);
    mkdirSync(schemas);
    cpSync(harness, join(evaluation, 'harness.mjs'));
    cpSync(packetSchema, join(schemas, 'task-packet.schema.json'));
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    mutator(data.cases[0].packet);
    writeFileSync(join(evaluation, 'v2-cases.json'), JSON.stringify(data));
    return spawnSync(process.execPath, [join(evaluation, 'harness.mjs'), 'validate'], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('all frozen v2 packets satisfy the bundled TaskPacket schema', () => {
  const result = spawnSync(process.execPath, [harness, 'validate'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"scenario_count": 14/);
  assert.match(result.stdout, /"packet_schema_sha256": "[a-f0-9]{64}"/);
});

test('rejects missing required packet sections', () => {
  const result = malformedPacket(packet => { delete packet.shared_resources; });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /packet\.shared_resources is required/);
});

test('rejects malformed nested packet fields', () => {
  const result = malformedPacket(packet => { packet.context.verified_facts = 'not an array'; });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /packet\.context\.verified_facts must be an array/);
});

test('rejects unknown nested packet fields', () => {
  const result = malformedPacket(packet => { packet.context.unverified_fact = 'extra'; });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /packet\.context\.unverified_fact is not allowed/);
});

test('rejects incorrect nested primitive types', () => {
  const result = malformedPacket(packet => { packet.acceptance_criteria[0].required = 'true'; });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /packet\.acceptance_criteria\[0\]\.required must be a boolean/);
});


function trialAudit(caseId, summary) {
  const root = mkdtempSync(join(tmpdir(), 'v2-evaluation-audit-'));
  try {
    const workdir = join(root, 'work'), state = join(root, 'baseline.json'), resultFile = join(root, 'summary.md');
    const prepared = spawnSync(process.execPath, [harness, 'prepare', '--case', caseId, '--run-id', 'audit-test', '--out', workdir, '--state', state], { encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stderr);
    writeFileSync(resultFile, summary);
    const sha256 = createHash('sha256').update(summary).digest('hex');
    return spawnSync(process.execPath, [harness, 'check', '--case', caseId, '--workdir', workdir, '--state', state, '--result-file', resultFile, '--result-sha256', sha256], { encoding: 'utf8' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('paired audits retain distinct coverage review despite passing partial-report observations', () => {
  const summary = 'Inspected README.md and metadata.json; sampled plugin documents; remaining files not-inspected. Coverage is partial; parent review needed.';
  for (const caseId of ['audit-sampled', 'audit-complete']) {
    const checked = trialAudit(caseId, summary);
    assert.equal(checked.status, 2, checked.stderr);
    const result = JSON.parse(checked.stdout);
    assert.equal(result.status, 'review_required');
    for (const id of ['truthful-limits-review', 'grounding-review', 'discovery-review', 'coverage-review'])
      assert.equal(result.checks.find(item => item.id === id).status, 'review_required');
    const coverage = result.checks.find(item => item.id === 'coverage-review').detail;
    assert.match(coverage, caseId === 'audit-complete' ? /Missing or merely sampled required sources/ : /Sampling is permitted/);
  }
});

test('unsupported exhaustive claims cannot bypass original-source and coverage review', () => {
  const checked = trialAudit('audit-complete', 'Inspected every file completely. README.md. No contradictions exist. Complete coverage.');
  assert.equal(checked.status, 2, checked.stderr);
  const result = JSON.parse(checked.stdout);
  assert.equal(result.parent_review_required, true);
  assert.match(result.checks.find(item => item.id === 'discovery-review').detail, /seeded contradictions/);
  assert.match(result.checks.find(item => item.id === 'coverage-review').detail, /do not accept exhaustive coverage/);
});
