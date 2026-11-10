/**
 * task-24 接线测试（全部在临时目录跑，不碰真实 ~/.dsh/cordis.patch.yml）：
 * 1. Config 含 volatile maxMembers 且被宿主 describe 门禁条件覆盖（fake ctx 断言可达）。
 * 2. 面板写入通路 applyMemberLimitConfig / 桥接 syncMemberLimitFromConfig 真的接回 setMemberLimit，
 *    非法值与失败原文都不被吞。
 * 3. 回写状态走 readMemberLimit 的真实来源，未写入时不得用 Config 默认值冒充当前值。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Config,
  DEFAULT_MAX_MEMBERS,
  MAX_MEMBER_LIMIT,
  applyMemberLimitConfig,
  liveConfig,
  resetMemberLimitBridge,
  syncMemberLimitFromConfig,
} from '../index.js'

const NS = 'dsh-force-subagent'

/** 临时 agent-team patch 文件。 */
function scratch(text) {
  const dir = mkdtempSync(join(tmpdir(), 'fsx-wire-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, text)
  return { dir, file, cleanup: () => { chmodSync(dir, 0o755); rmSync(dir, { recursive: true, force: true }) } }
}

const patchWith = (limit) => `- id: agent-team\n  config:\n    maxMembers: ${limit}\n`

/** 可写运行时的假服务（roster.maxMembers 是普通可写自有属性）。 */
const writableService = (limit) => ({ roster: { maxMembers: limit } })

/** 带 settings.describe/update 与 logger 的假 ctx；settings.update 把补丁写回 describe 行以模拟宿主。 */
function fakeCtx({ describeValue, settingsAvailable = true } = {}) {
  const warnings = []
  const updateCalls = []
  const rows = [{ ns: NS, value: describeValue }]
  const settings = settingsAvailable
    ? {
        describe: () => rows,
        update: (ns, patch) => {
          updateCalls.push({ ns, patch })
          const merged = Object.assign({}, rows[0].value, patch)
          rows[0] = { ns, value: merged }
          return Promise.resolve()
        },
      }
    : undefined
  const services = { settings }
  const ctx = {
    logger: { warn: (m) => warnings.push(m) },
    get: (name) => services[name],
    on: () => () => {},
  }
  return { ctx, warnings, updateCalls, rows }
}

const opts = (file, service) => ({ file, service, layers: [{ file, label: 'home-patch' }] })

/* ────────────────────────── 1. Config volatile + describe 暴露 ────────────────────────── */

test('Config 暴露 volatile maxMembers：根 volatile、number 字段带 1..1000 值域、状态字段齐备', () => {
  const json = Config.toJSON()
  const root = json.refs[json.uid]
  assert.equal(root.meta.volatile, true, '根必须 volatile（宿主 describe 门禁前提）')
  const serialized = JSON.stringify(json)
  assert.ok(serialized.includes('maxMembers'), 'Config 必须含 maxMembers 字段')
  assert.ok(serialized.includes('maxMembersStatus'), 'Config 必须含回读状态字段')
  const ranged = Object.values(json.refs).find((ref) => ref && ref.type === 'number'
    && ref.meta && ref.meta.min === 1 && ref.meta.max === MAX_MEMBER_LIMIT)
  assert.ok(ranged, 'maxMembers 必须是带 1..1000 值域的 number 字段')
  assert.equal(ranged.meta.default, DEFAULT_MAX_MEMBERS, '默认值须等于宿主内置默认，不得凭空写数')
})

test('describe 暴露可达：liveConfig 从 describe 行读到刚写入的 maxMembers', () => {
  const { ctx } = fakeCtx({ describeValue: { enabled: true, mode: 'nested', workspaces: {}, maxMembers: 42 } })
  const value = liveConfig(ctx, undefined)
  assert.equal(value.maxMembers, 42, '命名空间已 volatile，面板写入的 maxMembers 必须被读回')
})

/* ────────────────────────── 2. 写通路接回 setMemberLimit，不吞错 ────────────────────────── */

test('applyMemberLimitConfig：写路径真的落盘 + 运行时改写，来源走 readMemberLimit', () => {
  const { file, cleanup } = scratch(patchWith(8))
  try {
    const service = writableService(8)
    const { ctx } = fakeCtx({ describeValue: {} })
    const result = applyMemberLimitConfig(ctx, 42, opts(file, service))
    assert.equal(result.ok, true)
    assert.equal(result.limit, 42)
    assert.match(readFileSync(file, 'utf8'), /maxMembers: 42/, '必须经 setMemberLimit 真的写入文件')
    assert.equal(service.roster.maxMembers, 42, '运行时必须被改写')
    assert.equal(result.status.state, 'applied')
    assert.equal(result.status.limit, 42, '回读值来自 readMemberLimit，不是 Config 默认值')
    assert.equal(result.status.source, 'service', '来源必须是运行中的服务')
  } finally {
    cleanup()
  }
})

test('applyMemberLimitConfig：非法取值被 setMemberLimit 拒绝，错误原文透传且文件不动', () => {
  const { file, cleanup } = scratch(patchWith(8))
  try {
    const service = writableService(8)
    const { ctx } = fakeCtx({ describeValue: {} })
    const bad = applyMemberLimitConfig(ctx, 'abc', opts(file, service))
    assert.equal(bad.ok, false, '非法值必须失败，不得返回成功')
    assert.ok(bad.error.includes('整数'), '必须带 setMemberLimit 的错误原文')
    assert.equal(bad.status, undefined, '失败不得伪造回读状态')
    assert.match(readFileSync(file, 'utf8'), /maxMembers: 8/, '非法值不得改动文件')

    const over = applyMemberLimitConfig(ctx, String(MAX_MEMBER_LIMIT + 1), opts(file, service))
    assert.equal(over.ok, false)
    assert.ok(over.error.includes(String(MAX_MEMBER_LIMIT)), '越界必须点名护栏上限')
    assert.match(readFileSync(file, 'utf8'), /maxMembers: 8/, '越界不得改动文件')
  } finally {
    cleanup()
  }
})

test('桥接：面板写入经 document-updated 语义接回 setMemberLimit，并把状态写回配置、去重不打转', async () => {
  resetMemberLimitBridge()
  const { file, cleanup } = scratch(patchWith(8))
  try {
    const service = writableService(8)
    const { ctx, updateCalls } = fakeCtx({ describeValue: { enabled: true, maxMembers: 42 } })
    const first = await syncMemberLimitFromConfig(ctx, opts(file, service))
    assert.equal(first.ok, true)
    assert.match(readFileSync(file, 'utf8'), /maxMembers: 42/, '桥接必须把面板写入接回 setMemberLimit 落盘')
    assert.equal(updateCalls.length, 1, '必须把结果回写进配置命名空间供面板回读')
    assert.equal(updateCalls[0].ns, NS)
    assert.equal(updateCalls[0].patch.maxMembersStatus.state, 'applied')
    assert.equal(updateCalls[0].patch.maxMembersStatus.source, 'service', '回写状态来源必须真实')

    const second = await syncMemberLimitFromConfig(ctx, opts(file, service))
    assert.equal(second.noop, true, '同一写入不得重复处理（回写状态触发的再入必须被去重）')
    assert.equal(updateCalls.length, 1, '去重后不得再回写')
  } finally {
    cleanup()
  }
})

test('桥接不吞错：setMemberLimit 失败时如实返回失败且不写成功状态', async () => {
  resetMemberLimitBridge()
  const { file, cleanup } = scratch(patchWith(8))
  try {
    const service = writableService(8)
    const { ctx, updateCalls } = fakeCtx({ describeValue: { maxMembers: MAX_MEMBER_LIMIT + 1 } })
    const result = await syncMemberLimitFromConfig(ctx, opts(file, service))
    assert.equal(result.ok, false, '写入失败必须如实返回，不得被吞成成功')
    assert.ok(result.error.includes(String(MAX_MEMBER_LIMIT)))
    assert.equal(updateCalls.length, 0, '失败不得回写一个成功的状态欺骗面板')
    assert.match(readFileSync(file, 'utf8'), /maxMembers: 8/, '失败不得改动文件')
  } finally {
    cleanup()
  }
})

/* ────────────────────────── 3. 载入初读：未写入时不得用 Config 默认值冒充 ────────────────────────── */

test('桥接前未写入：面板回读状态来自 describe 行的真实值，不是 Config 默认值', async () => {
  const { file, cleanup } = scratch(patchWith(8))
  try {
    const service = writableService(8)
    const { ctx, updateCalls } = fakeCtx({ describeValue: { maxMembers: 30 } })
    resetMemberLimitBridge()
    const result = await syncMemberLimitFromConfig(ctx, opts(file, service))
    assert.equal(result.ok, true)
    assert.equal(result.status.requested, 30, '写入目标必须来自面板写入的 30，而不是内置默认')
    assert.equal(result.status.source, 'service', '回读来源必须点名真实来源层')
    assert.match(readFileSync(file, 'utf8'), /maxMembers: 30/, '写入必须落到 agent-team 条目')
    assert.equal(updateCalls[0].patch.maxMembersStatus.limit, 30, '回写状态里的当前值必须来自回读')
  } finally {
    cleanup()
  }
})
