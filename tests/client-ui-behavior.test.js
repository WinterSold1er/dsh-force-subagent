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

  // rc.2 的成员容量与嵌套深度住在宿主 `subagent` 命名空间，面板经同一个 configForms 入口读写它。
  var capacityValue = options.capacity === undefined || options.capacity === null
    ? { maxActiveSubagents: 8, maxDepth: 2 }
    : options.capacity.value;
  var capacityRevision = options.capacity === undefined || options.capacity === null
    || options.capacity.revision === undefined ? 5 : options.capacity.revision;
  var capacityMutations = [];
  var capacitySubs = [];
  var capacityForm = options.capacity === null ? undefined : {
    getSnapshot() {
      return { status: 'ready', value: capacityValue, revision: capacityRevision, writable: true };
    },
    subscribe(listener) {
      capacitySubs.push(listener);
      return function () {
        var index = capacitySubs.indexOf(listener);
        if (index >= 0) capacitySubs.splice(index, 1);
      };
    },
    mutate(operations, revision) {
      capacityMutations.push({ operations, revision });
      if (options.capacityReject !== undefined) {
        var failure = new Error(options.capacityReject);
        if (options.capacityRejectThrows === true) throw failure;
        return Promise.reject(failure);
      }
      var merged = {};
      Object.keys(capacityValue === null || capacityValue === undefined ? {} : capacityValue).forEach(function (name) {
        merged[name] = capacityValue[name];
      });
      operations.forEach(function (op) {
        if (op.op === 'set' && op.path.length === 1) merged[op.path[0]] = op.value;
      });
      capacityValue = merged;
      capacityRevision += 1;
      capacitySubs.forEach(function (listener) { listener(); });
      return Promise.resolve(true);
    },
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
        if (namespace === 'subagent') return capacityForm;
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
    namespaces, mutations, capacityMutations, panelCalls, warns,
    configValue() { return configValue; },
    capacityValue() { return capacityValue; },
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

/** 三个模型才能把成员 / 子代理 / 审查三条路由区分开：两个模型时互换路由看不出来。 */
var CATALOG3 = {
  ok: true,
  value: {
    groups: [{
      id: 'dp',
      name: 'DeepSeek Provider',
      models: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }, { id: 'm3', name: 'Model Three' }],
    }],
    failures: [],
  },
};

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

  const saveButton = findById(tree, 'fsx-save');
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
        '/repo/a': { member: { provider: 'dp', model: 'm1' }, subagent: { provider: '', model: '' }, reviewer: { provider: '', model: '' } },
      },
    },
    { op: 'set', path: ['mode'], value: 'nested' },
  ], '未配置审查路由时必须显式写出继承默认，不留 undefined');
  assert.equal(env.mutations[0].revision, 7, '必须带读取快照的 revision 作围栏');

  await settle();
  const after = panel.render();
  assert.ok(textOf(after).indexOf('已保存') >= 0);
  assert.deepEqual(plain(env.configValue().workspaces['/repo/a']), {
    member: { provider: 'dp', model: 'm1' },
    subagent: { provider: '', model: '' },
    reviewer: { provider: '', model: '' },
  }, '写回宿主的工作区条目必须三条路由齐全');
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

  const saveButton = findById(tree, 'fsx-save');
  assert.equal(saveButton.length, 1);
  assert.equal(saveButton[0].props.disabled, true, 'provider/model 不成对时不得允许保存');
  saveButton[0].props.onClick();
  assert.equal(env.mutations.length, 0, '禁用状态下点击也不得产生 mutate');
});

test('挂载面板：第三张路由卡是审查代码模型，未选工作区时它的两个下拉禁用并显示回退说明', () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 1 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
  });
  const panel = env.panel();
  panel.render();
  const tree = panel.render();

  const provider = findById(tree, 'fsx-reviewerProvider');
  assert.equal(provider.length, 1, '审查代码模型必须有自己的 Provider 下拉');
  assert.equal(provider[0].props.disabled, true, '未选工作区时审查路由也必须禁用，不能让人往没选中的工作区写');
  assert.equal(findById(tree, 'fsx-reviewerModel')[0].props.disabled, true);

  const hint = findById(tree, 'fsx-reviewerProvider-hint');
  assert.equal(hint.length, 1, '审查 Provider 必须有 aria-describedby 指向的提示');
  assert.equal(textOf(hint[0].children), '留空则回退到成员 / 子代理路由',
    '没有全局 reviewer 时审查卡必须说「回退到成员 / 子代理路由」，沿用「继承全局默认路由」会指向不存在的旋钮');

  const desc = findByText(tree, 'name="reviewer"');
  assert.ok(desc.length >= 1, '审查卡描述必须点名 name="reviewer"，用户才知道这张卡管的是哪个成员');
});

