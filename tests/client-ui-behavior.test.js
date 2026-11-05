/**
 * client.js 的行为测试（与 tests/client-ui.test.js 互补，不重复它的静态断言）。
 *
 * 差别在于这里给出「可运行」的最小 React 替身：useState/useRef/useCallback/useEffect
 * 带真实状态与依赖比较，因此能真的挂载 SettingsPanel、驱动两个下拉、点保存，
 * 再断言宿主 configForms 实际收到的 mutate 载荷（两个 set op + revision 围栏）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const CLIENT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8');
const PANEL_ID = 'dsh-force-subagent';
const POLICY_NS = 'subagent-model-selection-settings';
const NEVER = Symbol('never-run');

/**
 * 注释剥离：带引号状态机，字符串里的 `//`（例如 CSS 里的 data:image/svg+xml URL）不会被误删。
 * 静态断言只允许跑在剥离后的源码上。
 */
function stripComments(code) {
  var out = '';
  var i = 0;
  var quote = '';
  while (i < code.length) {
    var ch = code[i];
    var next = code[i + 1];
    if (quote !== '') {
      if (ch === '\\') {
        out += ch + (next === undefined ? '' : next);
        i += 2;
        continue;
      }
      out += ch;
      if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      var end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '/') {
      var eol = code.indexOf('\n', i);
      i = eol < 0 ? code.length : eol;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const CODE = stripComments(SOURCE);

/** client.js 跑在 vm realm 里，它的 Object/Array 与本文件不同源；deepStrictEqual 比原型，
 *  所以跨 realm 的结构先做 JSON 归一化再严格比。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every(function (value, index) { return value === b[index]; });
}

/** 最小但可运行的 React：hooks 有跨渲染存活的状态槽，effect 按依赖变化重跑。 */
function createReact() {
  var frame = null;
  var React = {
    createElement(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return { type, props: props === null || props === undefined ? {} : props, children };
    },
    useState(initial) {
      var slot = frame.cursor++;
      if (frame.slots[slot] === undefined) {
        frame.slots[slot] = { value: typeof initial === 'function' ? initial() : initial };
      }
      var entry = frame.slots[slot];
      return [entry.value, function (next) {
        entry.value = typeof next === 'function' ? next(entry.value) : next;
      }];
    },
    useRef(initial) {
      var slot = frame.cursor++;
      if (frame.slots[slot] === undefined) frame.slots[slot] = { ref: { current: initial } };
      return frame.slots[slot].ref;
    },
    useCallback(fn, deps) {
      var slot = frame.cursor++;
      var prev = frame.slots[slot];
      if (prev === undefined || !sameDeps(prev.deps, deps)) frame.slots[slot] = { fn, deps };
      return frame.slots[slot].fn;
    },
    useEffect(fn, deps) {
      var slot = frame.cursor++;
      var prev = frame.slots[slot];
      frame.slots[slot] = {
        effect: true,
        fn,
        deps,
        lastDeps: prev === undefined ? NEVER : prev.lastDeps,
        cleanup: prev === undefined ? undefined : prev.cleanup,
      };
    },
    __enter(nextFrame) { frame = nextFrame; },
  };
  return React;
}

function runEffects(frame) {
  Object.keys(frame.slots).forEach(function (key) {
    var entry = frame.slots[key];
    if (entry === undefined || entry.effect !== true) return;
    if (entry.lastDeps !== NEVER && sameDeps(entry.lastDeps, entry.deps)) return;
    if (typeof entry.cleanup === 'function') entry.cleanup();
    entry.cleanup = entry.fn();
    entry.lastDeps = entry.deps;
  });
}

function mount(React, component, props) {
  var frame = { slots: [], cursor: 0 };
  return {
    frame,
    render() {
      React.__enter(frame);
      frame.cursor = 0;
      var tree = component(props);
      runEffects(frame);
      return tree;
    },
  };
}

/** 展开函数型 vnode（ForkGlyph 之类），只收集真实 DOM 节点。 */
function collectNodes(node, acc) {
  var out = acc === undefined ? [] : acc;
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    node.forEach(function (child) { collectNodes(child, out); });
    return out;
  }
  if (typeof node !== 'object') return out;
  if (typeof node.type === 'function') {
    collectNodes(node.type(node.props), out);
    return out;
  }
  out.push(node);
  collectNodes(node.children, out);
  return out;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object') return textOf(node.children);
  return '';
}

function findByText(root, needle, type) {
  return collectNodes(root).filter(function (node) {
    if (type !== undefined && node.type !== type) return false;
    return textOf(node.children).indexOf(needle) >= 0;
  });
}

function findById(root, id) {
  return collectNodes(root).filter(function (node) { return node.props.id === id; });
}

function loadPlugin(react) {
  var exported;
  var sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          exported = definition.factory(function (name) {
            if (name === 'react') return react;
            throw new Error('unexpected require: ' + name);
          });
        },
      },
    },
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  new vm.Script(SOURCE, { filename: CLIENT_PATH }).runInContext(sandbox);
  return exported;
}

