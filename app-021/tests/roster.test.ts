import { describe, expect, it } from 'vitest'
import { normalizeName, parseRosterText } from '../src/lib/roster'

const NONE = { name: '' } // 占位类型说明：existing 只用 name

describe('normalizeName', () => {
  it('去掉半角/全角空格与首尾空白', () => {
    expect(normalizeName('张三')).toBe('张三')
    expect(normalizeName('张 三')).toBe('张三')
    expect(normalizeName('张　三')).toBe('张三') // 全角空格
    expect(normalizeName('  张三  ')).toBe('张三')
    expect(normalizeName('　张 三　')).toBe('张三')
  })
})

describe('parseRosterText 基本解析', () => {
  it('姓名,身高,备注；支持中文逗号与制表符', () => {
    const [a, b, c] = parseRosterText('张三,152,爱说话\n李四，148\n王五\t150\t近视', [])
    expect(a).toMatchObject({ name: '张三', heightCm: 152, note: '爱说话', vision: 'none', status: 'ok' })
    expect(b).toMatchObject({ name: '李四', heightCm: 148, vision: 'none' })
    expect(c).toMatchObject({ name: '王五', heightCm: 150, vision: 'front_required' })
  })

  it('没有备注要求时视力默认为 none（不再一律标成需前排）', () => {
    const [l] = parseRosterText('张三,152', [])
    expect(l.vision).toBe('none')
    expect(l.special).toEqual([])
    expect(l.status).toBe('ok')
  })

  it('第二列不是身高时当备注处理；身高可带 cm/厘米', () => {
    const [a] = parseRosterText('张三,爱说话', [])
    expect(a.heightCm).toBeUndefined()
    expect(a.note).toBe('爱说话')
    const [b] = parseRosterText('张三,152cm', [])
    expect(b.heightCm).toBe(152)
    const [c] = parseRosterText('张三,152厘米', [])
    expect(c.heightCm).toBe(152)
  })

  it('备注列之后的列不会丢，全部并入备注', () => {
    const [l] = parseRosterText('张三,152,近视,爱说话', [])
    expect(l.vision).toBe('front_required')
    expect(l.note).toBe('爱说话')
  })

  it('空行不占结果但占行号', () => {
    const lines = parseRosterText('张三\n\n李四', [])
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.lineNo)).toEqual([1, 3])
  })
})

describe('parseRosterText 备注里的座位要求', () => {
  it('视力要坐前排 → vision=front_required，不再只留备注', () => {
    const [l] = parseRosterText('张三,,视力要坐前排', [])
    expect(l.vision).toBe('front_required')
    expect(l.recognized).toContain('视力需前排')
    expect(l.note).toBeUndefined()
    expect(l.status).toBe('ok')
  })

  it('听力不好 → special 含 hearing', () => {
    const [l] = parseRosterText('李四,148,听力不好', [])
    expect(l.special).toContain('hearing')
    expect(l.recognized).toContain('听力需前排')
  })

  it('行动不便 / 需中间列也能识别', () => {
    const [a] = parseRosterText('王五,,行动不便', [])
    expect(a.special).toContain('mobility')
    const [b] = parseRosterText('赵六,,需中间列', [])
    expect(b.vision).toBe('middle_required')
  })

  it('走读不坐后排：模型没有对应约束，只留备注并提醒', () => {
    const [l] = parseRosterText('张三,150,走读不坐后排', [])
    expect(l.vision).toBe('none')
    expect(l.note).toBe('走读不坐后排')
    expect(l.noteOnly).toEqual(['走读不坐后排'])
    expect(l.status).toBe('warn')
    expect(l.messages.join('')).toContain('只保留在备注')
  })

  it('否定句不会被误判：不坐前排 ≠ 需前排', () => {
    const [l] = parseRosterText('张三,,不坐前排', [])
    expect(l.vision).toBe('none')
    expect(l.note).toBe('不坐前排')
  })

  it('「视力不好要坐前排」是否定+要求的混合，仍能识别为需前排', () => {
    const [l] = parseRosterText('张三,,视力不好要坐前排', [])
    expect(l.vision).toBe('front_required')
  })

  it('普通备注（爱说话）不触发提醒', () => {
    const [l] = parseRosterText('张三,152,爱说话', [])
    expect(l.status).toBe('ok')
    expect(l.note).toBe('爱说话')
    expect(l.noteOnly).toEqual([])
  })
})

describe('parseRosterText 姓名规范化与重名', () => {
  it('姓名带空格/全角空格按同一个人处理，并给出提示', () => {
    const [a, b] = parseRosterText('张 三\n张　三', [])
    expect(a.name).toBe('张三')
    expect(a.messages.join('')).toContain('去掉了空格')
    expect(b.status).toBe('skip')
    expect(b.messages.join('')).toContain('第 1 行')
  })

  it('与现有名单重名（含空格差异）会跳过并说明是谁', () => {
    const lines = parseRosterText('张 三\n李四', [{ ...NONE, name: '张三' }])
    expect(lines[0].status).toBe('skip')
    expect(lines[0].messages.join('')).toContain('现有名单')
    expect(lines[0].messages.join('')).toContain('张三')
    expect(lines[1].status).toBe('ok')
  })

  it('本批内部重复只保留第一行', () => {
    const lines = parseRosterText('张三\n李四\n张三', [])
    expect(lines.map((l) => l.status)).toEqual(['ok', 'ok', 'skip'])
    expect(lines[2].messages.join('')).toContain('第 1 行')
  })

  it('没读到姓名的行跳过', () => {
    const [l] = parseRosterText(',152', [])
    expect(l.status).toBe('skip')
    expect(l.messages.join('')).toContain('没读到姓名')
  })
})

describe('parseRosterText 异常数据提醒', () => {
  it('身高列像数字却看不懂 → 提醒并入备注', () => {
    const [l] = parseRosterText('张三,15a2', [])
    expect(l.heightCm).toBeUndefined()
    expect(l.status).toBe('warn')
    expect(l.messages.join('')).toContain('看不懂')
  })

  it('身高超出常见范围 → 提醒但保留', () => {
    const [l] = parseRosterText('张三,300', [])
    expect(l.heightCm).toBe(300)
    expect(l.status).toBe('warn')
    expect(l.messages.join('')).toContain('超出常见范围')
  })
})
