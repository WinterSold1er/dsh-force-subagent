/**
 * 激活时实时读取配置：describe 拉到新值就用新值，失败/缺失回退 apply 配置。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, liveConfig, resolveConfig } from '../index.js'

const ENTRY = 'dsh-force-subagent'
const ENABLE = { type: 'command/run', data: { name: 'using-agent-team', args: 'on' } }
const sessionOn = () => ({ events: [ENABLE] })

function createHost(mode) {
  const calls = []
  const warnings = []
  const subagents = {
    startActivation(spec) { calls.push(spec); return { ok: true } },
    getProvider: () => ({ capabilities: { agentOptions: true } }),
  }
  const services = {
    subagents,
    // apply 需要这两个服务，缺了会打「服务未就绪」告警，污染 warnings 断言。
    systemPrompt: { section: () => () => {} },
    commands: { register: () => {} },
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
  }
  if (mode !== 'missing') {
    services.settings = mode === 'throws'
      ? { describe() { throw new Error('describe boom') } }
      : { describe: () => mode }
  }
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (name) => services[name],
    on: () => {},
    effect: (factory) => factory(),
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: { uid: 'test-fiber' },
      settings: { configure: () => () => {} },
      logger: { warn: () => {} },
    }),
    fiber: { uid: 'test-fiber' },
  }
  return { ctx, calls, warnings }
}

const specOf = () => ({ provider: 'spawn', request: { parent: { session: sessionOn() }, agentOptions: {} } })

test('liveConfig 命中本命名空间时返回 describe 的值', () => {
  const rows = [{ ns: ENTRY, value: { member: { provider: 'live-p', model: 'live-m' } } }]
  const ctx = { get: () => ({ describe: () => rows }), logger: { warn: () => {} } }
  assert.deepEqual(liveConfig(ctx, { fallback: true }), rows[0].value)
})

test('liveConfig：settings 缺失 → 回退 apply 配置且不 warn', () => {
  const warnings = []
  const fallback = { member: { provider: 'fb-p', model: 'fb-m' } }
  const ctx = { get: () => undefined, logger: { warn: (m) => warnings.push(m) } }
  assert.deepEqual(liveConfig(ctx, fallback), fallback)
  assert.deepEqual(warnings, [])
})

test('liveConfig：describe 抛错 → 回退 apply 配置，且只 warn 一次', () => {
  const warnings = []
  const fallback = { member: { provider: 'fb-p', model: 'fb-m' } }
  const ctx = {
    get: () => ({ describe() { throw new Error('describe boom') } }),
    logger: { warn: (m) => warnings.push(m) },
  }
  assert.deepEqual(liveConfig(ctx, fallback), fallback)
  assert.deepEqual(liveConfig(ctx, fallback), fallback)
  assert.equal(warnings.length, 1, `must warn exactly once, got ${warnings.length}`)
  assert.match(warnings[0], /实时设置/)
})

test('liveConfig：describe 返回空对象视为用户清空，不回退', () => {
  const rows = [{ ns: ENTRY, value: {} }]
  const ctx = { get: () => ({ describe: () => rows }), logger: { warn: () => {} } }
  assert.deepEqual(liveConfig(ctx, { member: { provider: 'fb', model: 'fb' } }), {})
})

test('激活时用 describe 的最新路由，而不是 apply 时的旧配置', () => {
  const { ctx, calls, warnings } = createHost([{ ns: ENTRY, value: { member: { provider: 'live-p', model: 'live-m' }, subagent: { provider: 'live-sp', model: 'live-sm' } } }])
  apply(ctx, { member: { provider: 'apply-p', model: 'apply-m' }, subagent: { provider: 'apply-sp', model: 'apply-sm' } })
  ctx.get('subagents').startActivation(specOf())
  assert.equal(calls[0].request.agentOptions.provider, 'live-sp', '非成员走 subagent，必须用实时值')
  assert.equal(calls[0].request.agentOptions.model, 'live-sm')
  assert.deepEqual(warnings, [])
})

test('激活时 describe 抛错 → 回退 apply 配置', () => {
  const { ctx, calls } = createHost('throws')
  apply(ctx, { subagent: { provider: 'apply-sp', model: 'apply-sm' } })
  ctx.get('subagents').startActivation(specOf())
  assert.equal(calls[0].request.agentOptions.provider, 'apply-sp')
})

test('激活时 settings 缺失 → 回退 apply 配置', () => {
  const { ctx, calls } = createHost('missing')
  apply(ctx, { subagent: { provider: 'apply-sp', model: 'apply-sm' } })
  ctx.get('subagents').startActivation(specOf())
  assert.equal(calls[0].request.agentOptions.provider, 'apply-sp')
})

test('激活时 describe 返回空对象 → 不报错，走全局默认', () => {
  const { ctx, calls, warnings } = createHost([{ ns: ENTRY, value: {} }])
  apply(ctx, {})
  ctx.get('subagents').startActivation(specOf())
  assert.equal(typeof calls[0].request.agentOptions.provider, 'string', '空配置也要落一条合法路由')
  assert.deepEqual(warnings, [])
})
