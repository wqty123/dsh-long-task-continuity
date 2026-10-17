/**
 * 纪律视图（编队界面的「纪律」与「注入确认」两块面板的数据面）。
 *
 * 三件事刻意分开，因为它们的可信度不同：
 * 1. **源**：磁盘上那份文件的实际内容、字节数与 sha256 —— 可核对，不是插件里另存的副本。
 * 2. **机制**：这份文件靠什么进入上下文（`dsh-agent-instructions` 的 session baseline）。
 * 3. **证据**：每类身份到底确认过没有。确认过的标"实测"，没确认的标"同路径未单独实测"，
 *    不把推断写成事实。
 *
 * 纪律是**部署环境的事实**，不属于 Mission 状态，所以不塞进台账。
 */
import { createHash } from 'node:crypto'

export const DISCIPLINE_PATH = '/api/continuity.discipline'

export type DisciplineIdentityId = 'leader' | 'member' | 'subagent'

export interface DisciplineIdentityRow {
  readonly id: DisciplineIdentityId
  readonly label: string
  /** 三类身份共用同一份文件；差别只在"进来的是哪个 session"。 */
  readonly source: string
  readonly mechanism: string
  /** `measured` = 有实证；`inferred` = 同一条链路但没单独验过。 */
  readonly evidence: 'measured' | 'inferred'
  readonly evidenceNote: string
}

export interface DisciplineSection {
  readonly title: string
  readonly lines: readonly string[]
}

export interface DisciplineView {
  readonly generatedAt: number
  readonly sourcePath: string
  readonly present: boolean
  readonly bytes: number
  readonly sha256: string
  readonly modifiedAt: string
  readonly text: string
  readonly sections: readonly DisciplineSection[]
  readonly identities: readonly DisciplineIdentityRow[]
  readonly mechanism: string
  readonly notes: readonly string[]
}

/** 把 markdown 按二级标题切成小节；第一条 `#` 标题当作整体标题，不单列。 */
export function splitSections(text: string): DisciplineSection[] {
  const sections: DisciplineSection[] = []
  let current: DisciplineSection | undefined
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      current = { title: line.slice(3).trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (current === undefined) continue
    if (line.trim().length === 0) continue
    ;(current.lines as string[]).push(line)
  }
  return sections
}

/**
 * 三类身份的注入口径。
 *
 * 事实依据（DSH 侧）：`dsh-agent-instructions` 在**每个 session** 首次请求前把
 * `$DSH_HOME/AGENTS.md` 作为 baseline 消息写进 durable context。leader、成员
 * （`spawn_teammate` 起的是独立 session）、子代理都各自是 session，所以拿到的是**同一份**。
 */
export function disciplineIdentities(): DisciplineIdentityRow[] {
  return [
    {
      id: 'leader',
      label: 'Leader',
      source: '$DSH_HOME/AGENTS.md',
      mechanism: '当前会话的 baseline 消息（agent-instructions）',
      evidence: 'measured',
      evidenceNote: '本会话上下文中可见，标题与工作包条目一致',
    },
    {
      id: 'member',
      label: '成员',
      source: '$DSH_HOME/AGENTS.md',
      mechanism: '成员是独立 session（spawn_teammate），启动时走同一条 baseline',
      evidence: 'inferred',
      evidenceNote: '与子代理同一条链路；本轮没有单独起成员验过',
    },
    {
      id: 'subagent',
      label: '子代理',
      source: '$DSH_HOME/AGENTS.md',
      mechanism: '子代理同样是独立 session，走同一条 baseline',
      evidence: 'measured',
      evidenceNote: '已实测：子代理原样回引本文件标题与「派单按工作包」条目',
    },
  ]
}

/** `readSource` 由装配层注入：返回磁盘上的原文与 mtime，或 undefined 表示文件不存在。 */
export function disciplineView(
  sourcePath: string,
  readSource: () => { readonly text: string; readonly modifiedAt: string } | undefined,
): DisciplineView {
  const facts = readSource()
  const text = facts?.text ?? ''
  return {
    generatedAt: Date.now(),
    sourcePath,
    present: facts !== undefined,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: text.length === 0 ? '' : createHash('sha256').update(text, 'utf8').digest('hex'),
    modifiedAt: facts?.modifiedAt ?? '',
    text,
    sections: splitSections(text),
    identities: disciplineIdentities(),
    mechanism: 'dsh-agent-instructions 在建会话首个请求前，把 $DSH_HOME/AGENTS.md 作为 baseline 消息写进 durable context；主 agent、成员、子代理各是独立 session，因此各自都会拿到。',
    notes: [
      '面板显示的是磁盘原文与指纹，不是插件内副本，避免两边漂移。',
      '改这份文件后，**新会话**生效；已在跑的会话沿用其 baseline，需要下一轮或新会话才更新。',
      '纪律只有一份：三类身份共用，差别只在哪个 session 加载它。',
    ],
  }
}
