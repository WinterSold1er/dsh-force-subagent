/**
 * 宿主自动设置页的关闭策略：延迟注入 settings，用插件自己的 fiber 关掉自动页；
 * settings 缺失或 configure 抛错都不得影响 apply 的其余部分（门禁必须照常注册）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

function createHost({ withSettings = true, configureThrows = false } = {}) {
  const warnings = []
  const effects = []
  const onCalls = []
  const configureCalls = []
  const fiber = { uid: 'fiber-under-test' }
  const settings = {
    configure(presentation, owner) {
      if (configureThrows) throw new Error('Settings presentation is already configured for this plugin instance')
      configureCalls.push({ presentation, owner, disposed: false })
      const record = configureCalls[configureCalls.length - 1]
      return () => { record.disposed = true }
    },
  }
  const services = {
    systemPrompt: { section: () => {} },
    commands: { register: () => {} },
    ...(withSettings ? { settings } : {}),
  }
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (name) => services[name],
    on: (name) => { onCalls.push(name) },
    effect: (factory, label) => {
      const dispose = factory()
      effects.push({ label, dispose })
      return dispose
    },
    inject: (deps, callback) => callback(ctx),
    fiber,
    ...(withSettings ? { settings } : {}),
  }
  return { ctx, warnings, effects, onCalls, configureCalls, fiber }
}

test('apply 用插件自己的 fiber 关闭自动设置页：configure({ auto: false }, ctx.fiber)', () => {
  const host = createHost()
  apply(host.ctx, {})

  assert.equal(host.configureCalls.length, 1, '必须恰好调用一次 configure')
  assert.deepEqual(host.configureCalls[0].presentation, { auto: false }, '必须传 auto:false')
  assert.equal(host.configureCalls[0].owner, host.fiber, '必须用插件自己的 fiber，不能用默认值')
})

test('settings 服务缺失：apply 不抛、有 warn，且门禁仍照常注册', () => {
  const host = createHost({ withSettings: false })

  assert.doesNotThrow(() => apply(host.ctx, {}), 'settings 缺失不得让插件加载失败')

  const settingsWarnings = host.warnings.filter((message) => String(message).includes('settings'))
  assert.equal(settingsWarnings.length, 1, `必须恰好一条 settings 相关 warn，实际：${JSON.stringify(host.warnings)}`)
  assert.match(settingsWarnings[0], /^\[force-subagent\] /, 'warn 必须带插件前缀')

  assert.equal(host.configureCalls.length, 0, '服务缺失时不得调用 configure')
  assert.equal(host.onCalls.includes('tools/pre-execute'), true, 'settings 缺失时门禁必须仍然注册（不得静默失效）')
})

test('inject 不包含 settings：缺该服务时整个插件仍会 apply', () => {
  const host = createHost({ withSettings: false })
  apply(host.ctx, {})
  return import('../index.js').then((plugin) => {
    assert.deepEqual(plugin.inject, ['commands', 'systemPrompt', 'subagents'], 'inject 不得硬依赖 settings')
    assert.equal(host.onCalls.includes('tools/pre-execute'), true)
  })
})

test('configure 返回的 disposer 交给 ctx.effect 持有，且能真正注销', () => {
  const host = createHost()
  apply(host.ctx, {})

  const entry = host.effects.find((item) => item.label === 'force-subagent: settings page policy')
  assert.notEqual(entry, undefined, '必须用 ctx.effect 持有 disposer 并带标签')
  assert.equal(typeof entry.dispose, 'function', 'effect 必须收到可调用的 disposer')

  entry.dispose()
  assert.equal(host.configureCalls[0].disposed, true, 'disposer 必须真正注销设置页策略')
})

test('configure 抛错：apply 不抛，warn 说明自动设置页未关闭', () => {
  const host = createHost({ configureThrows: true })

  assert.doesNotThrow(() => apply(host.ctx, {}))

  const matched = host.warnings.filter((message) => String(message).includes('自动设置页未关闭'))
  assert.equal(matched.length, 1, `必须恰好一条说明，实际：${JSON.stringify(host.warnings)}`)
  assert.match(matched[0], /already configured/, '必须带出宿主原始错误信息')
})

test('memberIds 读事件抛错：返回空集合且只告警一次（同一 session）', async () => {
  const { memberIds } = await import('../index.js')
  const broken = { get events() { throw new Error('snapshot boom') } }
  const reported = []

  assert.deepEqual([...memberIds(broken, (error) => reported.push(error.message))], [], '抛错时必须返回空集合')
  assert.deepEqual([...memberIds(broken, (error) => reported.push(error.message))], [], '第二次仍返回空集合')
  assert.deepEqual(reported, ['snapshot boom'], '同一 session 只允许告警一次')
})
