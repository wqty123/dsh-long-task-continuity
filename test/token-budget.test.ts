/**
 * 每请求工具定义文本的 token 预算（DS 线格式口径）。
 *
 * 口径来自本机 `D:\deepseek-harness` @ v0.2.1-alpha.1：
 * `packages/llm/llm-deepseek/src/serialize.ts:159-166` 每请求只上行
 * `name / description / parameters`（output schema 不上行、不进模型上下文），
 * 所以"上下文税"就量这 22 个定义里进 JSON 的那部分文本。度量用 `estimateTokens`。
 *
 * 预算一旦要上调，必须在本文件同步改数并注明日期——让每次涨税都是显式动作。
 * 新增工具只许追加到 `PLUGIN_TOOL_NAMES` / `commandToolFactories` 末尾（DS 前缀缓存纪律：
 * 声明列表重排=整段前缀缓存作废），这里的逐名对齐断言会强制两处同步。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_TOOL_NAMES,
  TOOL_TEXT_TOKEN_BUDGET,
  commandToolFactories,
  continuityCheckpointTool,
  continuityHistoryTool,
  continuityStatusTool,
} from '../src/adapter/tools.ts'
import type { ToolDeps } from '../src/adapter/tools.ts'
import { estimateTokens } from '../src/rotation/brief.ts'

const deps = { kernel: {}, identity: async () => undefined, defaultMissionId: () => undefined } as unknown as ToolDeps

const definitions = [
  continuityStatusTool(deps),
  continuityCheckpointTool(deps),
  ...commandToolFactories.map((factory) => factory(deps)),
  continuityHistoryTool(deps),
]

test('注册表与 22 个工具定义一一对应（顺序也一致）', () => {
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    [...PLUGIN_TOOL_NAMES],
  )
})

test(`模型可见的工具定义文本合计不超 ${TOOL_TEXT_TOKEN_BUDGET} tokens`, () => {
  let total = 0
  const rows: string[] = []
  for (const definition of definitions) {
    const text = JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters })
    const tokens = estimateTokens(text)
    total += tokens
    rows.push(`${definition.name}=${tokens}`)
  }
  assert.ok(total <= TOOL_TEXT_TOKEN_BUDGET, `合计 ${total} tokens 超出预算 ${TOOL_TEXT_TOKEN_BUDGET}：${rows.join(' ')}`)
})

test('模型可见文本不残留设计稿引用（§）', () => {
  for (const definition of definitions) {
    const text = JSON.stringify([definition.description, definition.parameters])
    assert.ok(!text.includes('§'), `${definition.name} 的模型面文本仍带 § 引用`)
  }
})
