<template>
  <section class="page" data-module="device">
    <header class="page-head">
      <div>
        <h2>监测设备管理 · 维护判定台</h2>
        <p class="page-desc">按设备类型、电池余量、通讯中断时长、维护周期与所属隐患点自动给出正常、巡检、报修或停用建议；人工改判须填写理由，停用设备须报修修复后方可重新启用。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记监测设备</button>
        <button class="btn" type="button" @click="exportRows">导出监测设备清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-accent">报修待核验：{{ openVerifyCount }}</span>
    </p>

    <!-- 维护判定台 -->
    <div class="console">
      <div class="console-head">
        <div>
          <strong>维护判定台</strong>
          <span class="console-sub">
            自动阈值仅供参考；人工结论与自动结论冲突时以人工判定为准并强制留痕，重复判定只保留一个有效结果。
          </span>
        </div>
        <div class="console-tools">
          <span class="console-sub">最近判定：{{ evaluatedAt || '未执行' }}</span>
          <button class="btn" type="button" @click="runEvaluation">重新执行阈值判定</button>
          <button class="btn ghost" type="button" @click="showThresholds = !showThresholds">
            {{ showThresholds ? '收起阈值配置' : '阈值配置' }}
          </button>
          <button class="btn ghost" type="button" @click="showRecords = !showRecords">
            {{ showRecords ? '收起判定记录' : '判定记录' }}
          </button>
        </div>
      </div>

      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <label class="filter-item">
          <span>自动建议</span>
          <select v-model="adviceFilter">
            <option value="">全部</option>
            <option v-for="advice in adviceLevels" :key="advice" :value="advice">{{ advice }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>设备状态</span>
          <select v-model="statusFilter">
            <option value="">全部</option>
            <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <div v-if="showThresholds" class="threshold-panel">
        <h4>自动判定阈值（按设备类型区分，类型项留空则继承全局默认）</h4>
        <div class="threshold-table-wrap">
          <table class="data-table threshold-table">
            <thead>
              <tr>
                <th>适用范围</th>
                <th>电池·巡检 ≤%</th>
                <th>电池·报修 ≤%</th>
                <th>中断·巡检 ≥h</th>
                <th>中断·报修 ≥h</th>
                <th>维护·巡检 ≥天</th>
                <th>维护·报修 ≥天</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>全局默认</strong></td>
                <td v-for="key in thresholdKeys" :key="key">
                  <input v-model.number="thresholdDraft.global[key]" type="number" min="0" class="threshold-input" />
                </td>
                <td><span class="console-sub">基线</span></td>
              </tr>
              <tr v-for="deviceType in deviceTypes" :key="deviceType">
                <td>{{ deviceType }}</td>
                <td v-for="key in thresholdKeys" :key="key">
                  <input
                    v-model="typeDraft[deviceType][key]"
                    type="number"
                    class="threshold-input"
                    :placeholder="String(thresholdDraft.global[key])"
                  />
                </td>
                <td><button class="link" type="button" @click="clearTypeThreshold(deviceType)">清除类型差异</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="threshold-actions">
          <button class="btn primary" type="button" @click="persistThresholds">保存阈值并重判</button>
          <button class="btn ghost" type="button" @click="resetThresholds">恢复出厂阈值</button>
        </div>
      </div>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th style="min-width: 220px">自动阈值建议</th>
            <th>当前有效判定</th>
            <th style="min-width: 200px">维护操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in visibleRows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
            <td>
              <span :class="['status-badge', statusClass(normalizeStatus(String(row.status)))]">
                {{ normalizeStatus(String(row.status)) }}
              </span>
            </td>
            <td>
              <div class="advice-cell">
                <span :class="['advice-badge', adviceClass(evaluationOf(row)?.advice ?? null)]">
                  {{ evaluationOf(row)?.advice ?? '—' }}
                </span>
                <ul v-if="evaluationOf(row)?.reasons.length" class="reason-list">
                  <li v-for="(reason, idx) in evaluationOf(row)?.reasons" :key="idx">{{ reason }}</li>
                </ul>
                <span v-else class="console-sub">各项指标正常</span>
              </div>
            </td>
            <td>
              <template v-if="effectiveMap.get(Number(row.id))">
                <span :class="['advice-badge', adviceClass(effectiveMap.get(Number(row.id))!.effectiveAdvice)]">
                  {{ effectiveMap.get(Number(row.id))!.effectiveAdvice }}
                </span>
                <span :class="['source-tag', effectiveMap.get(Number(row.id))!.conflict ? 'tag-manual' : 'tag-auto']">
                  {{ effectiveMap.get(Number(row.id))!.conflict ? '人工改判' : '与自动一致' }}
                </span>
              </template>
              <span v-else class="console-sub">尚未判定</span>
            </td>
            <td class="row-actions">
              <button
                v-for="option in nextOptions(String(row.status))"
                :key="option.advice"
                class="link"
                type="button"
                @click="openDecision(row, option.advice)"
              >
                {{ option.label }}
              </button>
            </td>
          </tr>
          <tr v-if="!visibleRows.length">
            <td :colspan="columns.length + 4" class="empty-state">暂无符合条件的监测设备</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showRecords" class="console record-panel">
      <h4>判定记录（每台设备仅最新一条为有效，历史结论保留可查）</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>设备编号</th>
            <th>自动结论</th>
            <th>生效结论</th>
            <th>是否冲突</th>
            <th>判定理由</th>
            <th>核验任务</th>
            <th>操作人</th>
            <th>提交时间</th>
            <th>记录状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="decision in decisions" :key="decision.id">
            <td>{{ decision.deviceCode }}</td>
            <td><span :class="['advice-badge', adviceClass(decision.autoAdvice)]">{{ decision.autoAdvice }}</span></td>
            <td><span :class="['advice-badge', adviceClass(decision.effectiveAdvice)]">{{ decision.effectiveAdvice }}</span></td>
            <td>{{ decision.conflict ? '是（人工优先）' : '否' }}</td>
            <td class="reason-cell">{{ decision.reason }}</td>
            <td>{{ decision.verificationTaskCode ?? '—' }}</td>
            <td>{{ decision.operator }}</td>
            <td>{{ decision.submittedAt }}</td>
            <td>{{ decision.status }}</td>
          </tr>
          <tr v-if="!decisions.length">
            <td colspan="9" class="empty-state">暂无判定记录，在上方对设备提交维护判定后生成</td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="page-foot">
      <span>共 {{ visibleRows.length }} / {{ total }} 台监测设备</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 人工判定弹窗 -->
    <div v-if="decisionTarget" class="modal-mask" @click.self="closeDecision">
      <div class="modal">
        <h3>维护判定 · {{ decisionTarget['设备编号'] }}</h3>
        <dl class="modal-meta">
          <div><dt>设备类型</dt><dd>{{ decisionTarget['设备类型'] }}</dd></div>
          <div><dt>所属隐患点</dt><dd>{{ decisionTarget['所属隐患点'] }}</dd></div>
          <div><dt>电池余量</dt><dd>{{ decisionTarget['电池余量'] }}</dd></div>
          <div><dt>通讯中断</dt><dd>{{ decisionTarget['通讯中断时长'] }}</dd></div>
          <div>
            <dt>维护基准日</dt>
            <dd>
              {{ decisionEvaluation?.maintenanceDate ?? '无记录' }}
              <span class="console-sub">（{{ decisionEvaluation?.maintenanceDateSource }}）</span>
            </dd>
          </div>
          <div><dt>当前状态</dt><dd>{{ normalizeStatus(String(decisionTarget.status)) }}</dd></div>
        </dl>
        <div class="auto-box">
          <p>
            自动阈值结论：
            <span :class="['advice-badge', adviceClass(decisionEvaluation?.advice ?? null)]">
              {{ decisionEvaluation?.advice ?? '—' }}
            </span>
          </p>
          <ul v-if="decisionEvaluation?.reasons.length" class="reason-list">
            <li v-for="(reason, idx) in decisionEvaluation?.reasons" :key="idx">{{ reason }}</li>
          </ul>
          <p v-else class="console-sub">各项指标均在阈值内，无自动触发事项。</p>
        </div>
        <fieldset class="advice-picker">
          <legend>提交判定结论（仅允许状态机内的流转）</legend>
          <label v-for="advice in adviceLevels" :key="advice" class="advice-option">
            <input
              v-model="decisionAdvice"
              type="radio"
              :value="advice"
              :disabled="!canTransit(normalizeStatus(String(decisionTarget.status)), advice)"
            />
            <span :class="['advice-badge', adviceClass(advice)]">{{ advice }}</span>
            <span v-if="!canTransit(normalizeStatus(String(decisionTarget.status)), advice)" class="console-sub">
              （当前状态不允许）
            </span>
          </label>
        </fieldset>
        <label class="reason-input">
          <span>
            判定理由{{ requiresReason ? '' : '（与自动结论一致，可只填确认意见）' }}
            <em v-if="requiresReason" class="required">*人工改判必填</em>
          </span>
          <textarea v-model="decisionReason" rows="3" placeholder="人工改判必须说明依据，例如：现场核实为太阳能板遮挡导致低电量，已清理"></textarea>
        </label>
        <p v-if="decisionAdvice === '报修'" class="console-sub">确认报修后，巡查排查页将生成（或复用未闭环的）现场核验任务。</p>
        <p v-if="decisionTarget && normalizeStatus(String(decisionTarget.status)) === '待维修' && decisionAdvice === '正常'" class="console-sub">
          修复确认后设备恢复正常运行，最近维护日自动更新为今天。
        </p>
        <p v-if="modalError" class="error-text">{{ modalError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDecision">取消</button>
          <button class="btn primary" type="button" @click="confirmDecision">确认提交判定</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { listRows, resetRows, saveRows } from '@/data/local-store'
import {
  ADVICE_DEVICE_STATUS,
  ADVICE_ORDER,
  DEFAULT_THRESHOLDS,
  canTransit,
  evaluateAll,
  listDecisions,
  loadThresholds,
  normalizeStatus,
  saveThresholds,
  submitDecision,
  type Advice,
  type DecisionRecord,
  type Evaluation,
  type ThresholdConfig,
  type ThresholdRule,
} from '@/data/maintenance'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const meta = moduleMeta('device')
const columns = ['设备编号', '设备类型', '所属隐患点', '安装日期', '最近维护日', '电池余量', '通讯状态', '通讯中断时长']
const statuses = ['正常运行', '巡检中', '待维修', '已停用']
const adviceLevels = ADVICE_ORDER

// 状态机允许的正向操作；停用设备只能先走报修，经修复确认后才能重新开机
function nextOptions(current: string): { label: string; advice: Advice }[] {
  const normalized = normalizeStatus(current)
  const raw: { label: string; advice: Advice }[] = [
    { label: '提交巡检', advice: '巡检' },
    { label: normalized === '已停用' ? '停用设备报修' : '报修设备', advice: '报修' },
    { label: '修复确认', advice: '正常' },
    { label: '停用设备', advice: '停用' },
  ]
  // 只展示真正发生状态流转、且状态机允许的动作（同状态不重复出现）
  return raw.filter(
    (option) =>
      ADVICE_DEVICE_STATUS[option.advice] !== normalized && canTransit(normalized, ADVICE_DEVICE_STATUS[option.advice]),
  )
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusFilter = ref('')
const adviceFilter = ref('')
const evaluations = ref<Map<number, Evaluation>>(new Map())
const effectiveMap = ref<Map<number, DecisionRecord>>(new Map())
const decisions = ref<DecisionRecord[]>([])
const thresholdConfig = ref<ThresholdConfig>(loadThresholds())
const evaluatedAt = ref('')
const showThresholds = ref(false)
const showRecords = ref(false)

const thresholdKeys: (keyof ThresholdRule)[] = [
  'batteryWarn',
  'batteryFault',
  'outageWarn',
  'outageFault',
  'maintainWarn',
  'maintainFault',
]

const thresholdDraft = reactive<{ global: ThresholdRule }>({
  global: { ...thresholdConfig.value.global },
})
const typeDraft = reactive<Record<string, Partial<ThresholdRule>>>({})

const deviceTypes = computed(() => [...new Set(rows.value.map((row) => String(row['设备类型'] ?? '其他')))].sort())

function hydrateThresholdDraft() {
  Object.assign(thresholdDraft.global, thresholdConfig.value.global)
  for (const key of Object.keys(typeDraft)) delete typeDraft[key]
  for (const deviceType of deviceTypes.value) {
    typeDraft[deviceType] = { ...(thresholdConfig.value.byType[deviceType] ?? {}) }
  }
}

const stats = computed(() => [
  { label: '设备总数', value: rows.value.length },
  { label: '正常运行数', value: countByStatus('正常运行') },
  { label: '巡检中数', value: countByStatus('巡检中') },
  { label: '待维修数', value: countByStatus('待维修') },
  { label: '已停用数', value: countByStatus('已停用') },
])

function countByStatus(status: string): number {
  return rows.value.filter((row) => normalizeStatus(String(row.status)) === status).length
}

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: countByStatus(status) })),
)

