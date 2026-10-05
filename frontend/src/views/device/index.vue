<template>
  <section class="page" data-module="device">
    <header class="page-head">
      <div>
        <h2>监测设备管理</h2>
        <p class="page-desc">维护监测设备，围绕设备编号、设备类型、所属隐患点、安装日期做登记、筛选与状态流转。</p>
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
    </p>

    <section class="judge-panel">
      <div class="judge-head">
        <h3>维护判定台</h3>
        <label class="judge-operator">
          <span>判定人</span>
          <input v-model="operator" placeholder="判定人姓名" />
        </label>
      </div>
      <p class="judge-note">
        自动判定按设备类型维护周期、电池余量、通讯中断时长和所属隐患点状态给出「正常 / 巡检 / 报修 / 停用」建议，
        旧设备缺最近维护日时按安装日期兼容。人工改判须填写理由；与自动阈值冲突时以人工结论为准，自动依据保留备查。
        设备状态固定按 正常运行 → 待巡检 → 待维修 → 确认修复恢复 流转，停用后不能直接开机；
        确认修复后会在巡查排查页生成核验任务，每台设备只保留一条有效判定。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>设备编号</th>
            <th>设备类型</th>
            <th>电池余量</th>
            <th>通讯中断(小时)</th>
            <th>维护参考日</th>
            <th>所属隐患点</th>
            <th>自动判定</th>
            <th>判定依据</th>
            <th>有效判定</th>
            <th>判定操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="item in judgments" :key="item.code">
            <tr>
              <td>{{ item.code }}</td>
              <td>{{ item.type }}</td>
              <td>{{ item.battery }}</td>
              <td>{{ item.offlineHours }}</td>
              <td>{{ item.reference }}</td>
              <td>{{ item.hazard }}</td>
              <td><span class="judge-tag" :class="tagClass(item.auto)">{{ item.auto }}</span></td>
              <td>{{ item.reasons }}</td>
              <td>
                <template v-if="item.effective">
                  <span class="judge-tag" :class="tagClass(item.effective.final)">{{ item.effective.final }}</span>
                  <span v-if="item.effective.manual" class="judge-flag">人工</span>
                  <span v-if="item.effective.conflict" class="judge-conflict">冲突·人工优先</span>
                </template>
                <span v-else class="muted">未判定</span>
              </td>
              <td class="row-actions">
                <button class="link" type="button" @click="confirmAuto(item)">采纳自动判定</button>
                <button class="link" type="button" @click="openOverride(item)">人工改判</button>
              </td>
            </tr>
            <tr v-if="overrideTarget === item.code" class="judge-editor">
              <td colspan="10">
                <form @submit.prevent="submitOverride(item)">
                  <label>
                    <span>改判结论</span>
                    <select v-model="overrideConclusion">
                      <option v-for="option in conclusions" :key="option" :value="option">{{ option }}</option>
                    </select>
                  </label>
                  <label class="judge-editor-reason">
                    <span>改判理由（必填）</span>
                    <input v-model="overrideReason" placeholder="说明改判依据，随判定记录留痕" />
                  </label>
                  <button class="btn primary" type="submit">提交改判</button>
                  <button class="btn ghost" type="button" @click="cancelOverride">取消</button>
                </form>
              </td>
            </tr>
          </template>
          <tr v-if="!judgments.length">
            <td colspan="10" class="empty-state">暂无监测设备，无法判定</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="judgmentRecords.length" class="judge-records">
      <h3>判定记录</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>判定编号</th>
            <th>设备编号</th>
            <th>判定方式</th>
            <th>自动判定</th>
            <th>人工判定</th>
            <th>改判理由</th>
            <th>最终判定</th>
            <th>判定人</th>
            <th>判定时间</th>
            <th>记录状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in judgmentRecords" :key="String(record.id)">
            <td>{{ record['判定编号'] }}</td>
            <td>{{ record['设备编号'] }}</td>
            <td>{{ record['判定方式'] }}</td>
            <td>{{ record['自动判定'] }}</td>
            <td>{{ record['人工判定'] || '—' }}</td>
            <td>{{ record['改判理由'] || '—' }}</td>
            <td>{{ record['最终判定'] }}</td>
            <td>{{ record['判定人'] }}</td>
            <td>{{ record['判定时间'] }}</td>
            <td>{{ record.status }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableDeviceActions(String(row.status))"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无监测设备数据，可先登记监测设备</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条监测设备记录</span>
      <span v-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  JUDGE_CONCLUSIONS,
  applyDeviceAction,
  availableDeviceActions,
  confirmAutoJudgment,
  judgeDevice,
  listJudgments,
  overrideJudgment,
} from '@/api/device-maintenance'
import type { JudgeConclusion } from '@/api/device-maintenance'
import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('device')
const columns = ["设备编号", "设备类型", "所属隐患点", "安装日期", "最近维护日", "电池余量", "通讯状态", "通讯中断时长", "设备状态"]
const statuses = ["正常运行", "待巡检", "待维修", "已停用"]
const stats = [{"label": "设备总数", "value": 0}, {"label": "正常运行数", "value": 0}, {"label": "待维修数", "value": 0}]
const conclusions = JUDGE_CONCLUSIONS

