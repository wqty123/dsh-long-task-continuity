/**
 * 纪律视图的判据（编队界面的两块面板）。
 *
 * 这三条对应面板最容易说谎的三个地方：切节切错、文件缺失却显示内容、
 * 把"同一条链路"写成"已实测"。面板是给人核对的，判据就得钉在这些点上。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DISCIPLINE_PATH, disciplineIdentities, disciplineView, splitSections } from '../src/views/discipline.ts'

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
