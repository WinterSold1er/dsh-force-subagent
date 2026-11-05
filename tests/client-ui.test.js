/**
 * client.js（浏览器半边）的可执行契约测试。
 *
 * client.js 是 classic script，顶层调用 window.__ModuleLoader__.load；
 * 这里用 vm 提供最小 window / require('react')，取出 factory 的 module.exports，
 * 再对插槽注册与 __test 暴露的纯逻辑做真断言。
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.join(TEST_DIR, '..', 'client.js');
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8');

/** 去掉 JS 注释后再做静态约束断言，避免注释里的模型名/示例造成未来假失败。 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CODE = stripComments(SOURCE);

const PANEL_ID = 'dsh-force-subagent';

function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children };
    },
    useState() {
      return [undefined, () => {}];
    },
    useEffect() {},
    useCallback(callback) {
      return callback;
    },
    useRef() {
      return { current: 0 };
    },
  };
}

function loadPlugin() {
  let exported;
  const react = fakeReact();
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          exported = definition.factory((name) => {
            if (name === 'react') return react;
            throw new Error('unexpected module: ' + name);
          });
        },
      },
    },
    Set,
    Object,
    Array,
    Promise,
    String,
    Error,
    Boolean,
    console,
  };
  vm.createContext(sandbox);
  new vm.Script(SOURCE, { filename: CLIENT_PATH }).runInContext(sandbox);
  return exported;
}

function fakeScope(snapshot) {
  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe() {
      return () => {};
    },
    mutate() {
      return Promise.resolve(true);
    },
  };
}

function applyWithFakeCtx() {
  const plugin = loadPlugin();
  const entries = [];
  const selectPanelCalls = [];
  const ctx = {
    configForms: {
      get() {
        return fakeScope({ status: 'unavailable', value: null, revision: 0, writable: false });
      },
    },
    get() {
      return undefined;
    },
    slots: {
      inject(name, callback) {
        const result = callback();
        if (result !== null && result !== undefined && typeof result.next === 'function') result.next();
      },
      register(registration, component) {
        entries.push({ registration, component });
        return { registration };
      },
    },
    layout: {
      selectPanel(panelId) {
        selectPanelCalls.push(panelId);
      },
    },
    logger: { warn() {} },
  };
  plugin.apply(ctx);
  return { plugin, entries, selectPanelCalls };
}

function entryOf(entries, name) {
  return entries.find((entry) => entry.registration.name === name);
}

function catalogGroups() {
  return [
    { id: 'alpha', name: 'Alpha Provider', models: [{ id: 'alpha-fast', name: 'Alpha Fast' }, { id: 'alpha-pro', name: 'Alpha Pro' }] },
    { id: 'beta', name: 'Beta Provider', models: [{ id: 'beta-one', name: 'Beta One' }] },
  ];
}

test('client.js 注册 main、sidebar.panellist、hero、会话头与会话菜单五个入口', () => {
  const { entries } = applyWithFakeCtx();
  const names = entries.map((entry) => entry.registration.name).sort();
  assert.deepEqual(names, [
    'conversation.hero.options',
    'conversation.session.header.actions',
    'main',
    'sidebar.panellist',
    'sidebar.workspaces.session.menu.item',
  ]);

  const main = entryOf(entries, 'main');
  const sidebar = entryOf(entries, 'sidebar.panellist');
  assert.equal(main.registration.key, PANEL_ID);
  assert.equal(sidebar.registration.id, PANEL_ID);
  assert.equal(sidebar.registration.order, 20);
  assert.equal(sidebar.registration.label, '强制委派');
  assert.equal(typeof sidebar.component, 'function');
  assert.equal(typeof main.component, 'function');
});

test('sidebar 图标只渲染分叉图形，不自行绑定点击', () => {
  const { entries } = applyWithFakeCtx();
  const sidebar = entryOf(entries, 'sidebar.panellist');
  const wrapper = sidebar.component({ size: 22, active: true });
  assert.equal(typeof wrapper.type, 'function');
  assert.equal(wrapper.props.onClick, undefined);

  const glyph = wrapper.type({ size: 22 });
  assert.equal(glyph.type, 'svg');
  assert.equal(glyph.props['aria-hidden'], 'true');
  assert.equal(glyph.props.focusable, 'false');
});

test('新会话 hero 入口点击后切换到 main 面板', () => {
  const { entries, selectPanelCalls } = applyWithFakeCtx();
  const hero = entryOf(entries, 'conversation.hero.options');
  assert.ok(hero, 'missing conversation.hero.options');
  assert.equal(hero.registration.order, 100);
  const tree = hero.component({ sessionId: 'session-blank' });
  assert.equal(typeof tree.props.onClick, 'function');
  tree.props.onClick();
  assert.deepEqual(selectPanelCalls, [PANEL_ID]);
});

test('会话头入口点击后切换到 main 面板', () => {
  const { entries, selectPanelCalls } = applyWithFakeCtx();
  const header = entryOf(entries, 'conversation.session.header.actions');
  const tree = header.component({ sessionId: 'session-1' });
  assert.equal(typeof tree.props.onClick, 'function');
  tree.props.onClick();
  assert.deepEqual(selectPanelCalls, [PANEL_ID]);
});

test('module.exports.__test 暴露纯逻辑给 Node 调用', () => {
  const plugin = loadPlugin();
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(plugin.name, PANEL_ID);
  assert.deepEqual(plugin.inject, ['slots', 'configForms', 'layout', 'workspaces', 'sessions', 'remote', 'remote.session']);
  for (const name of [
    'buildModelOptions',
    'buildDraft',
    'buildSaveOperations',
    'buildWorkspacesMutation',
    'draftIsValid',
    'providerGroupOf',
    'routeOf',
    'routeText',
    'workspaceBySession',
    'workspaceOf',
    'workspaceKeyOf',
    'workspaceTitleOf',
    'workspacesRecordOf',
  ]) {
    assert.equal(typeof plugin.__test[name], 'function', 'missing __test.' + name);
  }
});

test('buildModelOptions：策略启用时只允许 allowedModels，并保留当前值', () => {
  const { __test } = loadPlugin();
  const options = __test.buildModelOptions({
    policy: {
      status: 'ready',
      value: { enabled: true, allowedModels: [{ provider: 'beta', model: 'beta-one' }] },
    },
    catalog: { status: 'ready', groups: catalogGroups() },
    current: { provider: 'legacy', model: 'legacy-model' },
  });
  assert.equal(options.source, 'allowed');
  assert.equal(options.status, 'ready');
  assert.deepEqual(options.providers.map((group) => group.provider).sort(), ['beta', 'legacy']);
  const legacy = options.providers.find((group) => group.provider === 'legacy');
  assert.deepEqual(legacy.models, [{ model: 'legacy-model', label: 'legacy-model' }]);
  const beta = options.providers.find((group) => group.provider === 'beta');
  assert.deepEqual(beta.models, [{ model: 'beta-one', label: 'beta-one' }]);
});

test('buildModelOptions：策略关闭时使用 modelCatalog 分组并保留当前值', () => {
  const { __test } = loadPlugin();
  const options = __test.buildModelOptions({
    policy: { status: 'ready', value: { enabled: false, allowedModels: [{ provider: 'beta', model: 'beta-one' }] } },
    catalog: { status: 'ready', groups: catalogGroups() },
    current: { provider: 'beta', model: 'beta-one' },
  });
  assert.equal(options.source, 'catalog');
  assert.deepEqual(options.providers.map((group) => group.provider), ['alpha', 'beta']);
  const alpha = options.providers.find((group) => group.provider === 'alpha');
  assert.deepEqual(alpha.models.map((model) => model.model), ['alpha-fast', 'alpha-pro']);
  assert.equal(alpha.models[0].label, 'Alpha Fast');
});

test('buildModelOptions：空策略、加载中、失败、空目录状态可区分', () => {
  const { __test } = loadPlugin();
  const emptyPolicy = __test.buildModelOptions({
    policy: { status: 'ready', value: { enabled: true, allowedModels: [] } },
    catalog: { status: 'ready', groups: [] },
    current: { provider: '', model: '' },
  });
  assert.equal(emptyPolicy.status, 'policy-empty');

  const loading = __test.buildModelOptions({
    policy: { status: 'unavailable' },
    catalog: { status: 'loading' },
    current: { provider: 'alpha', model: 'alpha-fast' },
  });
  assert.equal(loading.status, 'loading');
  assert.deepEqual(loading.providers[0].models.map((model) => model.model), ['alpha-fast']);

  const failure = __test.buildModelOptions({
    policy: { status: 'unavailable' },
    catalog: { status: 'error', groups: [] },
    current: { provider: '', model: '' },
  });
  assert.equal(failure.status, 'error');
  assert.deepEqual(failure.providers, []);

  const empty = __test.buildModelOptions({
    policy: { status: 'unavailable' },
    catalog: { status: 'ready', groups: [] },
    current: { provider: '', model: '' },
  });
  assert.equal(empty.status, 'empty');
});

test('buildWorkspacesMutation：不修改入参、保留其它工作区与额外字段', () => {
  const { __test } = loadPlugin();
  const current = {
    '/a': { member: { provider: 'old', model: 'old' }, subagent: { provider: 'old', model: 'old' }, extra: 'keep' },
    '/b': { member: { provider: 'other', model: 'other' } },
  };
  const next = __test.buildWorkspacesMutation(current, '/a', {
    memberProvider: 'alpha',
    memberModel: 'alpha-fast',
    subagentProvider: '',
    subagentModel: '',
  });
  assert.notEqual(next, current);
  assert.equal(current['/a'].member.provider, 'old', 'input must not be mutated');
  assert.equal(next['/a'].member.provider, 'alpha');
  assert.equal(next['/a'].member.model, 'alpha-fast');
  assert.equal(next['/a'].subagent.provider, '');
  assert.equal(next['/a'].extra, 'keep');
  assert.equal(next['/b'], current['/b']);
});

test('buildSaveOperations：两个 set op、workspaces 正确、不修改入参', () => {
  const { __test } = loadPlugin();
  const current = {
    '/a': { member: { provider: 'old', model: 'old' }, subagent: { provider: 'old', model: 'old' } },
    '/b': { member: { provider: 'other', model: 'other' } },
  };
  const draft = { memberProvider: 'alpha', memberModel: 'alpha-fast', subagentProvider: '', subagentModel: '' };
  const ops = __test.buildSaveOperations(current, '/a', draft, true);
  assert.equal(ops.length, 2);
  assert.deepEqual(ops[0].path, ['enabled']);
  assert.equal(ops[0].value, true);
  assert.deepEqual(ops[1].path, ['workspaces']);
  assert.equal(ops[1].value['/a'].member.provider, 'alpha');
  assert.equal(ops[1].value['/a'].member.model, 'alpha-fast');
  assert.equal(ops[1].value['/a'].subagent.provider, '');
  assert.equal(ops[1].value['/b'].member.provider, 'other');
  assert.equal(current['/a'].member.provider, 'old', 'input must not be mutated');

  const off = __test.buildSaveOperations({}, '/x', draft, false);
  assert.equal(off[0].value, false);
  assert.equal(off[1].value['/x'].member.provider, 'alpha');
});

test('buildWorkspacesMutation：缺少 key 时返回副本且不改动', () => {
  const { __test } = loadPlugin();
  const current = { '/a': { member: { provider: 'x', model: 'x' } } };
  const next = __test.buildWorkspacesMutation(current, undefined, {
    memberProvider: 'y', memberModel: 'y', subagentProvider: '', subagentModel: '',
  });
  assert.notEqual(next, current);
  assert.deepEqual(next, current);
});

test('workflow 纯函数：workspace key、会话反查、草稿与成对校验', () => {
  const { __test } = loadPlugin();
  assert.equal(__test.workspaceKeyOf({ path: '/abs', workspaceId: 'w' }), '/abs');
  assert.equal(__test.workspaceKeyOf({ path: '', workspaceId: 'w' }), 'w');
  assert.equal(__test.workspaceKeyOf({ workspaceId: '' }), undefined);
  assert.equal(__test.workspaceKeyOf(null), undefined);
  assert.equal(__test.workspaceTitleOf({ path: '/abs', title: 'demo' }), 'demo');
  assert.equal(__test.workspaceTitleOf({ path: '/abs', title: '' }), '/abs');

  const items = [
    { path: '/one', sessionIds: ['s1'] },
    { path: '/two', sessionIds: ['s2', 's3'] },
  ];
  assert.equal(__test.workspaceBySession(items, 's3').path, '/two');
  assert.equal(__test.workspaceBySession(items, 'missing'), null);
  assert.equal(__test.workspaceBySession(undefined, 's1'), null);

  const workspaces = {
    '/one': { member: { provider: 'a', model: 'm' }, subagent: { provider: '', model: '' } },
  };
  assert.deepEqual(__test.buildDraft(workspaces, '/one'), {
    memberProvider: 'a', memberModel: 'm', subagentProvider: '', subagentModel: '',
  });
  assert.equal(__test.draftIsValid({ memberProvider: '', memberModel: '', subagentProvider: '', subagentModel: '' }), true);
  assert.equal(__test.draftIsValid({ memberProvider: 'a', memberModel: '', subagentProvider: '', subagentModel: '' }), false);
  assert.equal(__test.draftIsValid({ memberProvider: 'a', memberModel: 'm', subagentProvider: 'b', subagentModel: 'n' }), true);
});

test('readWorkspaceState：服务抛错返回错误态且只 warn 一次', () => {
  const plugin = loadPlugin();
  let warns = 0;
  const ctx = {
    get() { throw new Error('workspaces down'); },
    logger: { warn() { warns += 1; } },
  };
  assert.deepEqual(plugin.__test.readWorkspaceState(ctx), { items: [], error: 'workspaces down' });
  assert.deepEqual(plugin.__test.readWorkspaceState(ctx), { items: [], error: 'workspaces down' });
  assert.equal(warns, 1);
});

test('workspaceOf：直接命中、parentSession 上溯、cwd 兜底、未命中与环安全', () => {
  const { __test } = loadPlugin();
  const items = [
    { path: '/top', sessionIds: ['top'] },
    { path: '/cwd-ws', sessionIds: [] },
  ];

  assert.equal(__test.workspaceOf({ get() { return undefined; } }, 'top', items).path, '/top');

  const parentCtx = {
    get(name) {
      if (name !== 'sessions') return undefined;
      return { list: { getSnapshot() { return { byId: { s3: { parentId: 's2' }, s2: { parentId: 'top' }, top: {} } }; } } };
    },
  };
  assert.equal(__test.workspaceOf(parentCtx, 's3', items).path, '/top');

  const cwdCtx = {
    get(name) {
      if (name !== 'sessions') return undefined;
      return { list: { getSnapshot() { return { byId: { x: { cwd: '/cwd-ws' } } }; } } };
    },
  };
  assert.equal(__test.workspaceOf(cwdCtx, 'x', items).path, '/cwd-ws');

  const pseudoCtx = {
    get(name) {
      if (name !== 'sessions') return undefined;
      return { list: { getSnapshot() { return { byId: { y: { cwd: '/not-registered' } } }; } } };
    },
  };
  assert.deepEqual(__test.workspaceOf(pseudoCtx, 'y', items), { path: '/not-registered', title: '', workspaceId: '' });

  assert.equal(__test.workspaceOf({ get() { return undefined; } }, 'missing', items), null);

  const cycleCtx = {
    get(name) {
      if (name !== 'sessions') return undefined;
      return { list: { getSnapshot() { return { byId: { a: { parentId: 'b' }, b: { parentId: 'a' } } }; } } };
    },
  };
  assert.equal(__test.workspaceOf(cycleCtx, 'a', items), null);
});

test('client.js 不再有模型文本框，也不硬编码模型清单', () => {
  assert.doesNotMatch(CODE, /type:\s*'text'/);
  assert.doesNotMatch(CODE, /qwen3\.8-flash-next-iq3_xxs|deepseek-v4\.1-flash|minor-5090/);
  assert.match(CODE, /h\('select'/);
  assert.match(CODE, /sidebar\.panellist/);
  assert.match(CODE, /subagent-model-selection-settings/);
  assert.match(CODE, /modelCatalog/);
});

test('save 使用 form.mutate(operations, fresh.revision) 做 revision 围栏', () => {
  assert.match(CODE, /form\.mutate\(operations,\s*fresh\.revision\)/);
});

test('client.js 的样式与可访问性硬性要求存在', () => {
  assert.match(CODE, /prefers-reduced-motion/);
  assert.match(CODE, /:focus-visible/);
  assert.match(CODE, /--dsw-alias-button-primary-fill/);
  assert.match(CODE, /--dsw-alias-settings-card-fill/);
  assert.match(CODE, /role:\s*'alert'/);
  assert.match(CODE, /role:\s*'status'/);
  assert.match(CODE, /全局开关/);
  assert.match(CODE, /保存设置/);
  assert.match(CODE, /工作区服务不可用/);
  assert.match(CODE, /允许模型策略不可读/);
  assert.match(CODE, /aria-describedby/);
  assert.match(CODE, /data-plugin/);
});
