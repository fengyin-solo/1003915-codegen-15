import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 监测设备维护判定台：自动判定、人工改判、设备状态机与报修核验任务都收在这里，
// 页面只负责渲染和收集输入，不在组件里写业务判断。

export type JudgeConclusion = '正常' | '巡检' | '报修' | '停用'

export const JUDGE_CONCLUSIONS: JudgeConclusion[] = ['正常', '巡检', '报修', '停用']

export type DeviceJudgment = {
  conclusion: JudgeConclusion
  reasons: string[]
  referenceDate: string
  referenceSource: '最近维护日' | '安装日期'
  hazardStatus: string
}

// 不同设备类型的维护周期（天）：到期未维护建议巡检，超期翻倍建议报修。
const MAINTENANCE_CYCLE_DAYS: Record<string, number> = {
  雨量计: 90,
  位移计: 120,
  裂缝计: 180,
  倾角仪: 180,
}
const DEFAULT_CYCLE_DAYS = 180

// 设备状态机：只允许 正常运行 → 待巡检 → 待维修 → 确认修复回到正常运行；
// 已停用不能直接开机，必须先「重新启用」回到待巡检，巡检通过后才算恢复。
export const DEVICE_ACTIONS = ['发起巡检', '巡检通过', '转报修', '确认修复', '停用设备', '重新启用']

const DEVICE_TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  发起巡检: { from: ['正常运行'], to: '待巡检' },
  巡检通过: { from: ['待巡检'], to: '正常运行' },
  转报修: { from: ['待巡检'], to: '待维修' },
  确认修复: { from: ['待维修'], to: '正常运行' },
  停用设备: { from: ['正常运行', '待巡检', '待维修'], to: '已停用' },
  重新启用: { from: ['已停用'], to: '待巡检' },
}

const JUDGMENT_KEY = 'device_judgment'

function pad(num: number): string {
  return String(num).padStart(2, '0')
}

