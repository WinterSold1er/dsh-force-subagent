/**
 * 按工作区解析模型路由：workspaceKeyFor 的 5 个分支 + resolveRoute 覆盖/回退 +
 * resolveConfig 对 workspaces 的规范化。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  workspaceKeyFor, resolveRoute, resolveConfig, DEFAULT_CONFIG, DEFAULT_ROUTE,
} from '../index.js'

const WORKSPACES = [
  { id: 'ws-a', path: '/repo/a', title: 'a', sessionIds: ['s-a'] },
  { id: 'ws-b', path: '/repo/b', title: 'b', sessionIds: [] },
]

function createCtx({ list, sessions = {} } = {}) {
  const warnings = []
  const registry = list === undefined ? undefined : { list }
  const store = { get: (id) => sessions[id] }
  return {
    warnings,
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessions') return store
      return undefined
    },
    logger: { warn: (message) => warnings.push(message) },
  }
}

test('分支 a：session.id ∈ workspace.sessionIds → 用 path 作 key', () => {
  const ctx = createCtx({ list: () => WORKSPACES })
  assert.equal(workspaceKeyFor(ctx, { id: 's-a', header: {} }), '/repo/a')
})

test('分支 b：自身未登记，沿 header.parentSession 上溯命中顶层会话', () => {
  const ctx = createCtx({ list: () => WORKSPACES })
  const session = { id: 'child-1', header: { parentSession: 's-a' } }
  assert.equal(workspaceKeyFor(ctx, session), '/repo/a')
})

test('分支 b：跨两层上溯（需要 sessions.get 读取中间层）', () => {
  const ctx = createCtx({
    list: () => WORKSPACES,
    sessions: { mid: { id: 'mid', header: { parentSession: 's-a' } } },
  })
  const session = { id: 'grand', header: { parentSession: 'mid' } }
  assert.equal(workspaceKeyFor(ctx, session), '/repo/a')
})

test('分支 b：上溯遇到环不挂死（seen 防环）', () => {
  const ctx = createCtx({
    list: () => WORKSPACES,
    sessions: { loop: { id: 'loop', header: { parentSession: 'loop' } } },
  })
  const session = { id: 'child-2', header: { parentSession: 'loop' } }
  assert.equal(workspaceKeyFor(ctx, session), undefined)
})

test('分支 c：session.header.cwd 等于某个 workspace.path → 用该 workspace 的 key', () => {
  const ctx = createCtx({ list: () => WORKSPACES })
  const session = { id: 'unregistered', header: { cwd: '/repo/b' } }
  assert.equal(workspaceKeyFor(ctx, session), '/repo/b')
})

test('分支 d：cwd 未被任何 workspace 注册 → 把 cwd 本身当 key（按目录隔离）', () => {
  const ctx = createCtx({ list: () => WORKSPACES })
  const session = { id: 'unregistered-2', header: { cwd: '/repo/elsewhere' } }
  assert.equal(workspaceKeyFor(ctx, session), '/repo/elsewhere')
})

test('分支 e：既无 id 命中又无 cwd → undefined（回退全局默认）', () => {
  const ctx = createCtx({ list: () => WORKSPACES })
  assert.equal(workspaceKeyFor(ctx, { id: 'nobody', header: {} }), undefined)
  assert.equal(workspaceKeyFor(ctx, undefined), undefined)
})

test('workspaceRegistry 缺失：不抛，直接走 cwd 分支', () => {
  const ctx = createCtx({ list: undefined })
  const session = { id: 's-a', header: { cwd: '/repo/b' } }
  assert.equal(workspaceKeyFor(ctx, session), '/repo/b')
  assert.deepEqual(ctx.warnings, [], '服务缺失不是异常，不得 warn')
})

test('workspaceRegistry.list 抛错：fail-open 回退全局，且同一 ctx 只 warn 一次', () => {
  const ctx = createCtx({ list: () => { throw new Error('registry boom') } })
  const session = { id: 's-a', header: { cwd: '/repo/a' } }
  assert.equal(workspaceKeyFor(ctx, session), undefined)
  assert.equal(workspaceKeyFor(ctx, session), undefined)
  assert.equal(ctx.warnings.length, 1, `只能 warn 一次，实际 ${ctx.warnings.length} 次`)
  assert.match(ctx.warnings[0], /workspaceRegistry/)
})

test('workspace.path 为空时回退 String(id) 作 key', () => {
  const ctx = createCtx({ list: () => [{ id: 'ws-x', path: '', title: 'x', sessionIds: ['s-x'] }] })
  assert.equal(workspaceKeyFor(ctx, { id: 's-x', header: {} }), 'ws-x')
})

test('resolveRoute：工作区条目覆盖全局路由', () => {
  const settings = resolveConfig({
    member: { provider: 'g-p', model: 'g-m' },
    subagent: { provider: 'g-sp', model: 'g-sm' },
    workspaces: { '/repo/a': { member: { provider: 'w-p', model: 'w-m' }, subagent: { provider: 'w-sp', model: 'w-sm' } } },
  })
  assert.deepEqual(resolveRoute(settings, '/repo/a', 'member'), { provider: 'w-p', model: 'w-m' })
  assert.deepEqual(resolveRoute(settings, '/repo/a', 'subagent'), { provider: 'w-sp', model: 'w-sm' })
})

test('resolveRoute：key 未命中或为 undefined → 回退全局', () => {
  const settings = resolveConfig({ member: { provider: 'g-p', model: 'g-m' }, subagent: { provider: 'g-sp', model: 'g-sm' } })
  assert.deepEqual(resolveRoute(settings, '/repo/unknown', 'member'), { provider: 'g-p', model: 'g-m' })
  assert.deepEqual(resolveRoute(settings, undefined, 'subagent'), { provider: 'g-sp', model: 'g-sm' })
})

test('resolveRoute：工作区条目缺某类路由时该类回退全局', () => {
  const settings = resolveConfig({
    member: { provider: 'g-p', model: 'g-m' },
    workspaces: { '/repo/a': { subagent: { provider: 'w-sp', model: 'w-sm' } } },
  })
  assert.equal(resolveRoute(settings, '/repo/a', 'member').provider, DEFAULT_ROUTE.provider)
  assert.equal(resolveRoute(settings, '/repo/a', 'subagent').provider, 'w-sp')
})

test('resolveConfig：workspaces 条目规范化 + 非法条目被丢弃', () => {
  const value = resolveConfig({
    workspaces: {
      '/repo/a': { member: { provider: 'p1' } },
      '/repo/bad': 'nope',
    },
  })
  assert.deepEqual(Object.keys(value.workspaces), ['/repo/a'])
  assert.equal(value.workspaces['/repo/a'].member.provider, 'p1')
  assert.equal(value.workspaces['/repo/a'].member.model, DEFAULT_ROUTE.model, '缺字段回退默认')
  assert.equal(value.workspaces['/repo/a'].subagent.provider, DEFAULT_ROUTE.provider)
})

test('resolveConfig：旧配置无 workspaces 字段时向后兼容为 {}', () => {
  const value = resolveConfig({ enabled: false, member: { provider: 'old-p', model: 'old-m' } })
  assert.deepEqual(value.workspaces, {})
  assert.equal(value.enabled, false)
  assert.equal(value.member.provider, 'old-p')
})

test('resolveConfig：空 workspaces 对象保持空对象', () => {
  assert.deepEqual(resolveConfig({ workspaces: {} }).workspaces, {})
})

// ── reviewer（可选第三类路由）的解析链 ────────────────────────────────────────
// 契约：reviewer 优先 scoped.reviewer → settings.reviewer → undefined；member / subagent 判定口径不变。

const REVIEWER_GLOBAL = { provider: 'g-review-p', model: 'g-review-m' }
const REVIEWER_SCOPED_A = { provider: 'ws-a-review-p', model: 'ws-a-review-m' }
const REVIEWER_SCOPED_B = { provider: 'ws-b-review-p', model: 'ws-b-review-m' }

test('resolveRoute：reviewer 优先工作区条目，工作区条目没配 reviewer 时回退全局 reviewer', () => {
  const settings = resolveConfig({
    member: { provider: 'g-p', model: 'g-m' },
    subagent: { provider: 'g-sp', model: 'g-sm' },
    reviewer: REVIEWER_GLOBAL,
    workspaces: {
      '/repo/a': { reviewer: REVIEWER_SCOPED_A },
      '/repo/b': { member: { provider: 'b-p', model: 'b-m' }, subagent: { provider: 'b-sp', model: 'b-sm' } },
    },
  })
  assert.deepEqual(resolveRoute(settings, '/repo/a', 'reviewer'), REVIEWER_SCOPED_A, '工作区 reviewer 必须优先于全局 reviewer')
  assert.deepEqual(resolveRoute(settings, '/repo/b', 'reviewer'), REVIEWER_GLOBAL, '工作区条目存在但没配 reviewer → 全局 reviewer，不是该工作区的 member')
  assert.deepEqual(resolveRoute(settings, '/repo/unknown', 'reviewer'), REVIEWER_GLOBAL, 'key 未命中同样回退全局 reviewer')
  assert.deepEqual(resolveRoute(settings, undefined, 'reviewer'), REVIEWER_GLOBAL, 'key 为 undefined 时同样回退全局 reviewer')
})

test('resolveRoute：两级 reviewer 都没配时 reviewer 是 undefined；member / subagent 行为完全不变', () => {
  const settings = resolveConfig({
    member: { provider: 'g-p', model: 'g-m' },
    subagent: { provider: 'g-sp', model: 'g-sm' },
    workspaces: { '/repo/a': { member: { provider: 'w-p', model: 'w-m' } } },
  })
  assert.equal(resolveRoute(settings, '/repo/a', 'reviewer'), undefined, '未配置的 reviewer 不得凭空造出默认路由')
  assert.equal(resolveRoute(settings, '/repo/unknown', 'reviewer'), undefined)
  assert.equal(resolveRoute(settings, undefined, 'reviewer'), undefined)
  // 两类必选路由不受 reviewer 是否配置影响：口径与改动前一致。
  assert.deepEqual(resolveRoute(settings, '/repo/a', 'member'), { provider: 'w-p', model: 'w-m' })
  assert.deepEqual(resolveRoute(settings, '/repo/a', 'subagent'), DEFAULT_CONFIG.subagent, '工作区没配 subagent 时补默认，永不 undefined')
  assert.deepEqual(resolveRoute(settings, '/repo/unknown', 'member'), { provider: 'g-p', model: 'g-m' })
})

test('resolveRoute：settings 缺失时一律 undefined（调用方 fail-open 不注入）', () => {
  assert.equal(resolveRoute(undefined, '/repo/a', 'reviewer'), undefined)
  assert.equal(resolveRoute(null, '/repo/a', 'member'), undefined)
})

test('resolveConfig：reviewer 半残配置在解析阶段就被丢弃，不会漏进 resolveRoute；全局与工作区各告警一次', () => {
  const warnings = []
  const settings = resolveConfig({
    reviewer: { provider: 'half-p', model: '' },
    workspaces: { '/repo/half': { reviewer: { provider: '', model: 'half-m' } } },
  }, (message) => warnings.push(message))
  assert.equal(resolveRoute(settings, '/repo/half', 'reviewer'), undefined, '工作区半残 reviewer 不得注入')
  assert.equal(resolveRoute(settings, '/repo/other', 'reviewer'), undefined, '全局半残 reviewer 不得注入')
  assert.equal(warnings.filter((message) => /只配置了一半/.test(message)).length, 2, `全局与工作区条目各告警一次，实际 ${JSON.stringify(warnings)}`)
  assert.ok(warnings.some((message) => message.includes('/repo/half')), '工作区条目的告警必须点名是哪个工作区')
})

test('工作区 key 解析出的 key 与 reviewer 覆盖同源：沿 parentSession 上溯命中 /repo/b 时吃到该工作区的 reviewer', () => {
  const ctx = createCtx({
    list: () => [{ id: 'ws-b', path: '/repo/b', title: 'b', sessionIds: ['s-b'] }],
    sessions: { 's-b': { id: 's-b', header: {} } },
  })
  const settings = resolveConfig({ reviewer: REVIEWER_GLOBAL, workspaces: { '/repo/b': { reviewer: REVIEWER_SCOPED_B } } })
  const key = workspaceKeyFor(ctx, { id: 'child-b', header: { parentSession: 's-b' } })
  assert.equal(key, '/repo/b')
  assert.deepEqual(resolveRoute(settings, key, 'reviewer'), REVIEWER_SCOPED_B, '上溯得到的 key 必须与工作区覆盖用同一个 key')
  assert.deepEqual(resolveRoute(settings, key, 'member'), DEFAULT_CONFIG.member, '该工作区没配 member：member 落默认，与 reviewer 互不干扰')
})
