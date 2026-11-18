/**
 * 「保存设置到所有工作区」的行为测试。
 *
 * 落点理由：仓库约定每个测试文件自包含、不抽公共 fixture，而本用例需要的是与
 * client-ui-behavior.test.js 相同的可运行 React 替身（真 useState/useEffect）。
 * 直接扩展那个 896 行的文件会和正在并行改 client.js 的同一轮改动挤在同一处，
 * 所以这里自包含地复制同一套 harness（imports → makeEnv → settle → CATALOG_OK），
 * 只写「广播到所有工作区」这一条契约。
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
  var configStatus = 'ready';

  var form = {
    getSnapshot() {
      return { status: configStatus, value: configValue, revision: configRevision, writable: true };
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
    /**
     * 模拟「另一个写入者改了宿主配置」：只换快照并通知订阅者，不经过面板的 mutate。
     * 用来验证面板的显示是否真的跟着宿主快照走，而不是停在首次读数上。
     */
    setConfig(partial, revision) {
      var merged = {};
      Object.keys(configValue === null || configValue === undefined ? {} : configValue).forEach(function (name) {
        merged[name] = configValue[name];
      });
      Object.keys(partial).forEach(function (name) { merged[name] = partial[name]; });
      configValue = merged;
      configRevision = revision === undefined ? configRevision + 1 : revision;
      configStatus = 'ready';
      formSubs.forEach(function (listener) { listener(); });
    },
    /** 模拟宿主把 Config 表单撤成不可读（表单被别处关掉、宿主侧降级）：面板不得继续假装就绪。 */
    breakConfig() {
      configStatus = 'unavailable';
      formSubs.forEach(function (listener) { listener(); });
    },
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
// ==== 广播契约用例 ====

/** 三个模型才能区分成员 / 子代理 / 审查三条路由；两个模型时路由互换看不出来。 */
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

/** 三个真实工作区条目；广播必须覆盖全部三个，而不只是当前选中的那一个。 */
const WORKSPACE_ITEMS = [
  { path: '/repo/a', title: '仓库 A', workspaceId: 'w1', sessionIds: ['s1'] },
  { path: '/repo/b', title: '仓库 B', workspaceId: 'w2', sessionIds: ['s2'] },
  { path: '/repo/c', title: '仓库 C', workspaceId: 'w3', sessionIds: ['s3'] },
];

const NO_POLICY = { status: 'ready', value: { enabled: false, allowedModels: [] } };

/** 与 client-ui-behavior.test.js 同构（该文件自带的同名 helper 不在本文件的 harness 切片里）。 */
function findByClass(tree, tone) {
  return collectNodes(tree).filter(function (node) {
    return (node.props.className || '').indexOf(tone) >= 0;
  });
}

function saveAllButton(tree) {
  const found = findById(tree, 'fsx-save-all');
  assert.equal(found.length, 1, '「保存设置到所有工作区」必须存在且有且只有一个（id=fsx-save-all）');
  assert.equal(found[0].type, 'button', '按钮必须是 button');
  assert.equal(textOf(found[0].children), '保存设置到所有工作区', '文案必须写明作用范围，不能只是「保存」换个位置');
  assert.equal(found[0].props.type, 'button', '不能是 submit，否则回车也会触发广播写入');
  assert.equal(typeof found[0].props.onClick, 'function', '没有 onClick 的按钮是摆设');
  return found[0];
}

/** 旧的单工作区保存按钮：按 id 定位。新按钮的文案包含「保存设置」子串，写入中时旧按钮文案又变成
 *  「保存中…」，按文案找会误判，所以两个按钮都靠 id 取。 */
function primarySaveButton(tree) {
  const found = findById(tree, 'fsx-save');
  assert.equal(found.length, 1, '单个保存按钮必须存在且有且只有一个（id=fsx-save）');
  assert.equal(typeof found[0].props.onClick, 'function', '没有 onClick 的单个保存按钮是摆设');
  return found[0];
}

function feedbackMessages(tree, tone) {
  return findByClass(tree, tone).map(function (node) { return textOf(node.children); });
}

async function openPanel(env, key) {
  const panel = env.panel();
  panel.render();
  await settle();
  let tree = panel.render();
  if (key !== null) {
    const selects = findById(tree, 'fsx-workspace');
    assert.equal(selects.length, 1, '工作区下拉不存在，选不到工作区');
    selects[0].props.onChange({ target: { value: key } });
    tree = panel.render();
    tree = panel.render();
  }
  return { panel, tree };
}

/** 显式把两条路由设成互不相同的值：provider 变更会自动带出该 provider 的首个模型，
 *  所以成员路由刻意再改成第二个模型，避免断言恰好落在自动默认值上、掩盖 member/subagent 互换。 */
function setRoutes(panel, tree, member, subagent) {
  let current = tree;
  findById(current, 'fsx-memberProvider')[0].props.onChange({ target: { value: member[0] } });
  current = panel.render();
  findById(current, 'fsx-memberModel')[0].props.onChange({ target: { value: member[1] } });
  current = panel.render();
  findById(current, 'fsx-subagentProvider')[0].props.onChange({ target: { value: subagent[0] } });
  current = panel.render();
  findById(current, 'fsx-subagentModel')[0].props.onChange({ target: { value: subagent[1] } });
  return panel.render();
}

function workspacesOp(operations) {
  const found = plain(operations).filter(function (op) { return op.path.join('.') === 'workspaces'; });
  assert.equal(found.length, 1, '必须且只能有一个 workspaces 整表 set');
  return found[0].value;
}

/** 按路径取载荷里的值：缺项直接失败，不给「跳过某一项」留后路。 */
function opOf(operations, name) {
  const found = plain(operations).filter(function (op) { return op.path.join('.') === name; });
  assert.equal(found.length, 1, '载荷里必须且只能有一个 ' + name + ' set op');
  return found[0].value;
}

/** 全局开关与模式两个控件的当前读数：面板显示什么，用户就会以为宿主是什么。 */
function globalSwitches(tree) {
  const checkbox = findById(tree, 'fsx-enabled');
  const select = findById(tree, 'fsx-mode');
  assert.equal(checkbox.length, 1, '全局开关必须存在且有且只有一个（id=fsx-enabled）');
  assert.equal(checkbox[0].props.type, 'checkbox', '全局开关必须是 checkbox');
  assert.equal(select.length, 1, '委派模式必须存在且有且只有一个（id=fsx-mode）');
  assert.deepEqual(optionValues(select[0]), ['nested', 'flat'], '模式下拉必须只有 nested / flat 两个取值');
  return { enabled: checkbox[0].props.checked, mode: select[0].props.value };
}