test('审查卡继承提示：全局 reviewer 已配置时点名继承的具体模型，其它卡仍显示各自的缺省文案', () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {}, reviewer: { provider: 'gp', model: 'gm' } }, revision: 1 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
  });
  const panel = env.panel();
  panel.render();
  const tree = panel.render();

  assert.equal(textOf(findById(tree, 'fsx-reviewerProvider-hint')[0].children),
    '留空则继承全局默认：gp / gm', '全局 reviewer 有值时必须报出具体模型，不能只说「继承全局默认」');
  assert.equal(textOf(findById(tree, 'fsx-memberProvider-hint')[0].children), '留空则继承全局默认路由',
    '全局 member 没配置时成员卡仍走缺省文案');
});

test('审查路由可单独选择：只改 reviewer 不会串到成员 / 子代理，保存载荷三条路由各自独立', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 12 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG3,
  });
  const panel = env.panel();
  panel.render();
  await settle();
  let tree = panel.render();
  findById(tree, 'fsx-workspace')[0].props.onChange({ target: { value: '/repo/a' } });
  tree = panel.render();
  tree = panel.render();

  assert.equal(findById(tree, 'fsx-reviewerProvider')[0].props.disabled, false, '选中工作区后审查路由必须可编辑');

  findById(tree, 'fsx-memberProvider')[0].props.onChange({ target: { value: 'dp' } });
  tree = panel.render();
  findById(tree, 'fsx-memberModel')[0].props.onChange({ target: { value: 'm1' } });
  tree = panel.render();
  findById(tree, 'fsx-subagentProvider')[0].props.onChange({ target: { value: 'dp' } });
  tree = panel.render();
  findById(tree, 'fsx-subagentModel')[0].props.onChange({ target: { value: 'm3' } });
  tree = panel.render();
  findById(tree, 'fsx-reviewerProvider')[0].props.onChange({ target: { value: 'dp' } });
  tree = panel.render();
  assert.equal(findById(tree, 'fsx-reviewerModel')[0].props.value, 'm1', '换 provider 必须自动带出该 provider 的首个模型');
  findById(tree, 'fsx-reviewerModel')[0].props.onChange({ target: { value: 'm2' } });
  tree = panel.render();

  const save = findById(tree, 'fsx-save')[0];
  assert.equal(save.props.disabled, false, '三组路由各自成对时必须允许保存');
  save.props.onClick();

  assert.equal(env.mutations.length, 1);
  const operations = plain(env.mutations[0].operations);
  const written = operations.find(function (op) { return op.path.join('.') === 'workspaces'; }).value;
  assert.deepEqual(written['/repo/a'], {
    member: { provider: 'dp', model: 'm1' },
    subagent: { provider: 'dp', model: 'm3' },
    reviewer: { provider: 'dp', model: 'm2' },
  }, '三条路由必须互不串线：审查卡改的模型不得覆盖成员或子代理路由');
  assert.equal(env.mutations[0].revision, 12);
});