function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function now(): string {
  const date = new Date()
  return `${today()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseNumber(raw: unknown): number | null {
  const text = String(raw ?? '').replace('%', '').trim()
  if (!text) {
    return null
  }
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

function parseDateText(raw: unknown): Date | null {
  const text = String(raw ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null
  }
  const date = new Date(`${text}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// 自动判定：按设备类型维护周期、电池余量、通讯中断时长和所属隐患点状态给建议，
// 旧设备缺最近维护日的按安装日期兼容；多条规则命中时取最严重的一档。
export function judgeDevice(row: EntryRow, hazards: EntryRow[] = listRows('hazard')): DeviceJudgment {
  const type = String(row['设备类型'] ?? '')
  const cycle = MAINTENANCE_CYCLE_DAYS[type] ?? DEFAULT_CYCLE_DAYS

  const lastMaintain = parseDateText(row['最近维护日'])
  const installDate = parseDateText(row['安装日期'])
  const reference = lastMaintain ?? installDate
  const referenceSource = lastMaintain ? '最近维护日' : '安装日期'

  const findings: { level: number; reason: string }[] = []
  const push = (level: number, reason: string) => findings.push({ level, reason })

  const battery = parseNumber(row['电池余量'])
  if (battery !== null) {
    if (battery <= 10) {
      push(2, `电池余量 ${battery}% 严重不足（≤10%）`)
    } else if (battery <= 30) {
      push(1, `电池余量 ${battery}% 偏低（≤30%）`)
    }
  }

  const offlineHours = parseNumber(row['通讯中断时长'])
  if (offlineHours !== null && offlineHours > 0) {
    if (offlineHours >= 720) {
      push(3, `通讯中断 ${offlineHours} 小时，长期失联（≥720小时）`)
    } else if (offlineHours >= 72) {
      push(2, `通讯中断 ${offlineHours} 小时（≥72小时）`)
    } else if (offlineHours >= 24) {
      push(1, `通讯中断 ${offlineHours} 小时（≥24小时）`)
    }
  }

  if (reference) {
    const days = Math.floor((Date.now() - reference.getTime()) / 86400000)
    if (days > cycle * 2) {
      push(2, `已 ${days} 天未维护，超过${type || '设备'}维护周期（${cycle}天）两倍`)
    } else if (days > cycle) {
      push(1, `已 ${days} 天未维护，超过${type || '设备'}维护周期（${cycle}天）`)
    }
  }

  const hazard = hazards.find((item) => String(item['隐患点编号']) === String(row['所属隐患点'] ?? ''))
  const hazardStatus = hazard ? String(hazard.status) : ''
  if (hazardStatus === '已治理' || hazardStatus === '已核销') {
    push(3, `所属隐患点${hazardStatus}，监测设备建议停用`)
  }

  const levels: JudgeConclusion[] = ['正常', '巡检', '报修', '停用']
  const top = findings.reduce((max, item) => Math.max(max, item.level), 0)
  const ordered = [...findings].sort((a, b) => b.level - a.level).map((item) => item.reason)
  return {
    conclusion: levels[top],
    reasons: ordered.length > 0 ? ordered : ['各项指标在阈值内'],
    referenceDate: reference ? formatDate(reference) : '',
    referenceSource,
    hazardStatus,
  }
}

// 判定记录：同一台设备只保留一条「有效」结果，新判定生效时旧记录置为「已失效」。
export function listJudgments(): EntryRow[] {
  return [...listRows(JUDGMENT_KEY)].sort((a, b) => Number(b.id) - Number(a.id))
}

function findDevice(id: number): EntryRow | undefined {
  return listRows('device').find((row) => Number(row.id) === id)
}

function saveJudgment(
  device: EntryRow,
  judgment: DeviceJudgment,
  manualConclusion: JudgeConclusion | '',
  reason: string,
  operator: string,
): EntryRow {
  const deviceCode = String(device['设备编号'] ?? '')
  const rows = listRows(JUDGMENT_KEY).map((row) =>
    String(row['设备编号']) === deviceCode && row.status === '有效'
      ? { ...row, status: '已失效', pending: false }
      : row,
  )
  const manual = manualConclusion !== ''
  const conflict = manual && manualConclusion !== judgment.conclusion
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const record: EntryRow = {
    id,
    status: '有效',
    pending: true,
    abnormal: conflict,
    判定编号: `JUDG-${String(id).padStart(4, '0')}`,
    设备编号: deviceCode,
    设备类型: String(device['设备类型'] ?? ''),
    所属隐患点: String(device['所属隐患点'] ?? ''),
    维护参考日: judgment.referenceDate ? `${judgment.referenceDate}（按${judgment.referenceSource}）` : '—',
    自动判定: judgment.conclusion,
    自动依据: judgment.reasons.join('；'),
    判定方式: manual ? '人工改判' : '自动采纳',
    人工判定: manual ? manualConclusion : '',
    改判理由: manual ? reason : '',
    最终判定: manual ? manualConclusion : judgment.conclusion,
    判定人: operator,
    判定时间: now(),
  }
  saveRows(JUDGMENT_KEY, [...rows, record])
  return record
}

export function confirmAutoJudgment(deviceId: number, operator: string): ActionResult {
  const device = findDevice(deviceId)
  if (!device) {
    return { ok: false, message: `没有找到编号为 ${deviceId} 的监测设备` }
  }
  const judgment = judgeDevice(device)
  const record = saveJudgment(device, judgment, '', '', operator || '值班员')
  return { ok: true, message: `已采纳自动判定「${judgment.conclusion}」，判定记录 ${record['判定编号']} 生效` }
}

// 人工改判：必须填写理由；与自动阈值冲突时以人工结论为准，自动依据保留备查。
export function overrideJudgment(
  deviceId: number,
  conclusion: JudgeConclusion,
  reason: string,
  operator: string,
): ActionResult {
  if (!JUDGE_CONCLUSIONS.includes(conclusion)) {
    return { ok: false, message: `未知的判定结论「${conclusion}」` }
  }
  if (!reason.trim()) {
    return { ok: false, message: '人工改判必须填写改判理由' }
  }
  const device = findDevice(deviceId)
  if (!device) {
    return { ok: false, message: `没有找到编号为 ${deviceId} 的监测设备` }
  }
  const judgment = judgeDevice(device)
  const record = saveJudgment(device, judgment, conclusion, reason.trim(), operator || '值班员')
  const conflictNote =
    conclusion !== judgment.conclusion ? `，与自动判定「${judgment.conclusion}」冲突，按人工结论优先` : ''
  return { ok: true, message: `已记录人工判定「${conclusion}」${conflictNote}，判定记录 ${record['判定编号']} 生效` }
}

export function availableDeviceActions(status: string): string[] {
  return DEVICE_ACTIONS.filter((action) => DEVICE_TRANSITIONS[action].from.includes(status))
}

// 确认修复后在巡查排查页生成「设备修复核验」任务；同设备已有待巡查的核验任务时不重复生成。
function createPatrolVerificationTask(device: EntryRow): { created: boolean; code: string } {
  const deviceCode = String(device['设备编号'] ?? '')
  const rows = listRows('patrol')
  const existing = rows.find(
    (row) =>
      String(row['巡查范围'] ?? '') === '设备修复核验' &&
      String(row['处置措施'] ?? '').includes(deviceCode) &&
      row.status === '待巡查',
  )
  if (existing) {
    return { created: false, code: String(existing['巡查编号']) }
  }
  const maxSeq = rows.reduce((max, row) => {
    const match = /^PATR-(\d+)$/.exec(String(row['巡查编号'] ?? ''))
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  const code = `PATR-${String(maxSeq + 1).padStart(4, '0')}`
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const task: EntryRow = {
    id,
    status: '待巡查',
    pending: true,
    abnormal: false,
    巡查编号: code,
    隐患点编号: String(device['所属隐患点'] ?? ''),
    巡查日期: today(),
    巡查人员: '设备维护组',
    巡查范围: '设备修复核验',
    发现异常: '待核验',
    处置措施: `核验设备 ${deviceCode} 报修恢复情况`,
    巡查状态: '待巡查',
  }
  saveRows('patrol', [...rows, task])
  return { created: true, code }
}

// 设备状态流转：严格按状态机校验，非法跳转直接拒绝并提示合法路径。
export function applyDeviceAction(id: number, action: string): ActionResult {
  const transition = DEVICE_TRANSITIONS[action]
  if (!transition) {
    return { ok: false, message: `监测设备没有登记「${action}」这个动作` }
  }
  const rows = listRows('device')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的监测设备` }
  }
  const current = String(rows[index].status)
  if (!transition.from.includes(current)) {
    if (current === '已停用' && transition.to === '正常运行') {
      return { ok: false, message: '已停用设备不能直接开机，需先「重新启用」回到待巡检，巡检通过后才算恢复' }
    }
    return {
      ok: false,
      message: `设备当前为「${current}」，不允许直接${action}；流转路径：正常运行→待巡检→待维修→确认修复恢复`,
    }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: transition.to,
    设备状态: transition.to,
    pending: transition.to === '待巡检' || transition.to === '待维修',
    abnormal: transition.to === '待维修' || transition.to === '已停用',
  }
  const next = [...rows]
  next[index] = updated
  saveRows('device', next)
  let extra = ''
  if (action === '确认修复') {
    const task = createPatrolVerificationTask(updated)
    extra = task.created
      ? `，已在巡查排查页生成核验任务 ${task.code}`
      : `，巡查排查页已有该设备的待核验任务 ${task.code}，不重复生成`
  }
  return { ok: true, message: `监测设备已${action}，当前状态「${transition.to}」${extra}` }
}
