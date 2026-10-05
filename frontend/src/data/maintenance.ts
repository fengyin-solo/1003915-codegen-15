import { listRows, saveRows } from './local-store'
import type { ActionResult, EntryRow } from './types'

// 维护判定台：自动阈值判定 + 人工改判 + 设备状态机 + 报修核验任务联动。
// 结论独立持久化（与业务清单分开存），刷新后判定记录和阈值配置仍在。

export type Advice = '正常' | '巡检' | '报修' | '停用'

export const ADVICE_ORDER: Advice[] = ['正常', '巡检', '报修', '停用']
export const ADVICE_RANK: Record<Advice, number> = { 正常: 0, 巡检: 1, 报修: 2, 停用: 3 }

// 判定建议与设备状态一一对应
export const ADVICE_DEVICE_STATUS: Record<Advice, string> = {
  正常: '正常运行',
  巡检: '巡检中',
  报修: '待维修',
  停用: '已停用',
}
export const DEVICE_STATUS_BY_NAME: Record<string, Advice> = {
  正常运行: '正常',
  巡检中: '巡检',
  待维修: '报修',
  已停用: '停用',
}

// 设备状态机：只允许 正常 → 巡检 → 报修 →（修复确认）恢复正常；停用后不能直接开机，须先报修再修复。
export const STATUS_TRANSITIONS: Record<string, string[]> = {
  正常运行: ['巡检中', '待维修', '已停用'],
  巡检中: ['待维修', '已停用'],
  待维修: ['正常运行', '已停用'],
  已停用: ['待维修'],
}

// 旧版骨架里出现过的状态：进入设备页时统一归并到新状态机
export const LEGACY_STATUS: Record<string, string> = {
  信号异常: '巡检中',
  低电量: '巡检中',
}

export type ThresholdRule = {
  batteryWarn: number // 电池余量（%）低于该值 → 巡检
  batteryFault: number // 低于该值 → 报修
  outageWarn: number // 通讯中断（小时）达到该值 → 巡检
  outageFault: number // 达到该值 → 报修
  maintainWarn: number // 距上次维护（天）达到该值 → 巡检
  maintainFault: number // 达到该值 → 报修
}

export const DEFAULT_THRESHOLDS: ThresholdRule = {
  batteryWarn: 30,
  batteryFault: 15,
  outageWarn: 24,
  outageFault: 72,
  maintainWarn: 180,
  maintainFault: 365,
}

// 不同设备类型的阈值差异（只列与全局默认不同的项，未列项继承全局）
export const TYPE_THRESHOLD_PRESETS: Record<string, Partial<ThresholdRule>> = {
  GNSS接收机: { batteryWarn: 40, batteryFault: 20, outageWarn: 12, outageFault: 48 },
  裂缝计: { batteryWarn: 25, batteryFault: 10, outageWarn: 24, outageFault: 72 },
  倾角传感器: { batteryWarn: 25, batteryFault: 10, outageWarn: 24, outageFault: 72 },
  雨量计: { batteryWarn: 35, batteryFault: 15, outageWarn: 12, outageFault: 48 },
  视频监控: { batteryWarn: 40, batteryFault: 20, outageWarn: 6, outageFault: 24 },
}

export type ThresholdConfig = {
  global: ThresholdRule
  byType: Record<string, Partial<ThresholdRule>>
}

export type DecisionRecord = {
  id: number
  deviceId: number
  deviceCode: string
  autoAdvice: Advice // 判定时刻系统自动阈值结论
  effectiveAdvice: Advice // 实际生效结论（人工改判后以人工为准）
  conflict: boolean // 人工结论与自动结论是否冲突
  reason: string // 改判理由（与自动一致时记录确认意见）
  operator: string
  submittedAt: string
  status: '有效' | '已被改判覆盖'
  restore: boolean // 是否为报修后的修复恢复
  verificationTaskCode: string | null // 报修确认后生成的巡查核验任务编号
}

type MaintenanceStore = {
  version: 1
  decisionSeq: number
  decisions: DecisionRecord[]
  thresholds: ThresholdConfig
}