test('审查路由不成对（provider 有值而 model 为空）时保存禁用，且可见文案点名「审查代码模型」', () => {
  const env = makeEnv({
    config: {
      value: {
        enabled: true,
        workspaces: {
          '/repo/a': {
            member: { provider: 'dp', model: 'm1' },
            subagent: { provider: 'dp', model: 'm2' },
            reviewer: { provider: 'dp', model: '' },
          },
        },
      },
      revision: 4,
    },
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

  const save = findById(tree, 'fsx-save')[0];
  assert.equal(save.props.disabled, true, '只有审查路由不成对时也必须禁止保存——半对路由会污染宿主条目');
  findById(tree, 'fsx-save-all')[0].props.onClick();
  assert.equal(env.mutations.length, 0, '禁用状态下点击不得产生 mutate');

  const visible = textOf(panel.render());
  assert.ok(visible.indexOf('审查代码模型') >= 0 && visible.indexOf('成对') >= 0,
    '三张卡共用一句不带主语的「需成对选择」会把用户支到别的路由上，可见文案必须点名是哪张卡');
});

test('策略白名单外、但全局已配的 reviewer 模型仍保留在审查下拉里，且不外泄到其它卡的下拉', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {}, reviewer: { provider: 'gp', model: 'gm' } }, revision: 1 },
    policy: { status: 'ready', value: { enabled: true, allowedModels: [{ provider: 'dp', model: 'm1' }] } },
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

  assert.deepEqual(optionValues(findById(tree, 'fsx-reviewerProvider')[0]), ['', 'dp', 'gp'],
    '「留空则回退」指向的全局 reviewer 必须能直接选中，否则只能手填');
  assert.deepEqual(optionValues(findById(tree, 'fsx-memberProvider')[0]), ['', 'dp'],
    '全局 reviewer 只属于审查卡，不得把白名单外的 provider 塞进成员卡');
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
  assert.deepEqual(env.namespaces, [PANEL_ID, 'subagent', POLICY_NS],
    'apply 必须读自己的配置命名空间、宿主容量命名空间 subagent 与策略命名空间');
});

test('draftIsValid：成对才为真，半对为假，空值一律视为「全继承默认」= 合法（空值防御已落地）', () => {
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
  // 空值语义钉死：非对象 draft = 三组全继承默认 = 合法（true），不得抛 TypeError。
  // 与 invalidRouteLabel 同一口径（见 client-ui.test.js 的 invalidRouteLabel 用例）。
  assert.equal(__test.draftIsValid(null), true, 'null 必须视为全继承默认 = 合法，不得抛错');
  assert.equal(__test.draftIsValid(undefined), true, 'undefined 必须视为全继承默认 = 合法');
  assert.equal(__test.draftIsValid('nope'), true, '非对象标量必须视为全继承默认 = 合法');
  assert.equal(__test.invalidRouteLabel(null), '', 'null 不得谎报卡名');
  assert.equal(__test.invalidRouteLabel(undefined), '', 'undefined 不得谎报卡名');
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

test('面板头有退出按钮：点击调用 layout.selectPanel(null) 且不写配置', () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 1 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
  });
  const panel = env.panel();
  panel.render();
  const tree = panel.render();

  const headers = collectNodes(tree).filter(function (node) { return node.type === 'header'; });
  assert.equal(headers.length, 1, '面板必须只有一个 header');

  const exit = collectNodes(tree).filter(function (node) {
    return node.type === 'button' && node.props['aria-label'] === '退出强制委派面板，返回当前会话';
  });
  assert.equal(exit.length, 1, '整棵树里有且只有一个带退出可访问名称的按钮');
  assert.ok(textOf(exit[0].children).length > 0, '退出按钮必须有可见文字');
  assert.equal(exit[0].props.type, 'button');
  assert.equal(typeof exit[0].props.onClick, 'function', '没有 onClick 的就是假按钮');

  const inHeader = collectNodes(headers[0]).filter(function (node) { return node.type === 'button'; });
  assert.equal(inHeader.length, 1, '退出按钮必须挂在面板头上');

  exit[0].props.onClick();
  assert.deepEqual(env.panelCalls, [null], '退出必须走宿主 selectPanel(null)，而不是假关闭');
  assert.equal(env.mutations.length, 0, '退出不该产生任何配置写入');
});

test('退出时宿主 selectPanel 抛错不得炸页面，只落 warn', () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 1 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
  });
  env.ctx.layout.selectPanel = function () { throw new Error('layout gone'); };
  const panel = env.panel();
  panel.render();
  const tree = panel.render();
  const exit = collectNodes(tree).filter(function (node) {
    return node.type === 'button' && node.props['aria-label'] === '退出强制委派面板，返回当前会话';
  });
  assert.equal(exit.length, 1);
  assert.doesNotThrow(function () { exit[0].props.onClick(); });
  assert.equal(env.panelCalls.length, 0);
  assert.equal(env.warns.filter(function (m) { return m.indexOf('切换面板失败') >= 0; }).length, 1,
    '异常必须被记到 warn，不能空 catch 吞掉');
});

