/**
 * P1-1 的判据：`purpose` 必须有**公开入口**。
 *
 * 复审复现的是"内核要求 `purpose=integration`，但工具和命令都不传它"——
 * 结果是工具报成功、整体审核条件永远满足不了，Mission 收不了口。
 * 这类缺陷单测跑不到（内核逻辑本身是对的），只能钉在"入口是否暴露了那个字段"上。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

test('P1-1：continuity_review 的参数表暴露 purpose，并把它传进 ReviewInput', () => {
  const source = read('../src/adapter/tools.ts')
  assert.match(
    source,
    /purpose: \{ type: 'string', enum: \['dispatch', 'delivery', 'integration'\]/,
    '工具参数表必须有 purpose，否则模型无法产生 integration 审核',
  )
  assert.match(
    source,
    /args\.purpose === undefined \? \{\} : \{ purpose: args\.purpose \}/,
    'build 必须把 purpose 传进 ReviewInput，光声明参数不算接通',
  )
})

test('P1-1：命令面接受同一套用途词表', () => {
  const source = read('../src/index.ts')
  assert.match(source, /const REVIEW_PURPOSES = \['dispatch', 'delivery', 'integration'\]/, '命令面要有词表')
  assert.match(source, /oneOf\(purpose, REVIEW_PURPOSES\)/, '命令面要校验用途取值')
  assert.match(source, /\.\.\.\(purpose !== undefined \? \{ purpose \} : \{\}\)/, '命令面要把 purpose 放进 ReviewInput')
})
