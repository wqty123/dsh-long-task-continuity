// 装载前的自检夹具：在本目录（或本目录的一份副本）里生成 @deepseek-ai/* 的**类型与运行时存根**，
// 让 `tsc` 和 `harness.mjs` 都能在不安装真 peer、不把本包接进 DSH 的前提下跑起来。
//
// 存根刻意宽松（`any` / 可链式 Proxy）：宿主真实类型属于装载阶段用 peerDependencies 校验的范围
// （README 第 4 节第 1 步），这里只保证本包内部一致。
//
// 用法（推荐在临时副本里跑，避免把存根 node_modules 留在交付目录）：
//   cp -r "<本包>" /tmp/ltc-rig && cd /tmp/ltc-rig
//   node make-rig.mjs                       # 默认从 D:/deepseek-harness 借 @types/node
//   DSH_REPO=D:/other/path node make-rig.mjs
//   node /d/deepseek-harness/node_modules/typescript/bin/tsc -p tsconfig.check.json
//   node /d/deepseek-harness/node_modules/typescript/bin/tsc -p tsconfig.check-all.json
//   node harness.mjs
import { mkdirSync, writeFileSync } from 'node:fs'

const repo = (process.env.DSH_REPO ?? 'D:/deepseek-harness').replace(/\\/gu, '/')

const stubs = {
  // 只有类型面被用到：`Context` 在本包全部是 `import type`，运行时不需要 index.js。
  '@deepseek-ai/cordis': {
    types: 'export interface Context { [key: string]: any }\n',
    runtime: null,
  },
  '@deepseek-ai/dsh-llm': {
    types: 'export declare function createUserMessage(init: any): any\n',
    runtime: "export const createUserMessage = (init) => ({ role: 'user', ...init })\n",
  },
  // `domainTable` 必须保留两个类型参数：`src/index.ts` 以 `domainTable<string, MissionControl>(envelope)` 调用。
  '@deepseek-ai/dsh-storage-domain': {
    types: 'export declare function defineDomain(def: any): any\nexport declare function domainTable<K extends string, V>(schema: any): { readonly keyType: K; readonly valueType: V }\n',
    runtime: 'export const defineDomain = (spec) => spec\nexport const domainTable = (schema) => ({ schema })\n',
  },
  // `ToolDefinition` 这一层是必要的：没有它，`defineTool({ execute: (args, value) => ... })`
  // 的回调参数就没有上下文类型，strict 下会报 TS7006。
  '@deepseek-ai/dsh-tools': {
    types:
      'interface ToolDefinition { readonly name: string; readonly description?: string; readonly parameters?: any; ' +
      'readonly output?: { readonly schema?: any; readonly render?: (...args: any[]) => any }; ' +
      'readonly isConcurrencySafe?: () => boolean; readonly execute?: (...args: any[]) => any }\n' +
      'declare function defineTool(def: ToolDefinition): any\nexport { defineTool }\n',
    runtime: 'export const defineTool = (definition) => definition\n',
  },
  '@deepseek-ai/schemastery': {
    types: 'declare const Schema: any\nexport default Schema\n',
    runtime:
      'const chain = () => new Proxy(function () {}, { get: () => chain, apply: () => chain() })\n' +
      'export default { object: (shape) => shape, boolean: chain, number: chain, string: chain }\n',
  },
  zod: {
    types: 'export declare const z: any\n',
    runtime:
      "export const z = { object: () => ({ passthrough: () => ({ __stub: 'envelope' }) }), " +
      "number: () => ({ int: () => ({ positive: () => ({}), nonnegative: () => ({}) }) }), string: () => ({ min: () => ({}) }) }\n",
  },
}

for (const [pkg, body] of Object.entries(stubs)) {
  const dir = `node_modules/${pkg}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/index.d.ts`, body.types)
  if (body.runtime !== null) writeFileSync(`${dir}/index.js`, body.runtime)
  writeFileSync(`${dir}/package.json`, `${JSON.stringify({ name: pkg, version: '0.0.0', type: 'module', main: './index.js', exports: { '.': { types: './index.d.ts', default: './index.js' } } })}\n`)
}

const compilerOptions = {
  lib: ['es2023'],
  module: 'nodenext',
  moduleResolution: 'nodenext',
  target: 'es2022',
  strict: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  noImplicitReturns: true,
  verbatimModuleSyntax: true,
  erasableSyntaxOnly: true,
  isolatedModules: true,
  skipLibCheck: true,
  noEmit: true,
  typeRoots: [`${repo}/node_modules/@types`],
  types: ['node'],
  allowImportingTsExtensions: true,
}

writeFileSync('tsconfig.check.json', `${JSON.stringify({ compilerOptions, include: ['src/**/*.ts', 'vendor/**/*.ts'] }, null, 2)}\n`)
writeFileSync('tsconfig.check-all.json', `${JSON.stringify({ compilerOptions, include: ['src/**/*.ts', 'vendor/**/*.ts', 'test/**/*.ts'] }, null, 2)}\n`)

console.log(`夹具就绪：${Object.keys(stubs).length} 个存根包，typeRoots=${repo}/node_modules/@types`)
