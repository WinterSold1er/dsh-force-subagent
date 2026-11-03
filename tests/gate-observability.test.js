/**
 * dsh-force-subagent 门禁可观测性测试。
 * 契约（全部经真实 handler 触发，不 mock handler 本身）：
 *   apply() 注册的 `ctx.on('tools/pre-execute', handler)` 在门禁降级时必须 logger.warn，
 *   且 warn 文本必须自带可定位信息（缺失的服务名 / 被拦的工具名 / 异常原因）；
 *   同一降级条件反复触发只 warn 一次（防刷屏）。
 * 断言只看 warn 文本内容与条数，不看 mock 是否被调用。
 * 运行：node --test tests/gate-observability.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'

function createSystemPrompt() {
  const sections = []
  return {
    sections,
    section(definition) {
      sections.push(definition)
    },
  }
}

function createCommands() {
  const registered = []
  return {
    registered,
    register(definition) {
      registered.push(definition)
    },
  }
}

function createHost({ systemPrompt = createSystemPrompt(), commands = createCommands(), agentTeams } = {}) {
  const warnings = []
  const onCalls = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (service) => (service === 'systemPrompt' ? systemPrompt : service === 'commands' ? commands : service === 'agentTeams' ? agentTeams : undefined),
    on: (...args) => {
      onCalls.push(args)
    },
  }
  return { ctx, warnings, onCalls, systemPrompt, commands, agentTeams }
}

/** 取出插件登记在 ctx.on 上的真实门禁处理器（不是 mock）。 */
function gateHandler(host) {
  const handlers = host.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)
  assert.equal(handlers.length, 1, `必须恰好注册一个 ${GATE_EVENT} 处理器`)
  return handlers[0]
}

const throwingTeams = () => ({
  tryMembership: () => {
    throw new Error('membership exploded')
  },
})

test('agentTeams 服务缺失：门禁降级必须 warn，且文本点名 agentTeams 或说明门禁未生效', async () => {
  const host = createHost() // 不提供 agentTeams
  apply(host.ctx)

  await gateHandler(host)({ agent: { id: 'mate-1', session: { events: [] } }, name: 'bash' }, () => undefined)

  assert.equal(host.warnings.length, 1, 'agentTeams 缺失必须产生恰好一条 warn')
  assert.match(host.warnings[0], /agentTeams|门禁未生效/)
})

test('tryMembership 抛错：warn 文本必须包含被拦工具名与异常原因（不空 catch）', async () => {
  const host = createHost({ agentTeams: throwingTeams() })
  apply(host.ctx)

  await gateHandler(host)({ agent: { id: 'mate-2' }, name: 'bash' }, () => undefined)

  assert.equal(host.warnings.length, 1, '门禁评估失败必须产生恰好一条 warn')
  assert.match(host.warnings[0], /bash/, 'warn 文本必须包含工具名')
  assert.match(host.warnings[0], /membership exploded/, 'warn 文本必须保留异常原因')
})

test('同一降级条件连续触发两次：warn 计数仍为 1（防刷屏）', async () => {
  const host = createHost({ agentTeams: throwingTeams() })
  apply(host.ctx)
  const handler = gateHandler(host)
  const exec = { agent: { id: 'mate-3' }, name: 'bash' }

  await handler(exec, () => undefined)
  await handler(exec, () => undefined)

  assert.equal(host.warnings.length, 1, '同一条件反复触发只允许 warn 一次')
  assert.match(host.warnings[0], /bash/)
})