const openVerifyCount = computed(
  () =>
    listRows('patrol').filter(
      (row) => String(row['任务来源'] ?? '') === '报修核验' && String(row.status) !== '已处置',
    ).length,
)

function evaluationOf(row: EntryRow): Evaluation | undefined {
  return evaluations.value.get(Number(row.id))
}

const visibleRows = computed(() => {
  const result = listEntries(meta.key, filters.value).items
  return result.filter((row) => {
    if (statusFilter.value && normalizeStatus(String(row.status)) !== statusFilter.value) return false
    if (adviceFilter.value && evaluationOf(row)?.advice !== adviceFilter.value) return false
    return true
  })
})

// 升级前 localStorage 里的旧设备数据缺「通讯中断时长」且字段为占位文本，整表换成新种子
function migrateLegacyRows() {
  const current = listRows(meta.key)
  const legacyStructure =
    current.length > 0 &&
    current.some((row) =>
      ['信号异常', '低电量'].includes(String(row.status)) ||
      !('通讯中断时长' in row) ||
      /样例/.test(String(row['设备类型'] ?? '')),
    )
  if (legacyStructure) {
    resetRows(meta.key)
    return
  }
  // 旧状态（信号异常/低电量）归并到巡检中，纳入新状态机
  let changed = false
  const next = current.map((row) => {
    const normalized = normalizeStatus(String(row.status))
    if (normalized !== String(row.status)) {
      changed = true
      return { ...row, status: normalized, 设备状态: normalized }
    }
    return row
  })
  if (changed) saveRows(meta.key, next)
}

