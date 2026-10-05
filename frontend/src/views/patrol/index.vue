<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>巡查排查管理</h2>
        <p class="page-desc">维护巡查记录；监测设备报修确认后自动生成现场核验任务，同一台设备未闭环的核验任务只保留一个。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡查记录</button>
        <button class="btn" type="button" @click="exportRows">导出巡查排查清单</button>
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
      <span class="legend-item legend-accent">报修核验待办：{{ openVerifyCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item filter-check">
        <input v-model="onlyVerify" type="checkbox" />
        <span>只看报修核验任务</span>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>任务来源</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visibleRows" :key="String(row.id)" :class="{ 'verify-row': isVerifyTask(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span v-if="isVerifyTask(row)" class="source-tag tag-verify">报修核验</span>
            <span v-else class="console-sub">日常巡查</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!visibleRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无巡查排查数据，可先登记巡查记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ visibleRows.length }} / {{ total }} 条巡查排查记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  filterRows,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ["巡查编号", "隐患点编号", "巡查日期", "巡查人员", "巡查范围", "发现异常", "处置措施", "巡查状态"]
const actions = ["完成巡查", "报告异常", "确认处置"]
const statuses = ["待巡查", "已巡查", "发现异常", "已处置"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const onlyVerify = ref(false)

function isVerifyTask(row: EntryRow): boolean {
  return String(row['任务来源'] ?? '') === '报修核验'
}

const visibleRows = computed(() => {
  const matched = filterRows(rows.value, filters.value)
  return onlyVerify.value ? matched.filter(isVerifyTask) : matched
})

const stats = computed(() => [
  { label: "巡查记录总数", value: rows.value.length },
  { label: "发现异常数", value: rows.value.filter((row) => String(row.status) === '发现异常').length },
  { label: "待处置数", value: rows.value.filter((row) => String(row.status) !== '已处置' && !isVerifyTask(row)).length },
  { label: "报修核验待办", value: openVerifyCount.value },
])

const openVerifyCount = computed(
  () => rows.value.filter((row) => isVerifyTask(row) && String(row.status) !== '已处置').length,
)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  onlyVerify.value = false
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡查记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, {})
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡查排查列表读取失败'
  }
}

onMounted(reload)
</script>