export type Evaluation = {
  deviceId: number
  advice: Advice
  reasons: string[]
  battery: number | null
  outageHours: number | null
  maintenanceDate: string | null
  maintenanceDateSource: '最近维护日' | '安装日期' | '无记录'
  daysSinceMaintenance: number | null
  hazardCode: string
  hazardStatus: string | null
}

const STORE_KEY = 'geohazard-monitor-prevention:maintenance'

// ---------- 解析工具：种子/存量数据可能是「85%」「12小时」之类的文本，统一兜底 ----------

export function parsePercent(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const match = String(value ?? '').match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : null
}

export function parseHours(value: unknown): number | null {
  const text = String(value ?? '')
  const match = text.match(/-?\d+(\.\d+)?/)
  if (!match) return null
  const hours = Number(match[0])
  return text.includes('天') ? hours * 24 : hours
}

export function parseDate(value: unknown): string | null {
  const match = String(value ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function toDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

function daysBetween(from: string, to: Date): number {
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${toDateString(to)}T00:00:00`)
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000))
}

// ---------- 阈值配置 ----------

function defaultStore(): MaintenanceStore {
  return {
    version: 1,
    decisionSeq: 0,
    decisions: [],
    thresholds: { global: { ...DEFAULT_THRESHOLDS }, byType: { ...TYPE_THRESHOLD_PRESETS } },
  }
}

function readStore(): MaintenanceStore {
  const fallback = defaultStore()
  if (typeof window === 'undefined' || !window.localStorage) return fallback
  const raw = window.localStorage.getItem(STORE_KEY)
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as Partial<MaintenanceStore>
    return {
      ...fallback,
      ...parsed,
      thresholds: {
        global: { ...DEFAULT_THRESHOLDS, ...(parsed.thresholds?.global ?? {}) },
        byType: { ...TYPE_THRESHOLD_PRESETS, ...(parsed.thresholds?.byType ?? {}) },
      },
    }
  } catch {
    return fallback
  }
}

function writeStore(store: MaintenanceStore): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store))
  }
}

export function loadThresholds(): ThresholdConfig {
  return readStore().thresholds
}

export function saveThresholds(thresholds: ThresholdConfig): void {
  const store = readStore()
  writeStore({ ...store, thresholds })
}

export function ruleFor(deviceType: string, config: ThresholdConfig): ThresholdRule {
  return { ...config.global, ...(config.byType[deviceType] ?? {}) }
}

// ---------- 自动判定 ----------

export function hazardStatusMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of listRows('hazard')) {
    map.set(String(row['隐患点编号'] ?? ''), String(row.status ?? ''))
  }
  return map
}

export function evaluateDevice(
  row: EntryRow,
  config: ThresholdConfig,
  hazardMap: Map<string, string>,
  today: Date = new Date(),
): Evaluation {
  const rule = ruleFor(String(row['设备类型'] ?? ''), config)
  const reasons: string[] = []
  let level: Advice = '正常'
  const raise = (advice: Advice, text: string) => {
    reasons.push(text)
    if (ADVICE_RANK[advice] > ADVICE_RANK[level]) level = advice
  }

  const battery = parsePercent(row['电池余量'])
  if (battery !== null) {
    if (battery <= rule.batteryFault) {
      raise('报修', `电池余量 ${battery}% 已低于报修阈值 ${rule.batteryFault}%`)
    } else if (battery <= rule.batteryWarn) {
      raise('巡检', `电池余量 ${battery}% 已低于巡检阈值 ${rule.batteryWarn}%`)
    }
  }

  const outageHours = parseHours(row['通讯中断时长'])
  if (outageHours !== null && outageHours > 0) {
    if (outageHours >= rule.outageFault) {
      raise('报修', `通讯中断 ${outageHours} 小时，达到报修阈值 ${rule.outageFault} 小时`)
    } else if (outageHours >= rule.outageWarn) {
      raise('巡检', `通讯中断 ${outageHours} 小时，达到巡检阈值 ${rule.outageWarn} 小时`)
    }
  }

  // 旧设备可能没有最近维护日：按安装日期兼容
  const maintainedAt = parseDate(row['最近维护日'])
  const installedAt = parseDate(row['安装日期'])
  let maintenanceDate = maintainedAt
  let source: Evaluation['maintenanceDateSource'] = maintainedAt ? '最近维护日' : '无记录'
  if (!maintenanceDate && installedAt) {
    maintenanceDate = installedAt
    source = '安装日期'
  }
  let daysSinceMaintenance: number | null = null
  if (maintenanceDate) {
    daysSinceMaintenance = daysBetween(maintenanceDate, today)
    if (daysSinceMaintenance >= rule.maintainFault) {
      const suffix = source === '安装日期' ? '（无最近维护日记录，按安装日期计算）' : ''
      raise('报修', `距上次维护已 ${daysSinceMaintenance} 天，达到报修阈值 ${rule.maintainFault} 天${suffix}`)
    } else if (daysSinceMaintenance >= rule.maintainWarn) {
      const suffix = source === '安装日期' ? '（无最近维护日记录，按安装日期计算）' : ''
      raise('巡检', `距上次维护已 ${daysSinceMaintenance} 天，达到巡检阈值 ${rule.maintainWarn} 天${suffix}`)
    }
  }

  const hazardCode = String(row['所属隐患点'] ?? '')
  const hazardStatus = hazardMap.has(hazardCode) ? hazardMap.get(hazardCode)! : null
  if (hazardStatus === '已核销') {
    raise('停用', `所属隐患点 ${hazardCode} 已核销，设备无保留必要，建议停用`)
  } else if (hazardStatus === '已治理') {
    raise('巡检', `所属隐患点 ${hazardCode} 已治理，建议现场巡检后决定设备去留`)
  }

  return {
    deviceId: Number(row.id),
    advice: level,
    reasons,
    battery,
    outageHours,
    maintenanceDate,
    maintenanceDateSource: source,
    daysSinceMaintenance,
    hazardCode,
    hazardStatus,
  }
}

export function evaluateAll(config: ThresholdConfig, today: Date = new Date()): Map<number, Evaluation> {
  const hazardMap = hazardStatusMap()
  const result = new Map<number, Evaluation>()
  for (const row of listRows('device')) {
    result.set(Number(row.id), evaluateDevice(row, config, hazardMap, today))
  }
  return result
}

// ---------- 状态机与判定记录 ----------

export function normalizeStatus(status: string): string {
  return LEGACY_STATUS[status] ?? status
}

export function canTransit(current: string, target: string): boolean {
  if (current === target) return true
  return (STATUS_TRANSITIONS[normalizeStatus(current)] ?? []).includes(target)
}

export function transitBlockReason(current: string, advice: Advice): string | null {
  const target = ADVICE_DEVICE_STATUS[advice]
  if (canTransit(current, target)) return null
  if (normalizeStatus(current) === '已停用' && advice === '正常') {
    return '停用设备不能直接开机：请先提交「报修」，修复确认后方可恢复正常'
  }
  if (normalizeStatus(current) === '巡检中' && advice === '正常') {
    return '巡检结论不能直接恢复正常：请按「报修 → 修复确认」流程处置后恢复'
  }
  return `设备状态不允许从「${current}」变更为「${target}」`
}

export function listDecisions(): DecisionRecord[] {
  return readStore().decisions
}

export function effectiveDecisions(): Map<number, DecisionRecord> {
  const map = new Map<number, DecisionRecord>()
  for (const decision of readStore().decisions) {
    if (decision.status === '有效') map.set(decision.deviceId, decision)
  }
  return map
}

const VERIFY_PREFIX = 'PATR-VRF'

export function verificationTaskCode(deviceId: number): string {
  return `${VERIFY_PREFIX}-${String(deviceId).padStart(3, '0')}`
}

// 同一台设备只保留一个未闭环的核验任务，重复报修判定不重复生成
function findOpenVerificationTask(deviceCode: string): EntryRow | null {
  return (
    listRows('patrol').find(
      (row) =>
        String(row['关联设备编号'] ?? '') === deviceCode &&
        String(row['任务来源'] ?? '') === '报修核验' &&
        String(row.status) !== '已处置',
    ) ?? null
  )
}

function upsertVerificationTask(device: EntryRow, reason: string, today: Date): EntryRow {
  const code = String(device['设备编号'] ?? '')
  const existing = findOpenVerificationTask(code)
  if (existing) return existing

  const patrolRows = listRows('patrol')
  const id = patrolRows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const task: EntryRow = {
    id,
    status: '待巡查',
    pending: true,
    abnormal: false,
    巡查编号: verificationTaskCode(Number(device.id)),
    隐患点编号: String(device['所属隐患点'] ?? ''),
    巡查日期: toDateString(today),
    巡查人员: '待派单',
    巡查范围: `设备报修现场核验：${code}（${device['设备类型'] ?? ''}）`,
    发现异常: `监测设备已报修，需现场核验修复情况。${reason ? `报修依据：${reason}` : ''}`,
    处置措施: '',
    任务来源: '报修核验',
    关联设备编号: code,
  }
  saveRows('patrol', [...patrolRows, task])
  return task
}

export type SubmitDecisionInput = {
  deviceId: number
  advice: Advice
  reason: string
  operator: string
  today?: Date
}

export type SubmitDecisionResult = ActionResult & { decision?: DecisionRecord }

export function submitDecision(input: SubmitDecisionInput): SubmitDecisionResult {
  const today = input.today ?? new Date()
  const config = readStore().thresholds
  const rows = listRows('device')
  const index = rows.findIndex((row) => Number(row.id) === input.deviceId)
  if (index < 0) return { ok: false, message: '没有找到该监测设备' }

  const device = rows[index]
  const current = normalizeStatus(String(device.status))
  const targetStatus = ADVICE_DEVICE_STATUS[input.advice]

  const blockReason = transitBlockReason(current, input.advice)
  if (blockReason) return { ok: false, message: blockReason }

  const evaluation = evaluateDevice(
    device,
    config,
    hazardStatusMap(),
    today,
  )
  const reason = input.reason.trim()
  // 与自动阈值结论不一致即视为人工改判，必须填写理由；优先级上人工结论生效
  const isOverride = input.advice !== evaluation.advice
  if (isOverride && !reason) {
    return { ok: false, message: '人工改判与自动阈值结论不一致，必须填写改判理由' }
  }

  const store = readStore()
  // 重复判定只保留一个有效结果：旧有效结论标记为被覆盖，历史仍可查
  let superseded = 0
  for (const decision of store.decisions) {
    if (decision.deviceId === input.deviceId && decision.status === '有效') {
      decision.status = '已被改判覆盖'
      superseded += 1
    }
  }

  const restore = current === '待维修' && input.advice === '正常'
  let verificationTaskCodeValue: string | null = null
  if (input.advice === '报修') {
    const task = upsertVerificationTask(device, reason || evaluation.reasons.join('；'), today)
    verificationTaskCodeValue = String(task['巡查编号'] ?? '')
  }

  const decision: DecisionRecord = {
    id: store.decisionSeq + 1,
    deviceId: input.deviceId,
    deviceCode: String(device['设备编号'] ?? ''),
    autoAdvice: evaluation.advice,
    effectiveAdvice: input.advice,
    conflict: isOverride,
    reason: reason || (evaluation.reasons.length ? evaluation.reasons.join('；') : '人工确认：设备运行正常'),
    operator: input.operator,
    submittedAt: `${toDateString(today)} ${today.toTimeString().slice(0, 5)}`,
    status: '有效',
    restore,
    verificationTaskCode: verificationTaskCodeValue,
  }

  const updated: EntryRow = {
    ...device,
    status: targetStatus,
    设备状态: targetStatus,
    pending: targetStatus !== '已停用',
    abnormal: targetStatus === '已停用',
  }
  // 修复确认即完成一次维护，最近维护日更新为当天
  if (restore) updated['最近维护日'] = toDateString(today)

  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows('device', nextRows)

  writeStore({
    ...store,
    decisionSeq: decision.id,
    decisions: [...store.decisions, decision],
  })

  const verb = superseded > 0 ? '已覆盖原有效判定，' : ''
  const suffix =
    input.advice === '报修'
      ? `，巡查排查页已生成核验任务${verificationTaskCodeValue ? `（${verificationTaskCodeValue}）` : ''}`
      : restore
        ? '，设备已恢复正常运行'
        : ''
  return {
    ok: true,
    message: `${verb}设备 ${decision.deviceCode} 判定为「${input.advice}」${suffix}`,
    decision,
  }
}
