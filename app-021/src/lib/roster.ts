import type { Special, Vision } from '../types'

// 批量粘贴名单的解析：从教务表粘来的文本 → 逐行结构化结果。
// 纯函数，不依赖 UI，方便单测（tests/roster.test.ts）。

// 姓名规范化：去掉所有空白字符（含全角空格 U+3000、不间断空格 U+00A0）。
// 教务表粘来的名字常带「张 三」「张　三」这类空格，应视为同一个人。
export function normalizeName(name: string): string {
  return name.replace(/[\s\u3000\u00a0]+/g, '')
}

export interface RosterLine {
  lineNo: number // 原文中的行号（从 1 开始，空行也占号，便于对照原文）
  raw: string // 原始行文本
  name: string // 规范化后的姓名（'' = 没读到姓名）
  heightCm?: number
  vision: Vision
  special: Special[]
  note?: string // 未识别为约束、保留下来的备注
  recognized: string[] // 已识别为结构化约束的要求（展示用）
  noteOnly: string[] // 备注里疑似座位要求、但没能识别的原文（只留了备注）
  status: 'ok' | 'warn' | 'skip' // ok=直接入名单；warn=入名单但要注意；skip=不入名单
  messages: string[] // 逐行说明（为什么跳过 / 要注意什么）
}

interface ReqDraft {
  vision: Vision
  special: Special[]
}

// 备注里的座位要求 → 结构化字段。一条短句可命中多条（如「近视，听力也不好」）。
const REQUIREMENT_RULES: { re: RegExp; label: string; apply: (d: ReqDraft) => void }[] = [
  {
    re: /需中间|坐中间|中间列|不坐边|不靠边/,
    label: '需中间列',
    apply: (d) => {
      d.vision = 'middle_required'
    },
  },
  {
    re: /近视|远视|弱视|散光|视力|前排|靠前|坐前面/,
    label: '视力需前排',
    apply: (d) => {
      if (d.vision !== 'middle_required') d.vision = 'front_required'
    },
  },
  {
    re: /听力|耳背|耳聋|助听/,
    label: '听力需前排',
    apply: (d) => {
      if (!d.special.includes('hearing')) d.special.push('hearing')
    },
  },
  {
    re: /行动不便|轮椅|拐杖|靠过道|需过道/,
    label: '行动不便需靠过道',
    apply: (d) => {
      if (!d.special.includes('mobility')) d.special.push('mobility')
    },
  },
]

// 否定句（「不坐后排」「不要靠窗」）：模型里没有对应约束，整条留作备注，不套上面的规则
const NEGATED_REQUIREMENT = /不(?:要|能|可|可以)?(?:坐|靠)/

// 留在备注里的文字中，哪些看起来像是「要求」（提示老师这些只留了备注，没变成约束）
const REQUIREMENT_HINT = /坐|靠|窗|门|同桌|分开|眼镜|视力|听力|走读|照顾|(?:前|后|中|边|旁)排/

const HEIGHT_RE = /^(\d{2,3})(?:\.\d+)?\s*(?:cm|厘米)?$/i

// 解析批量粘贴文本。existing：现有名单（用于跨批重名检测，只用到 name）。
export function parseRosterText(text: string, existing: { name: string }[]): RosterLine[] {
  const existingKeys = new Set(existing.map((s) => normalizeName(s.name)))
  const seen = new Map<string, number>() // 本批已出现的姓名 → 行号
  const lines: RosterLine[] = []

  text.split(/\r?\n/).forEach((rawLine, i) => {
    const lineNo = i + 1
    if (!rawLine.trim()) return // 空行直接不占结果，但行号照算

    const fields = rawLine.split(/[,，\t;；]/)
    const rawName = fields[0] ?? ''
    const name = normalizeName(rawName)
    const line: RosterLine = {
      lineNo,
      raw: rawLine,
      name,
      vision: 'none',
      special: [],
      recognized: [],
      noteOnly: [],
      status: 'ok',
      messages: [],
    }
    lines.push(line)
    const warn = (msg: string) => {
      line.status = 'warn'
      line.messages.push(msg)
    }

    if (rawName.trim() !== name) line.messages.push(`姓名按「${name}」处理（去掉了空格）`)

    // 第 2 列：身高（可带 cm/厘米）；不是数字则当备注
    const rest = fields.slice(1).map((f) => f.trim())
    const noteClauses: string[] = []
    const first = rest[0]
    if (first) {
      const h = HEIGHT_RE.exec(first)
      if (h) {
        line.heightCm = Number(h[1])
        rest.shift()
      } else if (/\d/.test(first)) {
        warn(`「${first}」看不懂是身高还是备注，已并入备注`)
      }
    }
    for (const f of rest) {
      // 备注内部可能还有顿号、句号、空格分隔的多条短句
      for (const clause of f.split(/[、，,；;。\s\u3000]+/)) {
        if (clause) noteClauses.push(clause)
      }
    }

    // 逐句识别座位要求；识别不了的留在备注
    const leftover: string[] = []
    for (const clause of noteClauses) {
      if (NEGATED_REQUIREMENT.test(clause)) {
        leftover.push(clause)
        continue
      }
      const matched = REQUIREMENT_RULES.filter((r) => r.re.test(clause))
      if (matched.length === 0) {
        leftover.push(clause)
        continue
      }
      for (const r of matched) {
        r.apply(line)
        if (!line.recognized.includes(r.label)) line.recognized.push(r.label)
      }
    }
    if (leftover.length > 0) line.note = leftover.join('，')
    line.noteOnly = leftover.filter((c) => REQUIREMENT_HINT.test(c))
    if (line.noteOnly.length > 0) {
      warn(`「${line.noteOnly.join('」「')}」没能识别成座位要求，只保留在备注里；如是座位要求，请导入后编辑该生`)
    }

    if (line.heightCm !== undefined && (line.heightCm < 90 || line.heightCm > 220)) {
      warn(`身高 ${line.heightCm} 超出常见范围（90–220），请确认`)
    }

    // 跳过：没姓名 / 与现有名单重名 / 与本批前面的行重名
    if (!name) {
      line.status = 'skip'
      line.messages.push('没读到姓名，跳过')
    } else if (existingKeys.has(name)) {
      line.status = 'skip'
      line.messages.push(`与现有名单里的「${name}」重复，跳过`)
    } else if (seen.has(name)) {
      line.status = 'skip'
      line.messages.push(`与第 ${seen.get(name)} 行是同一个人（${name}），跳过`)
    } else {
      seen.set(name, lineNo)
    }
  })

  return lines
}
