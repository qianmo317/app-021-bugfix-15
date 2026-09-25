import { describe, expect, it } from 'vitest'
import { normalizeName, parseHeight, parseNote, parseRoster } from '../src/lib/roster'

describe('姓名规范化', () => {
  it('去掉半角/全角空格与制表符', () => {
    expect(normalizeName('张三')).toBe('张三')
    expect(normalizeName('张 三')).toBe('张三')
    expect(normalizeName('张　三')).toBe('张三') // 全角空格
    expect(normalizeName('  张 三  ')).toBe('张三')
    expect(normalizeName('欧阳\t娜娜')).toBe('欧阳娜娜')
    expect(normalizeName('阿不都·外力')).toBe('阿不都·外力') // 间隔号保留
  })
})

describe('身高解析', () => {
  it('常规与全角数字', () => {
    expect(parseHeight('152').heightCm).toBe(152)
    expect(parseHeight('１５２').heightCm).toBe(152) // 全角数字
    expect(parseHeight('152cm').heightCm).toBe(152)
    expect(parseHeight(' 148 ').heightCm).toBe(148)
    expect(parseHeight('').heightCm).toBeUndefined()
    expect(parseHeight(undefined).heightCm).toBeUndefined()
  })

  it('非法与超范围只警告不阻断', () => {
    expect(parseHeight('男').heightCm).toBeUndefined()
    expect(parseHeight('男').warning).toContain('无法识别')
    expect(parseHeight('250').heightCm).toBeUndefined()
    expect(parseHeight('250').warning).toContain('超出')
  })
})

describe('备注要求识别', () => {
  it('视力要坐前排 → vision=front_required', () => {
    expect(parseNote('视力要坐前排').vision).toBe('front_required')
    expect(parseNote('近视 300 度').vision).toBe('front_required')
    expect(parseNote('视力下降，需坐前排').vision).toBe('front_required')
  })

  it('听力不好 → special 含 hearing', () => {
    expect(parseNote('听力不好').special).toContain('hearing')
    expect(parseNote('耳背').special).toContain('hearing')
  })

  it('行动不便/靠过道 → special 含 mobility', () => {
    expect(parseNote('行动不便，需靠过道').special).toContain('mobility')
    expect(parseNote('坐轮椅').special).toContain('mobility')
  })

  it('需中间列', () => {
    expect(parseNote('斜视，需坐中间').vision).toBe('middle_required')
  })

  it('走读不坐后排 → 仅备注，不设结构化字段', () => {
    const r = parseNote('走读，不坐后排')
    expect(r.vision).toBe('none')
    expect(r.special).toHaveLength(0)
    expect(r.noteOnly).toContain('不坐后排')
  })

  it('否定与正常表述不误判', () => {
    const normal = parseNote('视力正常，听力正常')
    expect(normal.vision).toBe('none')
    expect(normal.special).toHaveLength(0)
    expect(parseNote('不要坐前排').vision).toBe('none')
    expect(parseNote('不近视').vision).toBe('none')
  })

  it('普通备注原样保留、不产生标签', () => {
    const r = parseNote('爱说话')
    expect(r.vision).toBe('none')
    expect(r.noteOnly).toHaveLength(0)
  })
})

describe('整表解析 parseRoster', () => {
  it('每行一个学生：姓名/身高/备注，多余列并入备注', () => {
    const { rows, importable } = parseRoster('张三,152,戴眼镜\n李四,148', [])
    expect(importable).toHaveLength(2)
    expect(rows[0]).toMatchObject({ name: '张三', heightCm: 152, note: '戴眼镜' })
    expect(rows[1]).toMatchObject({ name: '李四', heightCm: 148, note: undefined })
    const extra = parseRoster('王五,150,男,爱说话', [])
    expect(extra.rows[0].note).toBe('男，爱说话')
  })

  it('支持中文逗号与制表符分列（教务表直接粘贴）', () => {
    const { importable } = parseRoster('张三，152，近视\n李四\t148\t听力不好', [])
    expect(importable).toHaveLength(2)
    expect(importable[0].vision).toBe('front_required')
    expect(importable[1].special).toContain('hearing')
  })

  it('空行与表头行跳过且不阻断其他行', () => {
    const { rows, importable, skipped } = parseRoster('姓名,身高,备注\n\n张三,150\n   \n李四,151', [])
    expect(importable.map((r) => r.name)).toEqual(['张三', '李四'])
    expect(skipped).toHaveLength(1)
    expect(skipped[0].skipReason).toBe('表头行')
    expect(rows[0].line).toBe(1)
    expect(rows[1].line).toBe(3) // 行号按原文计（含空行）
  })

  it('全角空格/中间空格不再被当成另一个人', () => {
    const { importable, skipped } = parseRoster('张 三\n张　三', [])
    expect(importable).toHaveLength(1)
    expect(importable[0].name).toBe('张三')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].skipReason).toContain('重名')
  })

  it('与现有名单重名（含空格变体）被跳过并说明', () => {
    const { importable, skipped } = parseRoster('张 三,150\n李四,151', ['张三'])
    expect(importable.map((r) => r.name)).toEqual(['李四'])
    expect(skipped[0].skipReason).toBe('与现有名单重名')
  })

  it('粘贴文本内部重名：保留首次，跳过后续并指出行号', () => {
    const { importable, skipped } = parseRoster('张三,150\n李四,151\n张三,152', [])
    expect(importable.map((r) => r.name)).toEqual(['张三', '李四'])
    expect(skipped).toHaveLength(1)
    expect(skipped[0].line).toBe(3)
    expect(skipped[0].skipReason).toBe('与第 1 行重名')
  })

  it('没有姓名的行被跳过', () => {
    const { skipped } = parseRoster(',150,只有身高', [])
    expect(skipped[0].skipReason).toBe('没有姓名')
  })

  it('身高非法只警告，行仍然导入', () => {
    const { importable } = parseRoster('张三,男,备注', [])
    expect(importable).toHaveLength(1)
    expect(importable[0].heightCm).toBeUndefined()
    expect(importable[0].warnings[0]).toContain('无法识别')
  })

  it('识别出的要求保留备注原文，同时写入结构化字段', () => {
    const { importable } = parseRoster('张三,150,视力要坐前排，走读不坐后排', [])
    const r = importable[0]
    expect(r.vision).toBe('front_required')
    expect(r.note).toBe('视力要坐前排，走读不坐后排') // 原文不丢
    expect(r.noteOnly).toContain('不坐后排')
  })
})