function runEvaluation() {
  evaluations.value = evaluateAll(thresholdConfig.value)
  const now = new Date()
  evaluatedAt.value = `${now.toTimeString().slice(0, 5)}`
}

function reloadDecisions() {
  const all = listDecisions()
  decisions.value = [...all].sort((a, b) => b.id - a.id)
  const map = new Map<number, DecisionRecord>()
  for (const decision of all) {
    if (decision.status === '有效') map.set(decision.deviceId, decision)
  }
  effectiveMap.value = map
}

function resetFilters() {
  filters.value = {}
  statusFilter.value = ''
  adviceFilter.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '监测设备登记入口尚未接入审批流'
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, {})
    rows.value = payload.items
    total.value = payload.total
    hydrateThresholdDraft()
    runEvaluation()
    reloadDecisions()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '监测设备列表读取失败'
  }
}

// ---------- 阈值配置 ----------

function persistThresholds() {
  const global = { ...DEFAULT_THRESHOLDS, ...thresholdDraft.global }
  // 清空输入时 v-model 会给空串，统一回退到默认值，避免阈值被写成 NaN
  for (const key of thresholdKeys) {
    if (typeof global[key] !== 'number' || !Number.isFinite(global[key])) {
      global[key] = DEFAULT_THRESHOLDS[key]
    }
  }
  const byType: Record<string, Partial<ThresholdRule>> = {}
  for (const deviceType of deviceTypes.value) {
    const draft = typeDraft[deviceType] ?? {}
    const override: Partial<ThresholdRule> = {}
    for (const key of thresholdKeys) {
      const value = draft[key]
      if (typeof value === 'number' && Number.isFinite(value) && value !== global[key]) {
        override[key] = value
      }
    }
    if (Object.keys(override).length) byType[deviceType] = override
  }
  thresholdConfig.value = { global, byType }
  saveThresholds(thresholdConfig.value)
  runEvaluation()
  errorMessage.value = ''
}