// ---------------------------------------------------------------- 团队成员容量控件（rc.2：宿主 subagent 命名空间）

const LIMIT_INPUT = 'fsx-member-limit';
const DEPTH_INPUT = 'fsx-member-depth';
const LIMIT_CONFIG = { enabled: true, mode: 'nested', workspaces: {} };
/** 面板默认的宿主 subagent 命名空间快照；深度 2 让 nested 模式默认不触发深度告警。 */
const CAPACITY_DEFAULT = { maxActiveSubagents: 8, maxDepth: 2 };

function limitEnv(options) {
  const opts = options === undefined ? {} : options;
  return makeEnv({
    config: { value: opts.config === undefined ? LIMIT_CONFIG : opts.config, revision: 3 },
    policy: { status: 'ready', value: { enabled: false, allowedModels: [] } },
    workspaces: WORKSPACES,
    catalog: CATALOG_OK,
    capacity: opts.capacity,
    capacityReject: opts.capacityReject,
    capacityRejectThrows: opts.capacityRejectThrows,
  });
}

/** 挂好面板并返回当前树（两次 render 让 effect 真的跑一遍）。 */
async function limitPanel(env) {
  const panel = env.panel();
  panel.render();
  await settle();
  return { panel, tree: panel.render() };
}

function findByClass(tree, tone) {
  return collectNodes(tree).filter(function (node) {
    return (node.props.className || '').indexOf(tone) >= 0;
  });
}

function limitApply(tree) {
  const found = findByText(tree, '应用容量', 'button');
  assert.equal(found.length, 1, '「应用容量」按钮必须有且只有一个');
  assert.equal(typeof found[0].props.onClick, 'function', '没有 onClick 的应用按钮就是摆设');
  return found[0];
}

/** 面板里唯一的容量输入与深度输入：写入只能经由它们触发，不存在第二条写入路径。 */
function capacityInputs(tree) {
  const limit = findById(tree, LIMIT_INPUT);
  const depth = findById(tree, DEPTH_INPUT);
  assert.equal(limit.length, 1, '容量输入必须唯一');
  assert.equal(depth.length, 1, '深度输入必须唯一');
  return { limit: limit[0], depth: depth[0] };
}

/** 填两个输入并点「应用容量」，返回点击后的最新树（React 状态要重渲染才看得到）。 */
function submitCapacity(panel, tree, limit, depth) {
  const inputs = capacityInputs(tree);
  inputs.limit.props.onChange({ target: { value: limit } });
  capacityInputs(panel.render()).depth.props.onChange({ target: { value: depth === undefined ? '' : depth } });
  const filled = panel.render();
  limitApply(filled).props.onClick();
  return panel.render();
}

/** 全部宿主写入里出现过的字段名，用于证明插件不再往任何命名空间写 maxMembers。 */
function writtenPaths(env) {
  return env.mutations.concat(env.capacityMutations).reduce(function (acc, call) {
    return acc.concat(call.operations.map(function (op) { return op.path.join('.'); }));
  }, []);
}

test('成员容量控件：label、两个 number 输入、应用按钮与来源说明齐备且互相关联', async () => {
  const env = limitEnv();
  const { tree } = await limitPanel(env);
  const inputs = capacityInputs(tree);
  assert.equal(inputs.limit.props.type, 'number', '容量输入必须是 number');
  assert.equal(inputs.limit.props.min, 1);
  assert.equal(inputs.limit.props.max, 100000, '护栏必须与宿主侧 index.js MAX_CAPACITY_LIMIT 一致');
  assert.equal(inputs.limit.props['aria-describedby'], 'fsx-member-limit-hint', '输入必须指向同一条说明');
  assert.equal(inputs.depth.props.type, 'number');
  assert.equal(inputs.depth.props.min, 0, '宿主 maxDepth 的合法下界是 0');
  assert.equal(inputs.depth.props['aria-describedby'], 'fsx-member-limit-hint');
  assert.equal(typeof inputs.limit.props.onChange, 'function');
  assert.equal(typeof inputs.depth.props.onChange, 'function');

  const labels = collectNodes(tree).filter(function (node) {
    return node.type === 'label' && node.props.htmlFor === LIMIT_INPUT;
  });
  assert.equal(labels.length, 1, '输入必须有 label，键盘与读屏用户才找得到');
  assert.ok(textOf(labels[0].children).indexOf('团队成员容量') >= 0, 'label 必须点名容量：' + textOf(labels[0].children));

  const hints = findById(tree, 'fsx-member-limit-hint');
  assert.equal(hints.length, 1, '说明节点必须唯一');
  const hint = textOf(hints[0].children);
  assert.ok(hint.indexOf('subagent') >= 0, '说明必须点名容量所在的宿主命名空间：' + hint);
  assert.ok(hint.indexOf('即时生效') >= 0, '说明必须交代生效时机：' + hint);
  assert.ok(hint.indexOf('不写任何配置文件') >= 0, '说明必须写明插件不再写配置文件：' + hint);
  limitApply(tree);
});