const rows = ref<EntryRow[]>([])
const allDevices = ref<EntryRow[]>([])
const judgmentRecords = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const operator = ref('值班员')
const overrideTarget = ref('')
const overrideConclusion = ref<JudgeConclusion>('正常')
const overrideReason = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 判定台看全部设备（不受下方筛选条件影响），有效判定取自判定记录。
const judgments = computed(() =>
  allDevices.value.map((row) => {
    const judgment = judgeDevice(row)
    const code = String(row['设备编号'] ?? '')
    const effective = judgmentRecords.value.find(
      (record) => String(record['设备编号']) === code && record.status === '有效',
    )
    return {
      id: Number(row.id),
      code,
      type: String(row['设备类型'] ?? '—'),
      battery: String(row['电池余量'] ?? '—'),
      offlineHours: String(row['通讯中断时长'] ?? '—'),
      reference: judgment.referenceDate ? `${judgment.referenceDate}（按${judgment.referenceSource}）` : '—',
      hazard: judgment.hazardStatus
        ? `${String(row['所属隐患点'] ?? '—')}（${judgment.hazardStatus}）`
        : String(row['所属隐患点'] ?? '—'),
      auto: judgment.conclusion,
      reasons: judgment.reasons.join('；'),
      effective: effective
        ? {
            final: String(effective['最终判定']) as JudgeConclusion,
            manual: String(effective['判定方式']) === '人工改判',
            conflict: Boolean(effective.abnormal),
          }
        : null,
    }
  }),
)

function tagClass(conclusion: JudgeConclusion): string {
  const map: Record<JudgeConclusion, string> = {
    正常: 'is-normal',
    巡检: 'is-inspect',
    报修: 'is-repair',
    停用: 'is-retire',
  }
  return map[conclusion] ?? ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '监测设备登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyDeviceAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function confirmAuto(item: { id: number }) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = confirmAutoJudgment(item.id, operator.value.trim())
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function openOverride(item: { code: string; auto: JudgeConclusion }) {
  overrideTarget.value = item.code
  overrideConclusion.value = item.auto
  overrideReason.value = ''
}

function cancelOverride() {
  overrideTarget.value = ''
  overrideReason.value = ''
}

function submitOverride(item: { id: number }) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = overrideJudgment(item.id, overrideConclusion.value, overrideReason.value, operator.value.trim())
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  cancelOverride()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    allDevices.value = listEntries(meta.key).items
    judgmentRecords.value = listJudgments()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '监测设备列表读取失败'
  }
}

onMounted(reload)
</script>