/** 忠实反映 client.js 真实访问的 ctx 成员，并记录调用。 */
function makeEnv(options) {
  var react = createReact();
  var plugin = loadPlugin(react);
  var entries = [];
  var namespaces = [];
  var mutations = [];
  var panelCalls = [];
  var warns = [];
  var formSubs = [];
  var workspacesItems = options.workspaces === undefined ? [] : options.workspaces;
  var workSubs = [];
  var configValue = options.config.value;
  var configRevision = options.config.revision;

  var form = {
    getSnapshot() {
      return { status: 'ready', value: configValue, revision: configRevision, writable: true };
    },
    subscribe(listener) {
      formSubs.push(listener);
      return function () {
        var index = formSubs.indexOf(listener);
        if (index >= 0) formSubs.splice(index, 1);
      };
    },
    mutate(operations, revision) {
      mutations.push({ operations, revision });
      var merged = {};
      Object.keys(configValue === null || configValue === undefined ? {} : configValue).forEach(function (name) {
        merged[name] = configValue[name];
      });
      operations.forEach(function (op) {
        if (op.op === 'set' && op.path.length === 1) merged[op.path[0]] = op.value;
      });
      configValue = merged;
      configRevision += 1;
      formSubs.forEach(function (listener) { listener(); });
      return Promise.resolve(true);
    },
  };

  var policyScope = {
    getSnapshot() { return options.policy; },
    subscribe() { return function () {}; },
  };

  var remoteService = {
    session: {
      modelCatalog() { return Promise.resolve(options.catalog); },
    },
    $on() { return function () {}; },
  };

  var ctx = {
    configForms: {
      get(namespace) {
        namespaces.push(namespace);
        if (namespace === PANEL_ID) return form;
        if (namespace === POLICY_NS) return policyScope;
        return undefined;
      },
    },
    slots: {
      inject(name, handler) {
        var result = handler();
        if (result !== null && result !== undefined && typeof result.next === 'function') {
          for (var step = result.next(); !step.done; step = result.next()) { /* 驱动 generator 注册 */ }
        }
      },
      register(registration, component) {
        entries.push({ registration, component });
        return { registration };
      },
    },
    layout: {
      selectPanel(panelId) { panelCalls.push(panelId); },
    },
    logger: {
      warn(message) { warns.push(message); },
    },
    get(name) {
      if (name === 'workspaces') {
        return {
          list: {
            getSnapshot() { return { items: workspacesItems }; },
            subscribe(listener) {
              workSubs.push(listener);
              return function () {
                var index = workSubs.indexOf(listener);
                if (index >= 0) workSubs.splice(index, 1);
              };
            },
          },
        };
      }
      if (name === 'remote') return remoteService;
      throw new Error('no such service: ' + name);
    },
  };

  plugin.apply(ctx);
  var main = entries.filter(function (entry) { return entry.registration.name === 'main'; })[0];
  return {
    react, plugin, entries, ctx, form, main,
    namespaces, mutations, panelCalls, warns,
    configValue() { return configValue; },
    panel() { return mount(react, main.component, {}); },
  };
}

