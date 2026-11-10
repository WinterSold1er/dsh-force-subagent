/**
 * 对抗审查（task-14）提出的 7 项缺陷的回归测试：每条都对应一个曾经会静默出错的具体形状。
 * 这些用例不碰真实 ~/.dsh/cordis.patch.yml，全部在临时目录里跑。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyRuntimeLimit, findLimitEntry, patchLimitText, writeMemberLimitPatch } from '../index.js'

/** 建一个临时 patch 文件，返回 { dir, file, cleanup }。 */
function scratch(contents, mode) {
  const dir = mkdtempSync(join(tmpdir(), 'fsx-limit-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, contents)
  if (mode !== undefined) chmodSync(file, mode)
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('D1：maxMembers 值为空时必须真的写入，不得返回假 unchanged', () => {
  const before = ['- id: agent-team', '  config:', '    maxMembers:', ''].join('\n')
  assert.match(patchLimitText(before, 12), /maxMembers: 12/)
  const { file, cleanup } = scratch(before)
  try {
    const result = writeMemberLimitPatch(12, { file })
    assert.equal(result.ok, true)
    assert.notEqual(result.unchanged, true)
    assert.match(readFileSync(file, 'utf8'), /maxMembers: 12/)
  } finally {
    cleanup()
  }
})

test('D1：只有当前值本来就等于目标值才允许 unchanged', () => {
  const text = ['- id: agent-team', '  config:', '    maxMembers: 12', ''].join('\n')
  const { file, cleanup } = scratch(text)
  try {
    const result = writeMemberLimitPatch(12, { file })
    assert.equal(result.ok, true)
    assert.equal(result.unchanged, true)
  } finally {
    cleanup()
  }
})

test('D2：CRLF patch 改写后仍全程 CRLF，非目标行逐字节不变', () => {
  const before = '- id: tool-jobs\r\n  config:\r\n    maxConsecutiveWakes: 10\r\n- id: agent-team\r\n  config:\r\n    maxMembers: 8\r\n'
  const after = patchLimitText(before, 12)
  assert.equal((after.match(/\r\n/g) ?? []).length, 6)
  assert.equal(/(?<!\r)\n/.test(after), false)
  assert.equal(after, before.replace('maxMembers: 8', 'maxMembers: 12'))
})

test('D3：config 之外的 maxMembers（rules 里的同名字段）不被改写', () => {
  const text = ['- id: agent-team', '  rules:', '    - name: team', '      maxMembers: 5', '  config:', '    other: 1', ''].join('\n')
  assert.equal(findLimitEntry(text).keyLine, -1)
  const after = patchLimitText(text, 12)
  assert.equal(after.includes('      maxMembers: 5'), true)
  assert.equal(after.includes('    maxMembers: 12'), true)
})

test('D4：重复 agent-team 条目时作用在最后一条（cordis 后写覆盖）', () => {
  const text = ['- id: agent-team', '  config:', '    maxMembers: 12', '- id: agent-team', '  config:', '    maxMembers: 30', ''].join('\n')
  assert.equal(findLimitEntry(text).raw, '30')
  const after = patchLimitText(text, 16)
  assert.equal(after.includes('    maxMembers: 12'), true)
  assert.equal(after.includes('    maxMembers: 16'), true)
})

test('D5：写入后保留原文件 mode', () => {
  for (const mode of [0o600, 0o666]) {
    const { file, cleanup } = scratch('- id: agent-team\n  config:\n    maxMembers: 8\n', mode)
    try {
      assert.equal(writeMemberLimitPatch(9, { file }).ok, true)
      assert.equal(statSync(file).mode & 0o777, mode)
    } finally {
      cleanup()
    }
  }
})

test('D6：service.config 抛错时运行时判定不穿出异常', () => {
  const service = {
    roster: { maxMembers: 8 },
    get config() {
      throw new Error('boom')
    },
  }
  const result = applyRuntimeLimit(service, 12)
  assert.equal(result.applied, true)
  assert.match(result.reason, /config 读取抛错/)
})