/** 某个 select 的当前读数。 */
function selectValue(tree, id) {
  const found = findById(tree, id);
  assert.equal(found.length, 1, '控件 ' + id + ' 必须存在且有且只有一个');
  return found[0].props.value;
}

/**
 * 跨按钮引导句（「保存设置」不行就改用广播）在两个按钮门槛一致后就是误导：
 * 它会告诉用户「只改全局开关与委派模式」可以绕开选中要求，而新语义下广播同样要先选中。
 */
function assertNoCrossButtonGuidance(tree) {
  const offenders = collectNodes(tree)
    .map(function (node) { return textOf(node.children); })
    .filter(function (text) { return text.indexOf('只改全局开关与委派模式') >= 0; });
  assert.deepEqual(offenders, [],
    '两个按钮都要求先选中工作区后，不得再出现「只改全局开关与委派模式时，用……写入」这类跨按钮引导');
}

/**
 * 「要先选中工作区」这条禁用原因的表达可以是「请选择工作区」或「请先选择一个工作区，再应用到所有已枚举的工作区」，
 * 断言按语义取「选择」+「工作区」两个词，不锁具体措辞，也不放过含糊的「不可用」。
 */
function assertAsksToPickWorkspace(text, context) {
  assert.equal(typeof text === 'string' && text.length > 0, true, context + '：禁用原因不得为空');
  assert.ok(text.indexOf('选择') >= 0 && text.indexOf('工作区') >= 0,
    context + '必须告诉用户先选择工作区：' + text);
}

/** 紧跟在广播按钮之后的那几条 hint（广播按钮自己的说明），不能拿页面上别的 fsx-hint 顶数。 */
function broadcastHintTexts(tree) {
  const nodes = collectNodes(tree);
  const index = nodes.findIndex(function (node) { return node.props.id === 'fsx-save-all'; });
  assert.ok(index >= 0, '广播按钮不存在，找不到它自己的说明文案');
  const own = [];
  for (var i = index + 1; i < nodes.length
    && nodes[i].type === 'p' && (nodes[i].props.className || '').indexOf('fsx-hint') >= 0; i++) {
    own.push(textOf(nodes[i].children));
  }
  assert.ok(own.length >= 1, '广播按钮必须自带说明写入内容与范围的 hint');
  return own;
}

test('广播按钮与单个保存一样要求先选中工作区：未选中时禁用、点击零写入，选中后才可用', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 11 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, null);

  const broadcast = saveAllButton(tree);
  assert.equal(broadcast.props.disabled, true,
    '广播要写进每个工作区的模型路由就是选中那个工作区 draft 里的，未选中必须禁用');
  assertAsksToPickWorkspace(broadcast.props.title, '未选中时广播按钮的 title');
  broadcast.props.onClick();
  assert.equal(env.mutations.length, 0, '未选中工作区时点击广播不得产生任何 mutate');

  const blocked = panel.render();
  const errors = feedbackMessages(blocked, 'fsx-feedback--error');
  assert.equal(errors.length, 1, '被门禁拦下时必须就地说明为什么没写');
  assertAsksToPickWorkspace(errors[0], '被拦下时的提示');
  assert.equal(findByClass(blocked, 'fsx-feedback--ok').length, 0, '零写入不得冒充成功');

  assert.equal(primarySaveButton(tree).props.disabled, true, '未选工作区时单个保存必须禁用');
  assert.equal(textOf(primarySaveButton(tree).children), '保存设置', '两个按钮必须靠文案区分作用范围');
  assert.deepEqual(optionValues(findById(tree, 'fsx-workspace')[0]), ['', '/repo/a', '/repo/b', '/repo/c'],
    '「所有」必须来自真实枚举的工作区列表');
  assertNoCrossButtonGuidance(tree);

  findById(blocked, 'fsx-workspace')[0].props.onChange({ target: { value: '/repo/a' } });
  panel.render();
  const selected = panel.render();
  assert.equal(saveAllButton(selected).props.disabled, false, '选中工作区后广播必须可用');
  assertNoCrossButtonGuidance(selected);
});