test('成员容量当前值：面板显示宿主 subagent 命名空间回读的容量与深度，不显示插件默认值', async () => {
  const env = limitEnv({ capacity: { value: { maxActiveSubagents: 1024, maxDepth: 2 }, revision: 9 } });
  const { tree } = await limitPanel(env);
  const status = findByClass(tree, 'fsx-feedback').filter(function (node) {
    return node.props.role === 'status' && textOf(node.children).indexOf('当前 ') >= 0;
  });
  assert.equal(status.length, 1, '必须恰好一条当前容量状态：' + status.map(function (n) { return textOf(n.children); }));
  const text = textOf(status[0].children);
  assert.ok(text.indexOf('1024') >= 0, '当前容量必须来自宿主快照：' + text);
  assert.ok(text.indexOf('嵌套深度上限 2') >= 0, '深度同样要回读自宿主：' + text);
  const inputs = capacityInputs(tree);
  assert.equal(inputs.limit.props.placeholder, '1024', '输入占位符必须显示宿主当前值');
  assert.equal(inputs.depth.props.placeholder, '深度 2');
});

test('成员容量非法值：就地报错、不留成功提示、零宿主写入也不改配置', async () => {
  const env = limitEnv();
  const { panel, tree } = await limitPanel(env);
  ['', '   ', '0', '-3', '1.5', '100001', 'abc', '1e3', '0x10', '１０', '12,5'].forEach(function (raw) {
    const current = submitCapacity(panel, tree, raw);
    const errors = findByClass(current, 'fsx-feedback--error');
    assert.equal(errors.length, 1, '非法值 ' + JSON.stringify(raw) + ' 必须落一条就地提示：' + textOf(errors[0].children));
    assert.equal(errors[0].props.role, 'alert', '就地提示必须是 alert，读屏才播报');
    const message = textOf(errors[0].children);
    assert.ok(message.indexOf('成员容量') >= 0, '提示必须点名是哪个字段：' + message);
    assert.ok(message.indexOf('收到') >= 0, '提示必须说明收到了什么：' + message);
    assert.equal(findByClass(current, 'fsx-feedback--ok').length, 0, '非法值不得同时冒充成功反馈');
  });
  assert.equal(env.capacityMutations.length, 0, '非法值不得产生任何宿主写入');
  assert.equal(env.mutations.length, 0, '非法值不得去碰插件自己的命名空间');
  assert.deepEqual(env.capacityValue(), CAPACITY_DEFAULT, '非法值不得改动容量配置');
  assert.deepEqual(env.configValue(), LIMIT_CONFIG, '非法值不得改动插件配置');
});

test('成员容量合法值：经 configForms 写入 subagent 命名空间的 maxActiveSubagents，载荷与 revision 围栏都对', async () => {
  const env = limitEnv();
  const { panel, tree } = await limitPanel(env);
  submitCapacity(panel, tree, '64');
  await settle();
  assert.equal(env.capacityMutations.length, 1, '合法值必须真的发一次宿主写入');
  const call = env.capacityMutations[0];
  assert.equal(call.operations.length, 1, '只填容量时只发一条写入');
  assert.equal(call.operations[0].path[0], 'maxActiveSubagents', '写路径必须点名宿主的容量字段');
  assert.equal(call.operations[0].value, 64);
  assert.equal(call.revision, 5, '必须带读取快照的 revision 作围栏');
  assert.equal(env.mutations.length, 0, '容量写入不得落到插件自己的命名空间');
  assert.deepEqual(writtenPaths(env), ['maxActiveSubagents'], '整条写入链不得出现别的字段：' + writtenPaths(env).join(','));
  assert.equal(env.capacityValue().maxActiveSubagents, 64, '写入必须落到容量配置');
  assert.equal(env.configValue().maxMembers, undefined, '插件命名空间里不存在 maxMembers');
});

