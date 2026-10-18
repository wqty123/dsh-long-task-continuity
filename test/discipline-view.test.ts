/**
 * 纪律视图的判据（编队界面的两块面板）。
 *
 * 这三条对应面板最容易说谎的三个地方：切节切错、文件缺失却显示内容、
 * 把"同一条链路"写成"已实测"。面板是给人核对的，判据就得钉在这些点上。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createHash } from 'node:crypto'

import { DISCIPLINE_PATH, disciplineBackupName, disciplineIdentities, disciplineView, splitSections, validateDisciplineWrite } from '../src/views/discipline.ts'

test('纪律视图：按二级标题切小节，忽略空行与一级标题', () => {
  const sections = splitSections('# 总标题\n\n## 甲\n- 一\n\n- 二\n\n## 乙\n内容')
  assert.deepEqual(sections.map((item) => item.title), ['甲', '乙'])
  assert.deepEqual(sections[0]?.lines, ['- 一', '- 二'])
  assert.deepEqual(sections[1]?.lines, ['内容'])
})

test('纪律视图：源缺失时如实报缺失，不回落成任何内容', () => {
  const view = disciplineView('X/AGENTS.md', () => undefined)
  assert.equal(view.present, false)
  assert.equal(view.text, '')
  assert.equal(view.bytes, 0)
  assert.equal(view.sha256, '')
  assert.deepEqual(view.sections, [])
  assert.equal(view.identities.length, 3, '缺失时身份口径仍要列出来')
})

test('纪律视图：指纹随内容变化，长度固定 64', () => {
  const a = disciplineView('X/AGENTS.md', () => ({ text: '甲', modifiedAt: 't' }))
  const b = disciplineView('X/AGENTS.md', () => ({ text: '乙', modifiedAt: 't' }))
  assert.notEqual(a.sha256, b.sha256)
  assert.equal(a.sha256.length, 64)
  assert.equal(a.present, true)
})

test('纪律视图：三类身份共用同一份源，证据分实测与推断两档', () => {
  const rows = disciplineIdentities()
  assert.deepEqual(rows.map((row) => row.id), ['leader', 'member', 'subagent'])
  assert.ok(rows.every((row) => row.source === '$DSH_HOME/AGENTS.md'), '三类身份必须指向同一份文件')
  assert.deepEqual(rows.map((row) => row.evidence), ['measured', 'inferred', 'measured'])
  assert.equal(DISCIPLINE_PATH, '/api/continuity.discipline')
})
/* ---------------------------------------------------------------- 写回闸门 */

const shaOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

test('纪律写回：sha256 匹配时放行并回传新文本', () => {
  const current = { text: '# 甲\n- 一' }
  const outcome = validateDisciplineWrite(current, { text: '# 乙\n- 二', expectedSha256: shaOf(current.text) })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.text, '# 乙\n- 二')
})

test('纪律写回：sha256 不匹配时拒绝（防并发覆盖）', () => {
  const outcome = validateDisciplineWrite({ text: '# 当前' }, { text: '# 新的', expectedSha256: shaOf('# 别的版本') })
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.match(outcome.reason, /已被改动/)
})

test('纪律写回：缺少 expectedSha256 时拒绝', () => {
  const outcome = validateDisciplineWrite({ text: 'x' }, { text: 'y' })
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.match(outcome.reason, /expectedSha256/)
})

test('纪律写回：不许把纪律写成空', () => {
  const outcome = validateDisciplineWrite({ text: 'x' }, { text: '   \n  ', expectedSha256: shaOf('x') })
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.match(outcome.reason, /不能写成空/)
})

test('纪律写回：当前文件读不到时拒绝（不许凭空造一份）', () => {
  const outcome = validateDisciplineWrite(undefined, { text: 'y', expectedSha256: shaOf('x') })
  assert.equal(outcome.ok, false)
})

test('备份名按时间戳可排序', () => {
  assert.equal(disciplineBackupName(new Date('2026-10-18T20:05:06')), 'AGENTS.20261018-200506.md')
})
