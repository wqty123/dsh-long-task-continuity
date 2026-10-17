/**
 * R1 · 成员创建只允许由 Lead 发起。
 *
 * 判据覆盖五个分支：非目标工具放行、会话未知拒、未入台账拒、非 Lead 身份拒、Lead 放行。
 * 这条约束是"成员与 Lead 权限相同、唯一差别只有创建成员"这句话唯一的机制落点，
 * 所以五个分支都要钉住——尤其是"非目标工具放行"，否则它会误伤所有别的工具调用。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { memberCreationGuard } from '../src/adapter/dsh.ts'

const guard = memberCreationGuard(
  (sessionId) => {
    if (sessionId === 'sess-lead') return { role: 'lead' }
    if (sessionId === 'sess-member') return { role: 'member' }
    if (sessionId === 'sess-reviewer') return { role: 'reviewer' }
    return undefined
  },
  (agent) => (agent as { id?: unknown } | undefined)?.id as string | undefined,
)

test('R1 非目标工具一律放行（否则会误伤全部工具调用）', () => {
  assert.equal(guard({ name: 'read', agent: { id: 'sess-member' } }), undefined)
  assert.equal(guard({ name: 'spawn_teammate_extra', agent: { id: 'sess-member' } }), undefined)
  assert.equal(guard({ name: 'bash', agent: { id: 'sess-stranger' } }), undefined)
  assert.equal(guard({}), undefined)
})

test('R1 调用者会话未知 → 放行（归属不可判定，交给宿主）', () => {
  assert.equal(guard({ name: 'spawn_teammate' }), undefined)
})

test('R1 未纳管的会话 → 放行（不把原生 Team 前提扩大成"必须先纳管"）', () => {
  assert.equal(guard({ name: 'spawn_teammate', agent: { id: 'sess-stranger' } }), undefined)
})

test('R1 已入台账但不是 Lead → 拒', () => {
  for (const id of ['sess-member', 'sess-reviewer']) {
    const reason = guard({ name: 'spawn_teammate', agent: { id } })
    assert.ok(reason !== undefined && reason.includes('只有 Lead'), `${id}: ${String(reason)}`)
  }
})

test('R1 Lead 放行', () => {
  assert.equal(guard({ name: 'spawn_teammate', agent: { id: 'sess-lead' } }), undefined)
})