function optionValues(selectNode) {
  return collectNodes(selectNode.children).map(function (node) { return node.props.value; });
}

function settle() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

var CATALOG_OK = {
  ok: true,
  value: {
    groups: [{
      id: 'dp',
      name: 'DeepSeek Provider',
      models: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }],
    }],
    failures: [],
  },
};

var WORKSPACES = [{ path: '/repo/a', title: '仓库 A', workspaceId: 'w1', sessionIds: ['s1'] }];

test('挂载面板：工作区未选时两个模型下拉禁用，工作区下拉列出真实工作区', () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 1 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
  });
  const panel = env.panel();
  panel.render();
  const tree = panel.render();

  const workspaceSelect = findById(tree, 'fsx-workspace');
  assert.equal(workspaceSelect.length, 1);
  assert.deepEqual(optionValues(workspaceSelect[0]), ['', '/repo/a']);

  const providerSelect = findById(tree, 'fsx-memberProvider');
  assert.equal(providerSelect.length, 1);
  assert.equal(providerSelect[0].props.disabled, true, '未选工作区时 Provider 必须禁用');
  assert.equal(findById(tree, 'fsx-subagentModel')[0].props.disabled, true);
});

test('挂载面板：策略未启用时 Provider 选项来自 session.modelCatalog()', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 1 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
  });
  const panel = env.panel();
  panel.render();
  await settle();
  let tree = panel.render();
  const workspaceSelect = findById(tree, 'fsx-workspace')[0];
  workspaceSelect.props.onChange({ target: { value: '/repo/a' } });
  tree = panel.render();
  tree = panel.render();

  const providerSelect = findById(tree, 'fsx-memberProvider')[0];
  assert.equal(providerSelect.props.disabled, false);
  assert.deepEqual(optionValues(providerSelect), ['', 'dp']);

  providerSelect.props.onChange({ target: { value: 'dp' } });
  tree = panel.render();
  const modelSelect = findById(tree, 'fsx-memberModel')[0];
  assert.deepEqual(optionValues(modelSelect), ['', 'm1', 'm2']);
  assert.equal(modelSelect.props.disabled, false);
});

test('挂载面板：策略启用时 allowedModels 是合法性围栏，目录被排除', () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 1 },
    policy: { status: 'ready', value: { enabled: true, allowedModels: [{ provider: 'pl', model: 'pm' }] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
  });
  const panel = env.panel();
  panel.render();
  let tree = panel.render();
  findById(tree, 'fsx-workspace')[0].props.onChange({ target: { value: '/repo/a' } });
  tree = panel.render();
  tree = panel.render();

  const providerSelect = findById(tree, 'fsx-memberProvider')[0];
  assert.deepEqual(optionValues(providerSelect), ['', 'pl'], '策略启用时不得出现目录里的 dp');
  providerSelect.props.onChange({ target: { value: 'pl' } });
  tree = panel.render();
  assert.deepEqual(optionValues(findById(tree, 'fsx-memberModel')[0]), ['', 'pm']);
});

test('保存走 form.mutate(三个 set op: enabled/workspaces/mode, fresh.revision)，保留其它工作区并成对写入路由', async () => {
  const env = makeEnv({
    config: {
      value: {
        enabled: true,
        workspaces: {
          '/keep': { member: { provider: 'kp', model: 'km' }, subagent: { provider: '', model: '' }, note: 'keep-me' },
        },
      },
      revision: 7,
    },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
  });
  const panel = env.panel();
  panel.render();
  await settle();
  let tree = panel.render();
  findById(tree, 'fsx-workspace')[0].props.onChange({ target: { value: '/repo/a' } });
  tree = panel.render();
  tree = panel.render();
  findById(tree, 'fsx-memberProvider')[0].props.onChange({ target: { value: 'dp' } });
  tree = panel.render();

  const saveButton = findByText(tree, '保存设置', 'button');
  assert.equal(saveButton.length, 1);
  assert.equal(typeof saveButton[0].props.onClick, 'function');
  assert.equal(saveButton[0].props.disabled, false);
  saveButton[0].props.onClick();

  assert.equal(env.mutations.length, 1);
  assert.deepEqual(plain(env.mutations[0].operations), [
    { op: 'set', path: ['enabled'], value: true },
    {
      op: 'set',
      path: ['workspaces'],
      value: {
        '/keep': { member: { provider: 'kp', model: 'km' }, subagent: { provider: '', model: '' }, note: 'keep-me' },
        '/repo/a': { member: { provider: 'dp', model: 'm1' }, subagent: { provider: '', model: '' } },
      },
    },
    { op: 'set', path: ['mode'], value: 'nested' },
  ]);
  assert.equal(env.mutations[0].revision, 7, '必须带读取快照的 revision 作围栏');

  await settle();
  const after = panel.render();
  assert.ok(textOf(after).indexOf('已保存') >= 0);
  assert.deepEqual(plain(env.configValue().workspaces['/repo/a']), {
    member: { provider: 'dp', model: 'm1' },
    subagent: { provider: '', model: '' },
  });
});