function clearTypeThreshold(deviceType: string) {
  typeDraft[deviceType] = {}
}

function resetThresholds() {
  Object.assign(thresholdDraft.global, DEFAULT_THRESHOLDS)
  for (const deviceType of Object.keys(typeDraft)) typeDraft[deviceType] = {}
}

// ---------- 人工判定弹窗 ----------

const decisionTarget = ref<EntryRow | null>(null)
const decisionAdvice = ref<Advice>('巡检')
const decisionReason = ref('')
const modalError = ref('')

const decisionEvaluation = computed(() =>
  decisionTarget.value ? evaluations.value.get(Number(decisionTarget.value.id)) : undefined,
)

const requiresReason = computed(() => decisionAdvice.value !== decisionEvaluation.value?.advice)

function openDecision(row: EntryRow, advice: Advice) {
  decisionTarget.value = row
  decisionAdvice.value = advice
  decisionReason.value = ''
  modalError.value = ''
}

function closeDecision() {
  decisionTarget.value = null
  modalError.value = ''
}

function confirmDecision() {
  if (!decisionTarget.value) return
  modalError.value = ''
  const result = submitDecision({
    deviceId: Number(decisionTarget.value.id),
    advice: decisionAdvice.value,
    reason: decisionReason.value,
    operator: session.operator,
  })
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  closeDecision()
  reload()
}

// ---------- 展示样式 ----------

function adviceClass(advice: Advice | null): string {
  return advice ? `advice-${advice}` : 'advice-none'
}

function statusClass(status: string): string {
  const entry = Object.entries(ADVICE_DEVICE_STATUS).find(([, value]) => value === status)
  return entry ? `advice-${entry[0]}` : 'advice-none'
}

onMounted(() => {
  migrateLegacyRows()
  reload()
})
</script>
