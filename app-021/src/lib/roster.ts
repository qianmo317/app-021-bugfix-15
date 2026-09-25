import type { Special, Vision } from '../types'

// ================= 批量粘贴名单解析 =================
// 从教务表粘贴的名单：每行「姓名,身高,备注」（逗号 / 中文逗号 / 制表符分列，多余列并入备注）。
// 解析目标：
//   1) 备注里的座位要求尽量识别成结构化字段（视力需前排 / 需中间、听力、行动不便）；
//      引擎不支持的要求（如「不坐后排」）保留在备注并在预览中明确标出「仅备注」。
//   2) 姓名规范化（去掉半角/全角空格）后再查重，避免「张 三」「张　三」被当成另一个人。
//   3) 每一行都给出明确结论：导入 / 跳过（含原因），确认后才入名单。

export interface RosterRow {
  line: number // 在粘贴文本中的行号（从 1 开始，含空行）
  raw: string // 原始行文本
  name: string // 规范化后的姓名（跳过行也可能有，用于展示）
  rawName: string // 第一列原文（trim 后，未去内部空格）
  heightCm?: number
  vision: Vision
  special: Special[]
  note?: string // 备注原文（识别出的要求也保留在此，不丢信息）
  noteOnly: string[] // 仅保留在备注、不参与自动排座的要求
  warnings: string[] // 导入但需注意（如身高无法识别）
  skipReason?: string // 非空表示该行被跳过
}

export interface RosterResult {
  rows: RosterRow[]
  importable: RosterRow[] // 将入名单的行
  skipped: RosterRow[] // 被跳过的行（重名 / 表头 / 无姓名）
}

/** 姓名规范化：去掉所有空白（含全角空格 U+3000），用于存储与查重 */
export function normalizeName(s: string): string {
  return s.replace(/[\s　]/g, '')
}

// ---------- 备注关键词 → 结构化字段 ----------
// 注意排除「视力正常」「听力正常」「不坐前排」这类否定/正常表述。
const RE_VISION_FRONT = /(?<!不)(?<!无)近视|视力(?:弱|差|低|下降|不好|需|要)|(?:要|需|应|宜)坐?前排|坐前排|前排就坐/
const RE_NOT_FRONT = /不(?:要|想|愿|能|适合)?坐?前排/
const RE_VISION_MIDDLE = /(?:视力|眼睛|斜视)[^，。；;]{0,4}中间|需坐?中间(?:列|排)?|不坐?边列/
const RE_NOT_MIDDLE = /不(?:要|想|愿|能)?坐?中间/
const RE_HEARING = /听力(?!正常|良好|尚可|无碍|没问题)|耳背|重听|助听器|人工耳蜗|听不清/
const RE_MOBILITY = /行动不便|轮椅|拄拐|拐杖|腿(?:伤|疾|折)|脚(?:伤|疾)|靠过道|需过道|坐过道|进出(?:不便|方便)/

// 引擎不支持的座位要求：只留备注，预览中明确告知老师
const NOTE_ONLY_RULES: { re: RegExp; label: string }[] = [
  { re: /不(?:能|要|宜|适合)?坐?(?:最?后|后排)/, label: '不坐后排' },
  { re: /不靠窗|不坐(?:靠)?窗/, label: '不靠窗' },
  { re: /不靠门|不坐(?:靠)?门/, label: '不靠门' },
]

// 常见表头行（粘贴时带上的第一行）
const HEADER_NAMES = new Set(['姓名', '学生姓名', '名字', 'name'])

/** 身高解析：兼容全角数字与「152cm」写法；合法范围与逐个添加一致（90~220） */
export function parseHeight(raw: string | undefined): { heightCm?: number; warning?: string } {
  if (!raw) return {}
  const half = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  const m = half.match(/\d{2,3}(?:\.\d)?/)
  if (!m) return { warning: `身高「${raw.trim()}」无法识别，已忽略` }
  const v = Number(m[0])
  if (v < 90 || v > 220) return { warning: `身高 ${v}cm 超出 90~220 范围，已忽略` }
  return { heightCm: v }
}

/** 识别备注中的座位要求，返回结构化字段与「仅备注」标签 */
export function parseNote(note: string | undefined): {
  vision: Vision
  special: Special[]
  noteOnly: string[]
} {
  const out = { vision: 'none' as Vision, special: [] as Special[], noteOnly: [] as string[] }
  if (!note) return out
  const text = note.trim()
  if (!text) return out

  if (RE_VISION_FRONT.test(text) && !RE_NOT_FRONT.test(text)) {
    out.vision = 'front_required'
  } else if (RE_VISION_MIDDLE.test(text) && !RE_NOT_MIDDLE.test(text)) {
    out.vision = 'middle_required'
  }
  if (RE_HEARING.test(text)) out.special.push('hearing')
  if (RE_MOBILITY.test(text)) out.special.push('mobility')
  for (const { re, label } of NOTE_ONLY_RULES) {
    if (re.test(text)) out.noteOnly.push(label)
  }
  return out
}

/**
 * 解析粘贴文本为逐行结果。
 * @param existingNames 现有名单姓名（内部会做同样的规范化）
 */
export function parseRoster(text: string, existingNames: string[]): RosterResult {
  const existing = new Set(existingNames.map(normalizeName))
  const seen = new Map<string, number>() // 本次粘贴中已出现的姓名 → 首次行号
  const rows: RosterRow[] = []

  const lines = text.split(/\r\n|\r|\n/)
  lines.forEach((raw, i) => {
    const line = raw.trim()
    if (!line) return // 空行直接忽略，不算问题行

    const parts = line.split(/[,，\t]/)
    const rawName = (parts[0] ?? '').trim()
    const name = normalizeName(rawName)
    const noteParts = parts
      .slice(2)
      .map((p) => p.trim())
      .filter(Boolean)
    const note = noteParts.length ? noteParts.join('，') : undefined
    const { heightCm, warning } = parseHeight(parts[1]?.trim())
    const fromNote = parseNote(note)

    const row: RosterRow = {
      line: i + 1,
      raw,
      name,
      rawName,
      heightCm,
      vision: fromNote.vision,
      special: fromNote.special,
      note,
      noteOnly: fromNote.noteOnly,
      warnings: warning ? [warning] : [],
    }

    if (!name) {
      row.skipReason = '没有姓名'
    } else if (HEADER_NAMES.has(name.toLowerCase())) {
      row.skipReason = '表头行'
    } else if (existing.has(name)) {
      row.skipReason = '与现有名单重名'
    } else if (seen.has(name)) {
      row.skipReason = `与第 ${seen.get(name)} 行重名`
    } else {
      seen.set(name, i + 1)
    }
    rows.push(row)
  })

  return {
    rows,
    importable: rows.filter((r) => !r.skipReason),
    skipped: rows.filter((r) => r.skipReason),
  }
}