test('路由不合法时不提交：provider 有值而 model 为空则保存按钮禁用', () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: { '/repo/a': { member: { provider: 'dp', model: '' }, subagent: { provider: '', model: '' } } } }, revision: 3 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
  });
  const panel = env.panel();
  panel.render();
  let tree = panel.render();
  findById(tree, 'fsx-workspace')[0].props.onChange({ target: { value: '/repo/a' } });
  tree = panel.render();
  tree = panel.render();

  const saveButton = findByText(tree, '保存设置', 'button');
  assert.equal(saveButton.length, 1);
  assert.equal(saveButton[0].props.disabled, true, 'provider/model 不成对时不得允许保存');
  saveButton[0].props.onClick();
  assert.equal(env.mutations.length, 0, '禁用状态下点击也不得产生 mutate');
});

test('侧栏常驻入口整棵树没有 onClick，会话头入口整棵树有 onClick 并切到 main 面板', () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 1 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
  });
  const sidebar = env.entries.filter(function (entry) {
    return entry.registration.name === 'sidebar.panellist';
  })[0];
  const header = env.entries.filter(function (entry) {
    return entry.registration.name === 'conversation.session.header.actions';
  })[0];

  const iconNodes = collectNodes(sidebar.component({ size: 22, active: true }));
  assert.ok(iconNodes.length >= 1);
  assert.equal(iconNodes[0].type, 'svg');
  assert.deepEqual(iconNodes.filter(function (node) { return node.props.onClick !== undefined; }), [],
    '侧栏入口只渲染图标，点击归宿主所有');

  const headerNodes = collectNodes(header.component({ sessionId: 's-9' }));
  const clickable = headerNodes.filter(function (node) { return typeof node.props.onClick === 'function'; });
  assert.equal(clickable.length, 1, '同一套遍历必须能在会话头入口里找到 onClick，否则上一条断言是空判');
  clickable[0].props.onClick();
  assert.deepEqual(env.panelCalls, [PANEL_ID]);
});

test('三个会话入口注册 id 均为 force-subagent-route，main 用 key、侧栏用插件 id', () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 1 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: [],
    catalog: CATALOG_OK,
  });
  const byName = {};
  env.entries.forEach(function (entry) { byName[entry.registration.name] = entry.registration; });

  assert.equal(byName.main.key, PANEL_ID);
  assert.equal(byName.main.id, undefined, 'main 槽靠 key 定位，不是 id');
  assert.equal(byName['sidebar.panellist'].id, PANEL_ID);
  assert.equal(byName['conversation.session.header.actions'].id, 'force-subagent-route');
  assert.equal(byName['conversation.hero.options'].id, 'force-subagent-route');
  assert.equal(byName['sidebar.workspaces.session.menu.item'].id, 'force-subagent-route');
  assert.deepEqual([
    byName['sidebar.panellist'].order,
    byName['conversation.session.header.actions'].order,
    byName['conversation.hero.options'].order,
    byName['sidebar.workspaces.session.menu.item'].order,
  ], [20, 30, 100, 900]);
  assert.deepEqual(env.namespaces, [PANEL_ID, POLICY_NS], 'apply 必须读自己的配置命名空间与策略命名空间');
});