test('选中工作区后又把下拉切回「未选择」：广播必须重新禁用、点击零写入，宿主各工作区路由一字不变', async () => {
  const CFG = {
    enabled: true,
    mode: 'flat',
    workspaces: {
      '/repo/a': { member: { provider: 'old', model: 'old' }, subagent: { provider: 'old', model: 'old' }, note: 'keep-a' },
      '/legacy': { member: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' },
    },
  };
  const env = makeEnv({
    config: { value: plain(CFG), revision: 81 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');
  const routed = setRoutes(panel, tree, ['dp', 'm2'], ['dp', 'm1']);
  assert.equal(saveAllButton(routed).props.disabled, false, '选中工作区且路由成对时必须可广播');
  assert.equal(selectValue(routed, 'fsx-memberModel'), 'm2', 'draft 必须已被用户改成 dp/m2');

  // 用户把下拉切回「未选择」：此时面板里还留着刚才那套 draft。若按钮还让点，
  // 一次点击就会把「只属于 /repo/a 的路由」推到所有工作区去，所以必须重新禁用。
  findById(routed, 'fsx-workspace')[0].props.onChange({ target: { value: '' } });
  const back = panel.render();
  const broadcast = saveAllButton(back);
  assert.equal(broadcast.props.disabled, true, '撤掉选中后广播必须重新禁用，不能靠陈旧 draft 继续可点');
  assertAsksToPickWorkspace(broadcast.props.title, '撤掉选中后广播按钮的 title');
  broadcast.props.onClick();
  assert.equal(env.mutations.length, 0, '撤掉选中后点击广播必须零 mutate');

  await settle();
  const done = panel.render();
  const errors = feedbackMessages(done, 'fsx-feedback--error');
  assert.equal(errors.length, 1, '被门禁拦下时必须就地说明为什么没写');
  assertAsksToPickWorkspace(errors[0], '撤掉选中后的提示');
  assert.equal(findByClass(done, 'fsx-feedback--ok').length, 0, '零写入不得冒充成功');
  assert.deepEqual(plain(env.configValue().workspaces), plain(CFG.workspaces),
    '宿主各工作区路由必须一字不变，包括刚才只在 draft 里改过的那套');
});

test('广播载荷：只选中一个工作区也只写一次 mutate，workspaces 覆盖全部枚举 key 且保留既有条目的其它字段', async () => {
  const env = makeEnv({
    config: {
      value: {
        enabled: true,
        mode: 'flat',
        workspaces: {
          '/repo/a': { member: { provider: 'old', model: 'old' }, subagent: { provider: 'old', model: 'old' }, note: 'keep-a' },
          '/legacy': { member: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' },
        },
      },
      revision: 11,
    },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/b');
  const routed = setRoutes(panel, tree, ['dp', 'm2'], ['dp', 'm1']);

  const broadcast = saveAllButton(routed);
  assert.equal(broadcast.props.disabled, false, '路由合法且枚举到工作区时必须可广播');
  broadcast.props.onClick();

  assert.equal(env.mutations.length, 1, '广播必须是一次原子写入，不能逐工作区 mutate 多次');
  const call = env.mutations[0];
  assert.equal(typeof call.revision, 'number', 'revision 围栏必须是数字');
  assert.equal(call.revision, 11, '必须带上读取快照的 revision，否则并发写会覆盖别人的改动');

  const ROUTE_MEMBER = { provider: 'dp', model: 'm2' };
  const ROUTE_SUBAGENT = { provider: 'dp', model: 'm1' };
  assert.deepEqual(plain(call.operations), [
    { op: 'set', path: ['enabled'], value: true },
    {
      op: 'set',
      path: ['workspaces'],
      value: {
        '/repo/a': { member: ROUTE_MEMBER, subagent: ROUTE_SUBAGENT, reviewer: { provider: '', model: '' }, note: 'keep-a' },
        '/repo/b': { member: ROUTE_MEMBER, subagent: ROUTE_SUBAGENT, reviewer: { provider: '', model: '' } },
        '/repo/c': { member: ROUTE_MEMBER, subagent: ROUTE_SUBAGENT, reviewer: { provider: '', model: '' } },
        '/legacy': { member: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' },
      },
    },
    { op: 'set', path: ['mode'], value: 'flat' },
  ], '载荷必须只有 enabled/workspaces/mode，且每个枚举键都拿到当前 draft 的三条路由');

  await settle();
  const done = panel.render();
  const okMessages = feedbackMessages(done, 'fsx-feedback--ok');
  assert.equal(okMessages.length, 1, '成功只能落一条反馈');
  const matched = okMessages[0].match(/已写入\s*(\d+)\s*个工作区/);
  assert.ok(matched, '成功提示必须说明写入了几个工作区：' + okMessages[0]);
  assert.equal(Number(matched[1]), 3, '提示里的数量必须等于真实枚举到的工作区数（/legacy 只是保留，不是广播对象）');
  assert.ok(/开关|启用/.test(okMessages[0]) && /模式/.test(okMessages[0]),
    '广播同时写了全局 enabled / mode，提示必须一并说明，不能只报工作区数量：' + okMessages[0]);
  assert.equal(findByClass(done, 'fsx-feedback--error').length, 0, '成功不得同时落 error');
});

test('广播带上审查路由：draft 里的 reviewer 写到每个枚举工作区并覆盖旧值，未枚举到的条目原样保留', async () => {
  const env = makeEnv({
    config: {
      value: {
        enabled: true,
        mode: 'nested',
        workspaces: {
          '/repo/a': { member: { provider: 'dp', model: 'm1' }, subagent: { provider: 'dp', model: 'm1' }, reviewer: { provider: 'stale', model: 'stale-model' }, note: 'keep-a' },
          '/legacy': { member: { provider: 'lp', model: 'lm' }, reviewer: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' },
        },
      },
      revision: 33,
    },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG3,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');

  assert.equal(selectValue(tree, 'fsx-reviewerProvider'), 'stale', 'draft 的审查路由必须来自选中工作区的既有条目');
  assert.equal(selectValue(tree, 'fsx-reviewerModel'), 'stale-model', 'draft 的审查 model 同样必须回读到位');

  const routed = setRoutes(panel, tree, ['dp', 'm3'], ['dp', 'm1']);
  findById(routed, 'fsx-reviewerProvider')[0].props.onChange({ target: { value: 'dp' } });
  const afterProvider = panel.render();
  assert.equal(selectValue(afterProvider, 'fsx-reviewerModel'), 'm1', '换 provider 必须自动带出该 provider 的首个模型');
  findById(afterProvider, 'fsx-reviewerModel')[0].props.onChange({ target: { value: 'm2' } });
  const done = panel.render();

  const broadcast = saveAllButton(done);
  assert.equal(broadcast.props.disabled, false, '三组路由各自成对时广播必须可用');
  broadcast.props.onClick();

  assert.equal(env.mutations.length, 1, '广播仍必须是一次原子写入');
  const call = env.mutations[0];
  assert.equal(call.revision, 33);
  const operations = plain(call.operations);
  const written = opOf(operations, 'workspaces');
  assert.deepEqual(Object.keys(written).sort(), ['/legacy', '/repo/a', '/repo/b', '/repo/c'],
    '必须覆盖全部枚举键并保留既有键');
  ['/repo/a', '/repo/b', '/repo/c'].forEach(function (key) {
    assert.deepEqual(
      { member: written[key].member, subagent: written[key].subagent, reviewer: written[key].reviewer },
      {
        member: { provider: 'dp', model: 'm3' },
        subagent: { provider: 'dp', model: 'm1' },
        reviewer: { provider: 'dp', model: 'm2' },
      }, key + ' 必须拿到三条路由，且审查路由覆盖旧的 stale 值而不是残留');
  });
  assert.equal(written['/repo/a'].note, 'keep-a', '广播不得顺手丢掉条目上的未知字段');
  assert.deepEqual(written['/legacy'], { member: { provider: 'lp', model: 'lm' }, reviewer: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' },
    '没被枚举到的旧条目连它自己的 reviewer 都必须原样保留');

  await settle();
  assert.equal(findByClass(panel.render(), 'fsx-feedback--error').length, 0, '合法写入不得落 error');
});

test('只有审查路由不成对时广播按钮同样禁用，点击零写入并点名「审查代码模型」', async () => {
  const env = makeEnv({
    config: {
      value: {
        enabled: true,
        workspaces: {
          '/repo/a': { member: { provider: 'dp', model: 'm1' }, subagent: { provider: 'dp', model: 'm2' }, reviewer: { provider: 'dp', model: '' } },
        },
      },
      revision: 34,
    },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');

  const broadcast = saveAllButton(tree);
  assert.equal(broadcast.props.disabled, true, '审查路由半对也必须禁用广播——写错会污染全部工作区');
  assert.ok((broadcast.props.title || '').indexOf('成对') >= 0, '禁用时必须用 title 说明原因：' + broadcast.props.title);
  assert.ok((broadcast.props.title || '').indexOf('审查代码模型') >= 0,
    'title 必须点名是哪张卡不成对：' + broadcast.props.title);
  broadcast.props.onClick();
  assert.equal(env.mutations.length, 0, '禁用状态下点击不得产生 mutate');

  const visible = textOf(panel.render());
  assert.ok(visible.indexOf('审查代码模型') >= 0, '可见禁用原因必须点名审查卡，不能只挂在 title 上');
});

test('选中工作区后广播把当前 draft（继承默认）写到每个枚举工作区，并保留既有键与未知字段', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: { '/legacy': { member: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' } } }, revision: 5 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');

  const broadcast = saveAllButton(tree);
  assert.equal(broadcast.props.disabled, false, '选中工作区且路由合法时必须可广播');
  broadcast.props.onClick();

  assert.equal(env.mutations.length, 1);
  assert.equal(env.mutations[0].revision, 5);
  const operations = plain(env.mutations[0].operations);
  assert.deepEqual(operations.map(function (op) { return op.path.join('.'); }).sort(), ['enabled', 'mode', 'workspaces'],
    '广播载荷必须恰好是开关 / 模式 / 工作区三项；不能再把某一项 slice 掉不作断言');
  assert.equal(opOf(operations, 'enabled'), true, '宿主 enabled=true 必须原样写回');
  assert.equal(opOf(operations, 'mode'), 'nested', '宿主没提供 mode 时必须写当前显示的 nested，不能漏掉该字段');

  const written = opOf(operations, 'workspaces');
  assert.deepEqual(Object.keys(written).sort(), ['/legacy', '/repo/a', '/repo/b', '/repo/c'],
    '必须覆盖全部枚举键，并且不丢既有配置里的其它键');
  ['/repo/a', '/repo/b', '/repo/c'].forEach(function (key) {
    assert.deepEqual(written[key], { member: { provider: '', model: '' }, subagent: { provider: '', model: '' }, reviewer: { provider: '', model: '' } },
      key + ' 没选路由时必须写成继承默认，而不是留下 undefined');
  });
  assert.deepEqual(written['/legacy'], { member: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' },
    '没被枚举到的旧配置必须原样保留');

  await settle();
  const done = panel.render();
  assert.equal(findByClass(done, 'fsx-feedback--error').length, 0);
  assert.equal(env.configValue().workspaces['/legacy'].extra, 'keep-legacy', '宿主回写后旧配置仍然在');
});

test('选中工作区后用户主动把 draft 全清空（继承默认）：广播必须仍可用并写入继承默认，不得当成非法', async () => {
  const env = makeEnv({
    config: {
      value: {
        enabled: false,
        mode: 'flat',
        workspaces: {
          '/repo/a': { member: { provider: 'dp', model: 'm1' }, subagent: { provider: 'dp', model: 'm2' } },
          '/legacy': { member: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' },
        },
      },
      revision: 91,
    },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');
  assert.equal(saveAllButton(tree).props.disabled, false, '既有条目路由成对时必须可广播');
  assert.equal(selectValue(tree, 'fsx-memberProvider'), 'dp', 'draft 必须来自 /repo/a 的既有条目');
  assert.equal(selectValue(tree, 'fsx-subagentModel'), 'm2', 'draft 必须来自 /repo/a 的既有条目');

  // 用户主动把两条路由都清成「继承默认」：provider 置空会连带清空 model。同空是合法值，
  // 不是「不成对」；把它禁掉等于让用户永远无法把继承默认推到所有工作区，而 hint 已明说写的是选中工作区的路由。
  findById(tree, 'fsx-memberProvider')[0].props.onChange({ target: { value: '' } });
  const afterMember = panel.render();
  findById(afterMember, 'fsx-subagentProvider')[0].props.onChange({ target: { value: '' } });
  const cleared = panel.render();
  assert.deepEqual([
    selectValue(cleared, 'fsx-memberProvider'), selectValue(cleared, 'fsx-memberModel'),
    selectValue(cleared, 'fsx-subagentProvider'), selectValue(cleared, 'fsx-subagentModel'),
    selectValue(cleared, 'fsx-reviewerProvider'), selectValue(cleared, 'fsx-reviewerModel'),
  ], ['', '', '', '', '', ''], '清空后的 draft 必须六项都空，不得残留旧模型');

  const broadcast = saveAllButton(cleared);
  assert.equal(broadcast.props.disabled, false, '选中工作区 + 全空 draft 是合法组合，广播必须仍可用');
  broadcast.props.onClick();

  assert.equal(env.mutations.length, 1, '广播必须只有一次 mutate');
  const call = env.mutations[0];
  assert.equal(call.revision, 91, 'revision 围栏必须是读取快照的 revision');
  const operations = plain(call.operations);
  assert.equal(opOf(operations, 'enabled'), false, '用户没动开关时必须写宿主真值 false，不得凭空启用');
  assert.equal(opOf(operations, 'mode'), 'flat', '用户没动模式时必须写宿主真值 flat');
  const written = opOf(operations, 'workspaces');
  assert.deepEqual(Object.keys(written).sort(), ['/legacy', '/repo/a', '/repo/b', '/repo/c'],
    '必须覆盖全部枚举键并保留既有键');
  ['/repo/a', '/repo/b', '/repo/c'].forEach(function (key) {
    assert.deepEqual(written[key], { member: { provider: '', model: '' }, subagent: { provider: '', model: '' }, reviewer: { provider: '', model: '' } },
      key + ' 必须被写成继承默认——这正是用户清空 draft 想要的结果');
  });
  assert.deepEqual(written['/legacy'], { member: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' },
    '未枚举到的旧条目必须原样保留');

  await settle();
  const settled = panel.render();
  assert.equal(findByClass(settled, 'fsx-feedback--error').length, 0, '合法写入不得落 error');
  assert.equal(findByClass(settled, 'fsx-feedback--ok').length, 1, '成功只能落一条反馈');
});

test('draft 非法（provider 有值而 model 为空）时广播按钮禁用，点击不写入并说明原因', async () => {
  const env = makeEnv({
    config: {
      value: { enabled: true, workspaces: { '/repo/a': { member: { provider: 'dp', model: '' }, subagent: { provider: '', model: '' } } } },
      revision: 3,
    },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');

  const broadcast = saveAllButton(tree);
  assert.equal(broadcast.props.disabled, true, '路由不成对时必须禁用广播——写错会污染全部工作区');
  assert.ok((broadcast.props.title || '').indexOf('成对') >= 0, '禁用时必须用 title 说明原因：' + broadcast.props.title);
  broadcast.props.onClick();
  assert.equal(env.mutations.length, 0, '禁用状态下点击不得产生 mutate');

  const current = panel.render();
  const errors = feedbackMessages(current, 'fsx-feedback--error');
  assert.equal(errors.length, 1, '被拦下时必须就地说明为什么没写');
  assert.ok(errors[0].indexOf('成对') >= 0, '提示要点名失败原因：' + errors[0]);
  assert.equal(findByClass(current, 'fsx-feedback--ok').length, 0);
});

test('一个工作区都没枚举到时广播按钮禁用，点击不写入并说明原因', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 2 },
    policy: NO_POLICY,
    workspaces: [],
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, null);

  const broadcast = saveAllButton(tree);
  assert.equal(broadcast.props.disabled, true, '没有工作区可写时必须禁用，而不是点了什么也不发生');
  assert.ok((broadcast.props.title || '').indexOf('工作区') >= 0, '禁用时必须用 title 说明是没枚举到工作区：' + broadcast.props.title);
  assert.equal(findByClass(tree, 'fsx-empty').length, 1, '一个工作区都没枚举到时，面板必须明说没找到工作区（未选中也就无从选中）');
  broadcast.props.onClick();
  assert.equal(env.mutations.length, 0);

  const current = panel.render();
  const errors = feedbackMessages(current, 'fsx-feedback--error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].indexOf('工作区') >= 0, '必须说明是没找到工作区：' + errors[0]);
  assert.equal(findByClass(current, 'fsx-feedback--ok').length, 0);
});

test('宿主否决（mutate 返回 false）：落重试类错误、busy 复位、不冒充成功、本地配置不被提前改掉', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: { '/repo/a': { member: { provider: 'dp', model: 'm1' }, extra: 'keep-a' } } }, revision: 9 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  env.form.mutate = function () { return false; };

  const { panel, tree } = await openPanel(env, '/repo/a');
  assert.equal(saveAllButton(tree).props.disabled, false);
  saveAllButton(tree).props.onClick();

  const busyTree = panel.render();
  assert.equal(saveAllButton(busyTree).props.disabled, true, '写入进行中必须禁用，避免并发双写');
  assert.equal(textOf(primarySaveButton(busyTree).children), '保存中…', 'busy 是共享状态：广播写入期间单个保存也必须显示保存中');

  await settle();
  const done = panel.render();
  const errors = findByClass(done, 'fsx-feedback--error');
  assert.equal(errors.length, 1, '否决必须只落一条错误反馈');
  assert.equal(errors[0].props.role, 'alert', '错误必须是 alert，读屏才播报');
  assert.ok(textOf(errors[0].children).indexOf('重试') >= 0, '必须给出下一步动作：' + textOf(errors[0].children));
  assert.equal(findByClass(done, 'fsx-feedback--ok').length, 0, '否决不得显示成功提示');
  assert.equal(saveAllButton(done).props.disabled, false, 'busy 必须复位，否则用户再也无法重试');
  assert.equal(textOf(primarySaveButton(done).children), '保存设置', 'busy 复位后单个保存按钮也必须恢复');
  assert.deepEqual(plain(env.configValue().workspaces), {
    '/repo/a': { member: { provider: 'dp', model: 'm1' }, extra: 'keep-a' },
  }, '宿主否决后本地配置不得被乐观改掉');
});

test('宿主抛错（mutate reject）：贴出宿主原文、busy 复位可重试、不产生成功提示', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: {} }, revision: 4 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  env.form.mutate = function () {
    return Promise.reject(new Error('Config scope "force-subagent" is read-only'));
  };

  const { panel, tree } = await openPanel(env, '/repo/a');
  saveAllButton(tree).props.onClick();
  await settle();
  const done = panel.render();

  const errors = feedbackMessages(done, 'fsx-feedback--error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].indexOf('read-only') >= 0, '必须贴出宿主原文而不是吞成一句通用失败：' + errors[0]);
  assert.equal(findByClass(done, 'fsx-feedback--ok').length, 0);
  assert.equal(saveAllButton(done).props.disabled, false, '抛错后 busy 必须复位');
  assert.deepEqual(plain(env.configValue().workspaces), {}, '抛错路径不得留下任何本地写入');
});

// ==== 返工补测试：广播写的必须是宿主真值，以及文案与反馈互斥 ====

/**
 * 上一轮 7 条广播用例的 Config 全是 enabled:true，正好等于面板 useState 的默认值，
 * 于是「写的是宿主真值还是未初始化的默认值」被 fixture 完全罩住。
 * 这里四种组合同时跑：既钉死「必须写宿主真值」，也让「只把 false/flat 写死」的伪修复当场变红。
 * 每组还先确认「未选中 → 禁用 + 点击零写入」，让门禁与真值两半在同一条用例里互相钉住。
 */
const HOST_SWITCH_CASES = [
  { enabled: false, mode: 'flat' },
  { enabled: true, mode: 'nested' },
  { enabled: false, mode: 'nested' },
  { enabled: true, mode: 'flat' },
];

HOST_SWITCH_CASES.forEach(function (host) {
  test('先选中再广播时必须写宿主真值：enabled=' + host.enabled + ' / mode=' + host.mode + '（不是面板默认值）', async () => {
    const env = makeEnv({
      config: {
        value: {
          enabled: host.enabled,
          mode: host.mode,
          workspaces: { '/legacy': { member: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' } },
        },
        revision: 21,
      },
      policy: NO_POLICY,
      workspaces: WORKSPACE_ITEMS,
      catalog: CATALOG_OK,
    });
    const { panel, tree } = await openPanel(env, null);

    const unselected = saveAllButton(tree);
    assert.equal(unselected.props.disabled, true, '未选中工作区时广播必须禁用：要广播的模型路由来自选中那个工作区的 draft');
    assertAsksToPickWorkspace(unselected.props.title, '未选中时广播按钮的 title');
    unselected.props.onClick();
    assert.equal(env.mutations.length, 0, '未选中时点击广播不得写入任何宿主配置');

    findById(tree, 'fsx-workspace')[0].props.onChange({ target: { value: '/repo/a' } });
    panel.render();
    const selectedTree = panel.render();

    const shown = globalSwitches(selectedTree);
    assert.equal(shown.enabled, host.enabled,
      '宿主 enabled=' + host.enabled + ' 时勾选框必须显示宿主真值，不得停在面板 useState 默认值');
    assert.equal(shown.mode, host.mode,
      '宿主 mode=' + host.mode + ' 时模式下拉必须显示宿主真值，不得停在面板 useState 默认值');

    const broadcast = saveAllButton(selectedTree);
    assert.equal(broadcast.props.disabled, false, '选中工作区后广播必须可用');
    broadcast.props.onClick();

    assert.equal(env.mutations.length, 1, '广播必须只有一次 mutate，不能逐工作区写多次');
    const call = env.mutations[0];
    assert.equal(call.revision, 21, '必须带上读取快照的 revision 围栏');
    const operations = plain(call.operations);
    assert.deepEqual(operations.map(function (op) { return op.path.join('.'); }).sort(),
      ['enabled', 'mode', 'workspaces'], '广播必须同时写开关、模式与工作区路由三件事，不得 slice 掉任何一项');
    assert.equal(opOf(operations, 'enabled'), host.enabled, '写回的 enabled 必须是宿主真值');
    assert.equal(opOf(operations, 'mode'), host.mode, '写回的 mode 必须是宿主真值');
    const written = opOf(operations, 'workspaces');
    assert.deepEqual(Object.keys(written).sort(), ['/legacy', '/repo/a', '/repo/b', '/repo/c'],
      '必须覆盖全部枚举工作区且不丢既有键');
    assert.deepEqual(written['/legacy'], { member: { provider: 'lp', model: 'lm' }, extra: 'keep-legacy' },
      '没被枚举到的旧配置必须原样保留');
    ['/repo/a', '/repo/b', '/repo/c'].forEach(function (key) {
      assert.deepEqual(written[key], { member: { provider: '', model: '' }, subagent: { provider: '', model: '' }, reviewer: { provider: '', model: '' } },
        key + ' 必须拿到选中工作区 draft 的继承默认路由，不得留 undefined 让宿主条目消失');
    });

    await settle();
    const done = panel.render();
    assert.equal(findByClass(done, 'fsx-feedback--error').length, 0, '成功不得落 error');
    assert.equal(findByClass(done, 'fsx-feedback--ok').length, 1, '成功只能落一条反馈');
  });
});

test('选中工作区后用户手动改了全局开关与委派模式：广播必须写用户改后的值，而不是宿主快照原值', async () => {
  const env = makeEnv({
    config: {
      value: {
        enabled: false,
        mode: 'flat',
        workspaces: { '/repo/a': { member: { provider: 'dp', model: 'm1' }, subagent: { provider: 'dp', model: 'm2' } } },
      },
      revision: 41,
    },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');
  assert.deepEqual(globalSwitches(tree), { enabled: false, mode: 'flat' }, '起始必须显示宿主真值 false / flat');

  // 用户在点广播之前手动改了两项：false → true、flat → nested。用户改动必须胜出，不能被宿主原值覆盖。
  findById(tree, 'fsx-enabled')[0].props.onChange({ target: { checked: true } });
  const afterSwitch = panel.render();
  assert.deepEqual(globalSwitches(afterSwitch), { enabled: true, mode: 'flat' }, '勾选框必须立刻反映用户的改动');
  findById(afterSwitch, 'fsx-mode')[0].props.onChange({ target: { value: 'nested' } });
  const edited = panel.render();
  assert.deepEqual(globalSwitches(edited), { enabled: true, mode: 'nested' }, '模式下拉必须立刻反映用户的改动');

  assert.equal(env.configValue().enabled, false, '宿主此刻仍是 false：它与 payload 的差值正是用户的改动');
  assert.equal(env.configValue().mode, 'flat', '宿主此刻仍是 flat');

  const broadcast = saveAllButton(edited);
  assert.equal(broadcast.props.disabled, false, '已选中、路由合法、非写入中时必须可广播');
  broadcast.props.onClick();

  assert.equal(env.mutations.length, 1, '广播必须只有一次 mutate');
  const call = env.mutations[0];
  assert.equal(call.revision, 41, 'revision 围栏必须是读取快照时的 revision');
  const operations = plain(call.operations);
  assert.equal(opOf(operations, 'enabled'), true, '必须写用户改后的 true，不得回退成宿主原值 false');
  assert.equal(opOf(operations, 'mode'), 'nested', '必须写用户改后的 nested，不得回退成宿主原值 flat');
  const written = opOf(operations, 'workspaces');
  assert.deepEqual(Object.keys(written).sort(), ['/repo/a', '/repo/b', '/repo/c'], '广播必须覆盖全部枚举工作区');
  ['/repo/a', '/repo/b', '/repo/c'].forEach(function (key) {
    assert.deepEqual(written[key],
      { member: { provider: 'dp', model: 'm1' }, subagent: { provider: 'dp', model: 'm2' }, reviewer: { provider: '', model: '' } },
      key + ' 必须拿到选中工作区 draft 的三条路由（审查路由没配过就是继承默认）');
  });

  await settle();
  const done = panel.render();
  assert.equal(findByClass(done, 'fsx-feedback--error').length, 0, '成功不得落 error');
  assert.equal(findByClass(done, 'fsx-feedback--ok').length, 1, '成功只能落一条反馈');
  assert.equal(env.configValue().enabled, true, '宿主回写后必须真是用户改后的值');
  assert.equal(env.configValue().mode, 'nested', '宿主回写后必须真是用户改后的模式');
});

test('未选中工作区时开关与模式必须跟随宿主快照更新；选中工作区后 draft 路由同步仍然正常', async () => {
  const env = makeEnv({
    config: {
      value: {
        enabled: false,
        mode: 'flat',
        workspaces: { '/repo/a': { member: { provider: 'dp', model: 'm1' }, subagent: { provider: 'dp', model: 'm2' } } },
      },
      revision: 31,
    },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, null);
  assert.deepEqual(globalSwitches(tree), { enabled: false, mode: 'flat' }, '未选中工作区时也必须显示宿主真值');

  // 宿主在别处被改写：未选中工作区时面板也必须跟着快照走，不能停在首次读数上。
  env.setConfig({ enabled: true, mode: 'nested' }, 32);
  panel.render();
  const synced = panel.render();
  assert.deepEqual(globalSwitches(synced), { enabled: true, mode: 'nested' },
    '宿主把开关与模式改成 true / nested 后，未选中工作区的面板必须跟着更新');

  // 选中工作区后 draft 必须仍按该工作区的既有条目填充：拆分同步不得破坏既有 draft 路由。
  const selects = findById(synced, 'fsx-workspace');
  assert.equal(selects.length, 1, '工作区下拉不存在，选不到工作区');
  selects[0].props.onChange({ target: { value: '/repo/a' } });
  panel.render();
  const selected = panel.render();
  assert.equal(selectValue(selected, 'fsx-memberProvider'), 'dp', 'draft 的 member provider 必须来自 /repo/a 的既有条目');
  assert.equal(selectValue(selected, 'fsx-memberModel'), 'm1', 'draft 的 member model 必须来自 /repo/a 的既有条目');
  assert.equal(selectValue(selected, 'fsx-subagentProvider'), 'dp', 'draft 的 subagent provider 必须来自 /repo/a 的既有条目');
  assert.equal(selectValue(selected, 'fsx-subagentModel'), 'm2', 'draft 的 subagent model 必须来自 /repo/a 的既有条目');
  assert.deepEqual(globalSwitches(selected), { enabled: true, mode: 'nested' }, '选中工作区后开关与模式仍必须显示宿主真值');

  saveAllButton(selected).props.onClick();
  const call = env.mutations[env.mutations.length - 1];
  assert.equal(opOf(call.operations, 'enabled'), true, '广播必须写宿主当前的 enabled');
  assert.equal(opOf(call.operations, 'mode'), 'nested', '广播必须写宿主当前的 mode');
  assert.deepEqual(opOf(call.operations, 'workspaces')['/repo/b'],
    { member: { provider: 'dp', model: 'm1' }, subagent: { provider: 'dp', model: 'm2' }, reviewer: { provider: '', model: '' } },
    'draft 的三条路由必须广播到每个枚举工作区（未配置审查路由时写成继承默认，不留 undefined）');

  await settle();
  const done = panel.render();
  assert.equal(findByClass(done, 'fsx-feedback--error').length, 0);
});

test('配置刚回到就绪、全局同步 effect 还没跑到的那一拍点广播：必须取宿主刚读到的真值', async () => {
  const env = makeEnv({
    config: { value: { enabled: false, mode: 'flat', workspaces: {} }, revision: 51 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  // 面板的第一帧就看到「配置不可用」：全局同步一次都没跑过，面板里还停在 useState 的初值上。
  env.breakConfig();
  const { panel, tree } = await openPanel(env, '/repo/a');
  assert.equal(saveAllButton(tree).props.disabled, true, '配置不可用时广播必须禁用');
  assert.ok((saveAllButton(tree).props.title || '').indexOf('不可用') >= 0,
    '配置不可用时的禁用原因必须说明配置当前不可读：' + saveAllButton(tree).props.title);

  // 宿主回到就绪并同时改了开关与模式；测试故意不 render，把「同步 effect 尚未跑到」这一拍钉住。
  env.setConfig({ enabled: true, mode: 'nested' }, 52);
  saveAllButton(tree).props.onClick();

  assert.equal(env.mutations.length, 1, '广播必须只有一次 mutate');
  const call = env.mutations[0];
  assert.equal(call.revision, 52, 'revision 围栏必须跟到最新快照，不能停在首次读数 51');
  const operations = plain(call.operations);
  assert.equal(opOf(operations, 'enabled'), true, '必须写宿主刚读到的 true，不得把面板没同步过的初值广播成全局设置');
  assert.equal(opOf(operations, 'mode'), 'nested', '必须写宿主刚读到的 nested，不得广播面板没同步过的值');
  assert.deepEqual(Object.keys(opOf(operations, 'workspaces')).sort(), ['/repo/a', '/repo/b', '/repo/c'],
    '广播仍必须覆盖全部枚举工作区');

  await settle();
  const done = panel.render();
  assert.deepEqual(globalSwitches(done), { enabled: true, mode: 'nested' }, '同步 effect 跑完后显示也必须追上宿主真值');
  assert.equal(findByClass(done, 'fsx-feedback--error').length, 0, '成功不得落 error');
  assert.equal(findByClass(done, 'fsx-feedback--ok').length, 1, '成功只能落一条反馈');
});

test('广播成功提示必须报出真实工作区数量，并说明同时更新了全局开关与模式', async () => {
  const env = makeEnv({
    config: { value: { enabled: false, mode: 'flat', workspaces: { '/legacy': { extra: 'keep-legacy' } } }, revision: 7 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');
  const enumerated = optionValues(findById(tree, 'fsx-workspace')[0]).filter(function (value) { return value !== ''; });
  assert.ok(enumerated.length >= 2, '广播用例必须至少覆盖两个工作区');

  saveAllButton(tree).props.onClick();
  await settle();
  const done = panel.render();
  const okMessages = feedbackMessages(done, 'fsx-feedback--ok');
  assert.equal(okMessages.length, 1, '成功只能落一条反馈');
  const matched = okMessages[0].match(/已写入\s*(\d+)\s*个工作区/);
  assert.ok(matched, '提示必须写明写入了几个工作区：' + okMessages[0]);
  assert.equal(Number(matched[1]), enumerated.length,
    '提示里的数量必须等于真实枚举到的工作区数（/legacy 只是保留，不是广播对象）');
  assert.ok(/开关|启用/.test(okMessages[0]) && /模式/.test(okMessages[0]),
    '广播还写了全局 enabled / mode，提示必须一并说明，不得只报工作区数量：' + okMessages[0]);
  assert.equal(findByClass(done, 'fsx-feedback--error').length, 0, '成功不得同时落 error');
});

test('写入进行中再点一次广播的说明必须在写入成功后消失（notice 与 error 互斥）', async () => {
  const env = makeEnv({
    config: { value: { enabled: false, mode: 'flat', workspaces: {} }, revision: 13 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');

  saveAllButton(tree).props.onClick();
  const busyTree = panel.render();
  assert.equal(saveAllButton(busyTree).props.disabled, true, '写入进行中必须禁用广播按钮');
  saveAllButton(busyTree).props.onClick();
  const blocked = panel.render();
  const busyErrors = feedbackMessages(blocked, 'fsx-feedback--error');
  assert.equal(busyErrors.length, 1, '写入进行中再点一次必须就地说明原因');
  assert.ok(busyErrors[0].indexOf('保存中') >= 0, '说明必须点名是写入进行中：' + busyErrors[0]);
  assert.equal(findByClass(blocked, 'fsx-feedback--ok').length, 0, '写入还没结束不得显示成功提示');

  await settle();
  const done = panel.render();
  const okMessages = feedbackMessages(done, 'fsx-feedback--ok');
  assert.equal(okMessages.length, 1, '写入成功只能落一条反馈');
  assert.deepEqual(feedbackMessages(done, 'fsx-feedback--error'), [], '成功后不得残留「保存中…」这类过程提示');
  const matched = okMessages[0].match(/已写入\s*(\d+)\s*个工作区/);
  assert.ok(matched, '成功提示必须写明写入了几个工作区：' + okMessages[0]);
  assert.equal(Number(matched[1]), WORKSPACE_ITEMS.length, '提示里的数量必须等于真实枚举到的工作区数');
  assert.equal(saveAllButton(done).props.disabled, false, 'busy 必须复位，否则用户再也无法重试');
});

test('先成功后失败：失败必须清掉上一次的成功提示，不得同时挂着两条反馈', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, mode: 'flat', workspaces: {} }, revision: 14 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');

  saveAllButton(tree).props.onClick();
  await settle();
  const first = panel.render();
  assert.equal(feedbackMessages(first, 'fsx-feedback--ok').length, 1, '第一次广播必须落成功提示');
  assert.deepEqual(feedbackMessages(first, 'fsx-feedback--error'), [], '成功时不得挂着错误');

  env.form.mutate = function () { return false; };
  saveAllButton(first).props.onClick();
  await settle();
  const done = panel.render();
  const errors = feedbackMessages(done, 'fsx-feedback--error');
  assert.equal(errors.length, 1, '失败只落一条错误');
  assert.ok(errors[0].indexOf('重试') >= 0, '必须给出下一步动作：' + errors[0]);
  assert.deepEqual(feedbackMessages(done, 'fsx-feedback--ok'), [], '失败后不得残留上一次的成功提示');
  assert.equal(saveAllButton(done).props.disabled, false, '失败后 busy 必须复位');
});

test('成功后宿主把 Config 表单撤成不可用：再点广播只落一条错误，不得残留上一次的成功提示', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, mode: 'flat', workspaces: {} }, revision: 9 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { panel, tree } = await openPanel(env, '/repo/a');

  saveAllButton(tree).props.onClick();
  await settle();
  const first = panel.render();
  assert.equal(feedbackMessages(first, 'fsx-feedback--ok').length, 1, '第一次广播必须落成功提示');

  // 宿主侧把 Config 表单撤掉：这条失败路径不经过写入前的 resetFeedback，最容易被残留钻过去。
  env.breakConfig();
  panel.render();
  const blockedTree = panel.render();
  const broadcast = saveAllButton(blockedTree);
  assert.equal(broadcast.props.disabled, true, '配置不可用时广播按钮必须禁用，不得让用户以为还能保存');
  broadcast.props.onClick();
  const done = panel.render();
  const errors = feedbackMessages(done, 'fsx-feedback--error');
  assert.equal(errors.length, 1, '配置不可用时必须给出一条错误');
  assert.ok(/就绪|不可用|稍后/.test(errors[0]), '错误必须说明配置当前不可读：' + errors[0]);
  assert.deepEqual(feedbackMessages(done, 'fsx-feedback--ok'), [],
    '失败不得把上一次的成功提示同时挂在面板上：' + feedbackMessages(done, 'fsx-feedback--ok').join(' | '));
  assert.equal(env.mutations.length, 1, '配置不可用时不得再发起写入');
});

test('广播按钮的说明文案必须讲清「选中工作区的模型路由 + 全局开关 + 委派模式 → 所有已枚举的工作区」，且不再跨按钮引导', async () => {
  const env = makeEnv({
    config: {
      value: {
        enabled: false,
        mode: 'flat',
        workspaces: { '/repo/a': { member: { provider: 'dp', model: 'm1' }, subagent: { provider: 'dp', model: 'm2' } } },
      },
      revision: 71,
    },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { tree } = await openPanel(env, '/repo/a');

  const ready = saveAllButton(tree);
  assert.equal(ready.props.disabled, false, '选中工作区且路由合法时必须可广播');
  assert.ok(/选中/.test(ready.props.title || '') && /开关/.test(ready.props.title || '') && /模式/.test(ready.props.title || ''),
    '可用时的 title 也必须讲清写入内容（选中工作区的路由 + 全局开关 + 模式）：' + ready.props.title);

  const phrasing = broadcastHintTexts(tree).join(' ');
  assert.ok(/选中/.test(phrasing), 'hint 必须说明模型路由来自选中那个工作区：' + phrasing);
  assert.ok(/模型路由/.test(phrasing), 'hint 必须点名写的是模型路由：' + phrasing);
  assert.ok(/开关/.test(phrasing) && /模式/.test(phrasing), 'hint 必须说明还写全局开关与委派模式：' + phrasing);
  assert.ok(/所有已枚举的工作区/.test(phrasing), 'hint 必须写明作用范围是所有已枚举的工作区（与按钮 title 同一口径）：' + phrasing);
  assert.ok(/原样保留|保持不变/.test(phrasing), 'hint 必须说明配置里已有但没枚举到的工作区条目原样保留：' + phrasing);
  assert.ok(/已枚举的工作区/.test(ready.props.title || ''),
    'title 与 hint 的作用范围必须同词，不能一个说「所有工作区」一个说「已枚举」：' + ready.props.title);
  assertNoCrossButtonGuidance(tree);

  // 旧的跨按钮引导正是挂在「保存设置」被禁用的时候出现的：那条文案在两个 fixture 下都不许再出现。
  const blocked = makeEnv({
    config: { value: { enabled: true, workspaces: { '/repo/a': { member: { provider: 'dp', model: '' }, subagent: { provider: '', model: '' } } } }, revision: 72 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const blockedTree = (await openPanel(blocked, '/repo/a')).tree;
  assert.equal(primarySaveButton(blockedTree).props.disabled, true, '路由不成对时单个保存必须禁用');
  assert.equal(saveAllButton(blockedTree).props.disabled, true, '路由不成对时广播同样必须禁用，否则等于给非法路由开后门');
  assertNoCrossButtonGuidance(blockedTree);
});

test('禁用原因必须在页面文本里读得到：两个按钮一起禁用时，可见文案同时点名它们，不能只挂在 title 上', async () => {
  const env = makeEnv({
    config: { value: { enabled: true, workspaces: { '/repo/a': { member: { provider: 'dp', model: 'm1' }, subagent: { provider: 'dp', model: 'm2' } } } }, revision: 81 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const { tree } = await openPanel(env, null); // 根入口没有会话绑定 → 未选中工作区 → 两个按钮都禁用

  assert.equal(primarySaveButton(tree).props.disabled, true, '未选中时单个保存必须禁用');
  assert.equal(saveAllButton(tree).props.disabled, true, '未选中时广播必须禁用');

  // title 只有悬停才看得见；键盘与屏幕阅读器要的是页面文本里的那一条。
  const reasons = broadcastHintTexts(tree).filter(function (text) { return text.indexOf('暂不可用') >= 0; });
  assert.equal(reasons.length, 1, '禁用时必须有一条可见的原因文案：' + JSON.stringify(broadcastHintTexts(tree)));
  assert.ok(reasons[0].indexOf('保存设置到所有工作区') >= 0, '可见原因必须同时点名广播按钮也受限：' + reasons[0]);
  assertAsksToPickWorkspace(reasons[0].slice(reasons[0].indexOf('：') + 1), '未选中时的可见禁用原因');

  // 路由不成对时可见原因说的是真正的原因，而不是含糊的「不可用」。
  const blocked = makeEnv({
    config: { value: { enabled: true, workspaces: { '/repo/a': { member: { provider: 'dp', model: '' }, subagent: { provider: '', model: '' } } } }, revision: 82 },
    policy: NO_POLICY,
    workspaces: WORKSPACE_ITEMS,
    catalog: CATALOG_OK,
  });
  const blockedTree = (await openPanel(blocked, '/repo/a')).tree;
  const blockedReasons = broadcastHintTexts(blockedTree).filter(function (text) { return text.indexOf('暂不可用') >= 0; });
  assert.equal(blockedReasons.length, 1, '路由不成对时也必须有一条可见的原因文案：' + JSON.stringify(broadcastHintTexts(blockedTree)));
  assert.ok(blockedReasons[0].indexOf('成对') >= 0, '可见原因必须说明 provider 与 model 需成对选择：' + blockedReasons[0]);
  assertNoCrossButtonGuidance(tree);
  assertNoCrossButtonGuidance(blockedTree);
});
