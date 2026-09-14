import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../desktop/demo/demo.js', import.meta.url), 'utf8');
const start = source.indexOf('function archiveStatusLabel(record) {');
const end = source.indexOf('\nfunction text(', start);
assert.ok(start >= 0 && end > start);
const label = runInNewContext(`${source.slice(start, end)}\narchiveStatusLabel`);
test('archive labels distinguish approval, submission and verification without changing records', () => {
  const cases = [
    ['AWAITING_APPROVAL', null, '等待明确确认'], ['AWAITING_APPROVAL', { planId: 'old' }, '已确认，尚未执行'],
    ['SUBMITTED', {}, '已提交，等待回读核对'], ['VERIFIED', {}, '模拟回读一致'],
    ['UNKNOWN', {}, '结果未知，不能判断成功'], ['PARTIALLY_VERIFIED', {}, '仅部分目标核对一致'],
    ['VERIFYING', {}, '正在核对，尚无结论'], ['EXECUTING', {}, '执行中，结果未确认'],
    ['NOT_CHECKED', null, '尚未检查'], ['MISSING_DATA', null, '缺少数据'],
    ['READY', null, '已诊断，待预览'], ['FAILED', {}, '未通过核对'], ['ROLLED_BACK', {}, '已核实回滚']
  ];
  for (const [status, approval, expected] of cases) {
    const record = { task: { status, approval } }, before = structuredClone(record);
    assert.equal(label(record), `${expected}（${status}）`);
    assert.deepEqual(record, before);
  }
});
test('legacy and unknown status labels never invent verification', () => {
  assert.equal(label({}), '尚未检查');
  assert.equal(label({ action: { statusLabel: '等待回读' } }), '等待回读');
  assert.equal(label({ task: { status: 'NEW_STATE' } }), '未识别状态，请保留记录（NEW_STATE）');
  assert.equal(label({ task: { status: 'toString' } }), '未识别状态，请保留记录（toString）');
});