test('draftIsValid：成对才为真，半对为假，null 直接抛错（实现无空值防御）', () => {
  const { __test } = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 1 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: [],
    catalog: CATALOG_OK,
  }).plugin;

  assert.equal(__test.draftIsValid({ memberProvider: '', memberModel: '', subagentProvider: '', subagentModel: '' }), true);
  assert.equal(__test.draftIsValid({}), true, '全空 = 继承默认，必须视为合法');
  assert.equal(__test.draftIsValid({ memberProvider: 'dp', memberModel: 'm1' }), true);
  assert.equal(__test.draftIsValid({ memberProvider: 'dp', memberModel: 'm1', subagentProvider: 'sp', subagentModel: 'sm' }), true);
  assert.equal(__test.draftIsValid({ memberProvider: 'dp' }), false);
  assert.equal(__test.draftIsValid({ memberModel: 'm1' }), false);
  assert.equal(__test.draftIsValid({ memberProvider: 'dp', memberModel: 'm1', subagentProvider: 'sp' }), false);
  assert.equal(__test.draftIsValid({ memberProvider: 0, memberModel: 0 }), true, '非字符串按空处理 = 继承默认');
  assert.throws(function () { __test.draftIsValid(null); }, { name: 'TypeError' });
});

test('buildModelOptions：当前值兜底、去重、目录三态与 policy-empty 可区分', () => {
  const { __test } = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 1 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: [],
    catalog: CATALOG_OK,
  }).plugin;

  const shape = function (options) {
    var normalized = plain(options);
    return {
      status: normalized.status,
      source: normalized.source,
      providers: normalized.providers.map(function (group) {
        return { provider: group.provider, label: group.label, models: group.models.map(function (m) { return { model: m.model, label: m.label }; }) };
      }),
    };
  };

  assert.deepEqual(shape(__test.buildModelOptions({
    policy: { status: 'ready', value: { enabled: true, allowedModels: [{ provider: 'p' }, { provider: 'p', model: 'm' }] } },
  })), { status: 'ready', source: 'allowed', providers: [{ provider: 'p', label: 'p', models: [{ model: 'm', label: 'm' }] }] },
    '缺 model 的 allowed 条目必须被丢弃');

  const deduped = __test.buildModelOptions({
    policy: { status: 'ready', value: { enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] } },
    current: { provider: 'p', model: 'm' },
  });
  assert.equal(deduped.providers.length, 1);
  assert.equal(deduped.providers[0].models.length, 1, '当前值与策略重合时不得重复');

  assert.deepEqual(shape(__test.buildModelOptions({
    policy: { status: 'unavailable' },
    catalog: { status: 'error', groups: [] },
    current: { provider: 'solo', model: '' },
  })), { status: 'error', source: 'current', providers: [{ provider: 'solo', label: 'solo', models: [] }] },
    '只有 provider 没有 model 时不得造出空模型候选');

  assert.equal(__test.buildModelOptions({
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    catalog: { status: 'idle', groups: [], failures: [], error: '' },
  }).status, 'empty', '目录尚未加载完（idle）应落到 empty');

  assert.equal(__test.buildModelOptions({
    policy: { status: 'ready', value: { enabled: true, allowedModels: [] } },
    catalog: { status: 'ready', groups: [{ id: 'dp', name: 'Deep', models: [{ id: 'm1' }] }], failures: [] },
  }).status, 'policy-empty', '策略启用但列表为空时不得回落到目录');

  const unfiltered = __test.buildModelOptions({
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    catalog: {
      status: 'ready',
      groups: [{ id: 'dp', name: 'Deep', models: [{ id: 'm1' }] }, { id: 'pl', name: 'Plain', models: [{ id: 'm2' }] }],
      routableProviders: ['dp'],
    },
  });
  assert.deepEqual(plain(unfiltered.providers).map(function (group) { return group.provider; }), ['dp', 'pl'],
    '当前实现不按 routableProviders 过滤（记录既有行为，不是期望特性）');
});