test('成员容量与深度同写：填了深度就两条 op，留空就只写容量', async () => {
  const withDepth = limitEnv();
  const first = await limitPanel(withDepth);
  submitCapacity(first.panel, first.tree, '64', '3');
  await settle();
  assert.equal(withDepth.capacityMutations.length, 1);
  assert.deepEqual(plain(withDepth.capacityMutations[0].operations.map(function (op) { return op.path[0]; })),
    ['maxActiveSubagents', 'maxDepth'], '深度输入非空必须一并写入');
  assert.equal(withDepth.capacityValue().maxDepth, 3);

  const withoutDepth = limitEnv();
  const second = await limitPanel(withoutDepth);
  submitCapacity(second.panel, second.tree, '64', '');
  await settle();
  assert.deepEqual(plain(withoutDepth.capacityMutations[0].operations.map(function (op) { return op.path[0]; })),
    ['maxActiveSubagents'], '深度留空不得改动宿主 maxDepth');
  assert.equal(withoutDepth.capacityValue().maxDepth, 2, '未填深度时宿主深度保持不变');
});

test('成员容量与宿主当前值相同：零写入并说明无需写入', async () => {
  const env = limitEnv({ capacity: { value: { maxActiveSubagents: 64, maxDepth: 2 }, revision: 4 } });
  const { panel, tree } = await limitPanel(env);
  const current = submitCapacity(panel, tree, '64', '2');
  await settle();
  assert.equal(env.capacityMutations.length, 0, '与当前值一致时不得写宿主');
  const ok = findByClass(current, 'fsx-feedback--ok');
  assert.equal(ok.length, 1, '必须给出一条「无需写入」说明');
  assert.ok(textOf(ok[0].children).indexOf('无需写入') >= 0, textOf(ok[0].children));
});

test('nested 模式深度不足：面板点名宿主深度上限并给出后果，flat 模式不给该告警', async () => {
  const nested = limitEnv({ capacity: { value: { maxActiveSubagents: 8, maxDepth: 1 }, revision: 4 } });
  const nestedTree = (await limitPanel(nested)).tree;
  const alerts = findByClass(nestedTree, 'fsx-feedback--error').filter(function (node) {
    return node.props.role === 'alert';
  });
  assert.equal(alerts.length, 1, 'nested + 深度 1 必须恰好一条深度告警');
  const message = textOf(alerts[0].children);
  assert.ok(message.indexOf('嵌套深度上限只有 1') >= 0, message);
  assert.ok(message.indexOf('拒绝') >= 0, '告警必须说明后果：' + message);

  const flat = limitEnv({
    config: { enabled: true, mode: 'flat', workspaces: {} },
    capacity: { value: { maxActiveSubagents: 8, maxDepth: 1 }, revision: 4 },
  });
  const flatTree = (await limitPanel(flat)).tree;
  assert.equal(findByClass(flatTree, 'fsx-feedback--error').filter(function (node) {
    return node.props.role === 'alert';
  }).length, 0, 'flat 模式不派子代理，不得出现深度告警');
});

test('成员容量失败态：宿主拒绝写入(mutate 拒绝)时贴出宿主原文且配置不被改', async () => {
  const env = limitEnv({ capacityReject: 'Config field "maxActiveSubagents" is not volatile' });
  const { panel, tree } = await limitPanel(env);
  submitCapacity(panel, tree, '12');
  await settle();
  const current = panel.render();
  const errors = findByClass(current, 'fsx-feedback--error');
  assert.equal(errors.length, 1, '宿主拒绝写入必须只给一条错误');
  const message = textOf(errors[0].children);
  assert.ok(message.indexOf('maxActiveSubagents') >= 0 && message.indexOf('is not volatile') >= 0,
    '必须贴出宿主原文：' + message);
  assert.equal(env.capacityValue().maxActiveSubagents, 8, '宿主拒绝写入时容量配置不得被改');
});

test('成员容量失败态：mutate 同步抛错同样落到错误文案，不冒泡炸面板', async () => {
  const env = limitEnv({ capacityReject: 'home patch 覆盖该字段，写入被拒绝', capacityRejectThrows: true });
  const { panel, tree } = await limitPanel(env);
  submitCapacity(panel, tree, '12');
  await settle();
  const current = panel.render();
  const errors = findByClass(current, 'fsx-feedback--error');
  assert.equal(errors.length, 1);
  assert.ok(textOf(errors[0].children).indexOf('home patch 覆盖该字段') >= 0, textOf(errors[0].children));
});

test('成员容量失败态：宿主没有 subagent 命名空间时按钮禁用并说明尚未读取', async () => {
  const env = limitEnv({ capacity: null });
  const { tree } = await limitPanel(env);
  const apply = limitApply(tree);
  assert.equal(apply.props.disabled, true, '命名空间不可用时不得允许写入');
  assert.equal(env.capacityMutations.length, 0, '命名空间不可用时不得发起写入');
  const hints = findByClass(tree, 'fsx-hint').filter(function (node) { return node.props.role === 'status'; });
  assert.equal(hints.length, 1);
  assert.ok(textOf(hints[0].children).indexOf('尚未从宿主读取') >= 0, textOf(hints[0].children));
});

test('parseMemberLimit 与 parseDepthLimit：只接受各自区间内的整数，拒绝时说明收到了什么', () => {
  const { __test } = limitEnv().plugin;

  [['1', 1], ['100000', 100000], [' 64 ', 64], ['064', 64], [64, 64], [1, 1], ['1024', 1024]]
    .forEach(function (pair) {
      const parsed = __test.parseMemberLimit(pair[0]);
      assert.equal(parsed.ok, true, JSON.stringify(pair[0]) + ' 应当合法');
      assert.equal(parsed.limit, pair[1]);
      assert.equal(parsed.error, undefined);
    });

  ['', '   ', '0', '00', '-1', '100001', '100001.0', '1.5', '1e3', '0x10', '１０', 'abc', '64px', 'NaN', 'Infinity']
    .forEach(function (raw) {
      const parsed = __test.parseMemberLimit(raw);
      assert.equal(parsed.ok, false, JSON.stringify(raw) + ' 必须被拒绝');
      assert.equal(parsed.limit, undefined);
      assert.ok(parsed.error.indexOf('成员容量') >= 0);
      assert.ok(parsed.error.indexOf('收到') >= 0, '拒绝必须说明收到了什么：' + parsed.error);
    });

  [null, undefined, {}, [], true, false, Number.NaN].forEach(function (raw) {
    const parsed = __test.parseMemberLimit(raw);
    assert.equal(parsed.ok, false, String(raw) + ' 必须被拒绝');
    assert.ok(parsed.error.indexOf('正整数') >= 0);
  });

  assert.ok(__test.parseMemberLimit('100001').error.indexOf('100000') >= 0, '拒绝理由必须暴露护栏上限');

  [['0', 0], ['1', 1], ['2', 2], [' 3 ', 3], [1024, 1024]].forEach(function (pair) {
    const parsed = __test.parseDepthLimit(pair[0]);
    assert.equal(parsed.ok, true, JSON.stringify(pair[0]) + ' 的深度取值应当合法');
    assert.equal(parsed.depth, pair[1]);
  });
  ['', '  ', '-1', '1.5', 'abc'].forEach(function (raw) {
    const parsed = __test.parseDepthLimit(raw);
    assert.equal(parsed.ok, false, JSON.stringify(raw) + ' 的深度取值必须被拒绝');
    assert.ok(parsed.error.indexOf('嵌套深度') >= 0, parsed.error);
    assert.ok(parsed.error.indexOf('收到') >= 0, parsed.error);
  });

  assert.deepEqual(plain(__test.parseCapacitySnapshot({ status: 'loading', value: null })), { limit: null, depth: null });
  assert.deepEqual(plain(__test.parseCapacitySnapshot({ status: 'ready', value: { maxActiveSubagents: 16 } })), { limit: 16, depth: null });
  assert.ok(__test.capacityStatusText({ status: 'ready', value: { maxActiveSubagents: 16, maxDepth: 2 } }).text.indexOf('嵌套深度上限 2') >= 0);
  assert.equal(__test.capacityStatusText({ status: 'unavailable', value: null }), null, '未就绪快照不得伪造当前值');
});
