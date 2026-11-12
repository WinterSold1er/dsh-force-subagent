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
    'buildAllWorkspacesMutation',
    'enumerableWorkspaceKeys',
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

test('面板头退出控件走宿主 selectPanel(null)', () => {
  assert.match(CODE, /function closePanel\(\)/);
  assert.match(CODE, /selectPanelSafely\(null\)/);
  assert.match(CODE, /'aria-label':\s*'退出[^\n]*'/);
  assert.match(CODE, /onClick:\s*closePanel/);
});

test('窄屏 320/375px：header 换行、chip 可收缩、长串不撑破容器，且不用 display:none 藏内容', () => {
  assert.match(CODE, /\.fsx-header\{[^}]*flex-wrap:wrap[^}]*\}/, 'header 必须允许换行');
  assert.match(CODE, /\.fsx-heading\{[^}]*flex:1 1 auto[^}]*min-width:0/, '标题区必须可增长可收缩');
  assert.doesNotMatch(CODE, /\.fsx-chip\{[^}]*white-space:nowrap/, 'chip 不得再锁死为不可换行');
  assert.match(CODE, /\.fsx-chip\{[^}]*flex:0 1 auto[^}]*min-width:0/, 'chip 必须允许收缩');
  assert.match(CODE, /#dsh-force-subagent\{[^}]*overflow-wrap:break-word/, '根容器必须仍能换行超长串；不得用 anywhere——anywhere 会把 flex 项的 min-content 塌到单字');
  assert.match(CODE, /#dsh-force-subagent\{[^}]*width:100%;max-width:640px/, '面板必须是流式宽度（窄屏上限 640px，不再是 560px 窄条）');
  assert.doesNotMatch(CODE, /\.fsx-[a-z-]+\{[^}]*display:none/, '不得用 display:none 掩盖溢出');
  assert.match(CODE, /\.fsx-input\{[^}]*width:100%[^}]*max-width:140px/, '成员容量输入必须可收缩，不得定宽撑破窄屏');
  assert.match(CODE, /\.fsx-input\{[^}]*min-height:44px/, '成员容量输入必须是 44px 触控目标');
  assert.match(CODE, /\.fsx-field\{[^}]*min-width:0/, '容量所在卡片字段必须可收缩');
  assert.match(CODE, /\.fsx-savebar\{[^}]*flex-wrap:wrap/, '容量一行必须复用可换行的按钮排');
  assert.match(CODE, /className: 'fsx-card fsx-field'(?:(?!className: 'fsx-card)[\s\S]){0,1200}id: 'fsx-member-limit'/,
    '成员容量必须挂在可换行的卡片字段里，而不是浮在卡外（输入与卡片开标签之间不得跨入另一张卡）');
  assert.match(CODE, /id: 'fsx-member-limit'(?:(?!className: 'fsx-card)[\s\S]){0,1200}id: 'fsx-member-depth'/,
    '深度输入必须与容量输入同处一张卡片，窄屏才不会各占一整行');
  const fixedWidths = [...CODE.matchAll(/(?<![-\w])width:(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(fixedWidths.length > 0, '遍历必须真的抓到固定宽度声明，否则下一条断言是空判');
  assert.ok(fixedWidths.every((w) => w < 300), '固定宽度不得逼近 320px 视口：' + fixedWidths.join(','));
});

test('窄屏 ≤560px：退出按钮触控目标 44px，宽屏保持 32px 紧凑高度', () => {
  const narrow = /@media \(max-width:560px\)\{\.fsx-exit\{([^}]*)\}\}/.exec(CODE)?.[1] ?? '';
  assert.ok(narrow !== '', '必须存在窄屏 .fsx-exit 断点，否则下面三条是空判');
  assert.match(narrow, /min-height:44px/, '窄屏退出按钮必须达到 44px 触控目标');
  assert.match(narrow, /padding:0 12px/, '窄屏必须同步放宽横向内边距');
  assert.match(CODE, /\.fsx-exit\{[^}]*min-height:32px/, '宽屏基线保持 32px 紧凑高度');
  const reduced = /@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n\s*'\}/.exec(CODE)?.[1] ?? '';
  assert.ok(reduced.includes('.fsx-exit,.fsx-exit svg{transition:none;}'), 'reduced-motion 段不得被改动');
  assert.doesNotMatch(reduced, /min-height/, 'reduced-motion 段不得掺入尺寸规则');
});

test('面板根必须自带滚动：任意视口高度都滚得到底部，禁止 hidden/clip 裁切', () => {
  const root = /#dsh-force-subagent\{([\s\S]*?)\n\s*'\}/.exec(CODE)?.[1] ?? '';
  assert.ok(root !== '', '必须抓到 #dsh-force-subagent 根规则，否则下面四条全是空判');
  assert.match(root, /height:100%;min-height:0/, '根必须把高度绑到宿主内容区、且允许收缩到可用高度（flex 项的自动最小尺寸会把内容顶出去）');
  assert.match(root, /max-height:100vh/, '宿主高度不可解析时必须有无条件兜底，保证一定可滚');
  assert.match(root, /overflow-y:auto/, '超出部分必须落到面板内部滚动，而不是被宿主 overflow:hidden 裁掉');
  assert.doesNotMatch(root, /overflow(-y)?:\s*(hidden|clip)/, '不得用 hidden/clip 藏内容');
});

test('两列看面板自身可用宽度而不是看视口：1024 视口（宿主侧栏 280px → 面板 744px）必须仍单列', () => {
  const wide = /@media \(min-width:1000px\)\{([\s\S]*?)\}\}/.exec(CODE)?.[1] ?? '';
  assert.ok(wide.includes('max-width:1152px'), '桌面内容块必须定宽居中（1152 含 24 内边距 → 1104 内容）');
  const container = /@container \(min-width:900px\)\{([\s\S]*?)\}\}/.exec(CODE)?.[1] ?? '';
  assert.ok(container !== '', '两列必须写在 @container 断点里，否则下面两条是空判');
  assert.match(container, /\.fsx-cards\{grid-template-columns:repeat\(2,minmax\(320px,1fr\)\)/, '只有面板自身内容宽度 ≥900px 才排两列');
  assert.doesNotMatch(CODE, /@media \(min-width:\d+px\)\{[^}]*\.fsx-cards\{[^}]*repeat\(2,/,
    '两列不得再由视口宽度决定：1024 视口会触发 1000px 媒体查询，而面板只有 744px，两列会把每张卡压到 338px');
  assert.match(CODE, /#dsh-force-subagent\{[^}]*container-type:inline-size/, '面板必须声明成容器查询的容器，否则 @container 永不生效');
  assert.match(CODE, /\.fsx-cards\{display:grid;grid-template-columns:minmax\(0,1fr\);/, '默认必须单列栅格');
  assert.match(CODE, /className: 'fsx-cards'/, '卡片必须被包进 .fsx-cards 栅格容器，否则两列无从生效');
});

test('间距节奏统一 8/12/16/24：卡片外间距交给栅格 gap，不叠加 margin', () => {
  assert.match(CODE, /\.fsx-header\{[^}]*margin:0 calc\(var\(--fsx-bleed\) \* -1\) 12px/, '头部向外扩出血，下间距仍是 12px');
  assert.match(CODE, /#dsh-force-subagent\{[^}]*padding:0 var\(--fsx-pad\)/, '面板不得自带上下内边距：sticky 会被 containing block 夹在 padding 内侧，滚到底头部停在 y=24 并漏出一条卡片穿过的缝');
  assert.match(CODE, /\.fsx-subtitle\{[^}]*margin:0 0 16px/, '副标题下间距 16px');
  assert.match(CODE, /\.fsx-field\{[^}]*gap:8px/, '字段内间距 8px');
  assert.match(CODE, /\.fsx-card\{[^}]*padding:16px[^}]*margin:0/, '卡片内 16px、外 0，避免与栅格 gap 叠加');
  assert.match(CODE, /\.fsx-grid\{[^}]*repeat\(auto-fit,minmax\(180px,1fr\)\)/, '卡内 Provider/Model 必须自适应，窄卡片自动改单列');
  assert.doesNotMatch(CODE, /@media \(min-width:480px\)\{\.fsx-grid/, '旧的 480px 定宽两列已被自适应栅格取代');
});

test('头部必须吸顶、面板级保存条必须吸底：滚到底标题/退出/保存设置仍在裁剪框内', () => {
  const header = /\.fsx-header\{([^}]*)\}/.exec(CODE)?.[1] ?? '';
  assert.ok(header !== '', '必须抓到 .fsx-header 规则，否则下面四条是空判');
  assert.match(header, /position:sticky/, '头部必须 sticky');
  assert.match(header, /top:0/, 'sticky 必须贴住滚动容器上边缘（滚到底 getBoundingClientRect().top === 0）');
  assert.match(header, /z-index:3/, '头部必须压在被它盖住的卡片之上');
  assert.match(header, /background:var\(--fsx-bg\)/, '头部必须有不透明背景，否则卡片从底下穿过时糊成一团');
  assert.match(header, /flex-wrap:wrap/, 'sticky 后 header 仍必须允许换行');
  const bar = /#dsh-force-subagent>\.fsx-savebar\{([^}]*)\}/.exec(CODE)?.[1] ?? '';
  assert.ok(bar !== '', '面板直接子级的保存条必须单独定义，否则卡片内那条 savebar 也会被一起吸底、两条叠在一起');
  assert.match(bar, /position:sticky/, '保存条必须吸底，让保存设置在任意滚动位置都可见');
  assert.match(bar, /bottom:0/, '保存条必须贴滚动容器下边缘');
  assert.match(bar, /background:var\(--fsx-bg\)/, '吸底的保存条必须有不透明背景');
  const baseBar = /\.fsx-savebar\{([^}]*)\}/.exec(CODE)?.[1] ?? '';
  assert.ok(baseBar.includes('display:flex'), '必须抓到基线 .fsx-savebar 规则本身');
  assert.doesNotMatch(baseBar, /position:sticky/, 'sticky 只能加在面板直接子级那条，不得污染卡片内的那条');
});

test('卡标题不得逐字断行：卡头整块换行、标题整词保宽、不自我压缩', () => {
  const head = /\.fsx-card-head\{([^}]*)\}/.exec(CODE)?.[1] ?? '';
  assert.ok(head !== '', '必须抓到 .fsx-card-head 规则，否则下面三条是空判');
  assert.match(head, /flex-wrap:wrap/, '卡头必须允许整块换行，而不是把标题挤到一字一行');
  assert.match(head, /gap:4px 12px/, '卡头行间距小于列间距');
  const title = /\.fsx-card-title\{([^}]*)\}/.exec(CODE)?.[1] ?? '';
  assert.ok(title !== '', '必须抓到 .fsx-card-title 规则');
  assert.match(title, /word-break:keep-all/, '中日韩文本默认在任意字间断行，标题必须 keep-all 才能保持整词');
  assert.doesNotMatch(title, /min-width:0/, 'min-width:0 会让标题被 flex 压缩到单字宽（375 下 24x72 的成因）');
  assert.doesNotMatch(title, /white-space:nowrap/, '标题不得 nowrap 横向撑破卡片');
});

test('卡片不得被栅格拉成等高空高；卡片/头部/保存条的文字落在同一条内容基线上', () => {
  const cards = /\.fsx-cards\{([^}]*)\}/.exec(CODE)?.[1] ?? '';
  assert.match(cards, /align-items:start/, '栅格不得把每张卡拉到整行最高——固定卡高不吸收内容，只制造底部空档');
  assert.match(CODE, /#dsh-force-subagent\{[^}]*display:flex;flex-direction:column/, '面板必须纵向 flex，卡区才谈得上吸收剩余高度');
  assert.match(cards, /flex:1 1 auto/, '卡区必须吸收面板剩余高度');
  assert.match(cards, /align-content:space-evenly/, '多余高度均匀分配到卡片上/行/下，而不是堆在页面底部（1920 底部空 278 的成因）');
  assert.match(cards, /margin:0 calc\(var\(--fsx-bleed\) \* -1\)/, '卡片向留白方向外扩 bleed，卡内文字才能与面板内容基线对齐');
  assert.match(CODE, /--fsx-bleed:17px/, 'bleed 必须等于卡内边距 16 + 卡描边 1');
  assert.match(CODE, /--fsx-pad:24px/, '面板内边距必须走同一令牌，头部才能按同样的距离外扩');
  const header = /\.fsx-header\{([^}]*)\}/.exec(CODE)?.[1] ?? '';
  const bar = /#dsh-force-subagent>\.fsx-savebar\{([^}]*)\}/.exec(CODE)?.[1] ?? '';
  assert.match(header, /padding:var\(--fsx-pad\) var\(--fsx-bleed\)/, '头部外扩后必须用同样的 padding 把文字送回基线');
  assert.match(bar, /padding:12px var\(--fsx-bleed\)/, '保存条同理，不得比卡内文字缩进 17px');
});

test('字阶分三级：11 辅助 / 13 正文 / 20 标题，卡标题 14 与 label 12 区分，不再只靠字重', () => {
  const sizes = {
    eyebrow: /\.fsx-eyebrow\{[^}]*font-size:(\d+)px/,
    title: /\.fsx-title\{[^}]*font-size:(\d+)px/,
    subtitle: /\.fsx-subtitle\{[^}]*font-size:(\d+)px/,
    cardTitle: /\.fsx-card-title\{[^}]*font-size:(\d+)px/,
    label: /\.fsx-label\{[^}]*font-size:(\d+)px/,
    hint: /\.fsx-hint\{[^}]*font-size:(\d+)px/,
    desc: /\.fsx-card-desc\{[^}]*font-size:(\d+)px/,
  };
  const got = {};
  for (const [name, re] of Object.entries(sizes)) {
    const hit = re.exec(CODE)?.[1];
    assert.ok(hit !== undefined, `必须抓到 ${name} 的字号声明`);
    got[name] = Number(hit);
  }
  assert.equal(got.title, 20, '主标题 20');
  assert.equal(got.cardTitle, 14, '卡标题 14，必须高于正文');
  assert.equal(got.subtitle, 13, '副标题走正文级 13');
  assert.equal(got.label, 12, 'label 12，必须与卡标题 14 区分');
  assert.equal(got.hint, 11, '辅助说明 11');
  assert.equal(got.desc, 11, '卡内说明同属辅助级 11');
  assert.equal(got.eyebrow, 11, '眉标 11');
  const distinct = new Set(Object.values(got));
  assert.ok(distinct.size >= 4, '同一页面上至少要有 4 个可区分的字号，不能只靠字重：' + [...distinct].join('/'));
});

test('buildAllWorkspacesMutation：入参一字不改，返回既有键∪枚举键，只替换 member/subagent 并保留条目上的其它字段', () => {
  const { __test } = loadPlugin();
  const current = {
    '/a': { member: { provider: 'old', model: 'old' }, subagent: { provider: 'old', model: 'old' }, extra: 'keep-a' },
    '/b': { member: { provider: 'x', model: 'y' }, note: 'keep-b' },
    '/only-config': { member: { provider: 'z', model: 'w' }, note: 'legacy' },
  };
  const snapshot = JSON.parse(JSON.stringify(current));
  const items = [
    { path: '/a', workspaceId: 'w1' },
    { path: '/c' },
    { path: '', workspaceId: 'w3' },
  ];
  const draft = { memberProvider: 'alpha', memberModel: 'alpha-fast', subagentProvider: 'beta', subagentModel: 'beta-slow' };

  const next = __test.buildAllWorkspacesMutation(current, items, draft);

  assert.notEqual(next, current, '必须返回新表，不能就地改宿主快照');
  assert.notEqual(next['/a'], current['/a'], '被广播的条目必须是新对象，否则面板仍在读的快照会被改写');
  assert.deepEqual(current, snapshot, '入参必须一字未改');

  assert.deepEqual(Object.keys(next).sort(), ['/a', '/b', '/c', '/only-config', 'w3'],
    '必须写「既有键 ∪ 枚举键」：既不被当前选中的工作区限死，也不丢配置里已有的其它键');

  const ROUTE_MEMBER = { provider: 'alpha', model: 'alpha-fast' };
  const ROUTE_SUBAGENT = { provider: 'beta', model: 'beta-slow' };
  assert.deepEqual(next['/a'], { member: ROUTE_MEMBER, subagent: ROUTE_SUBAGENT, extra: 'keep-a' },
    '已存在的条目只能换掉两条路由，未知字段必须原样留着');
  assert.deepEqual(next['/c'], { member: ROUTE_MEMBER, subagent: ROUTE_SUBAGENT }, '没配置过的枚举工作区必须被新建出来');
  assert.deepEqual(next['w3'], { member: ROUTE_MEMBER, subagent: ROUTE_SUBAGENT },
    'path 为空的条目按 workspaceId 兜底成键（与 workspaceKeyOf 同语义）');
  assert.deepEqual(next['/b'], current['/b'], '没被枚举到的既有条目不得被动过');
  assert.deepEqual(next['/only-config'], current['/only-config'], '只存在于配置里的工作区不得被广播抹掉');
});

test('buildAllWorkspacesMutation：缺失字段补全成完整路由、空 draft 清成继承默认、items 空或非数组时不新增任何工作区', () => {
  const { __test } = loadPlugin();

  const partial = __test.buildAllWorkspacesMutation(
    { '/a': { member: { provider: 'keep', model: 'keep' } } },
    [{ path: '/a' }],
    { memberProvider: 'alpha', memberModel: 'alpha-fast' },
  );
  assert.deepEqual(partial['/a'], {
    member: { provider: 'alpha', model: 'alpha-fast' },
    subagent: { provider: '', model: '' },
  }, '条目缺 subagent、draft 缺 subagent 字段时必须补成完整路由，不能留 undefined');

  const cleared = __test.buildAllWorkspacesMutation(
    { '/a': { member: { provider: 'old', model: 'old' }, subagent: { provider: 'old', model: 'old' } } },
    [{ path: '/a' }],
    {},
  );
  assert.deepEqual(cleared['/a'], { member: { provider: '', model: '' }, subagent: { provider: '', model: '' } },
    '空 draft 必须显式写成继承默认，而不是残留旧值');

  const current = { '/a': { member: { provider: 'x', model: 'y' } } };
  for (const items of [[], undefined, null, 'nope', [null, {}, { workspaceId: '' }]]) {
    const next = __test.buildAllWorkspacesMutation(current, items, { memberProvider: 'a', memberModel: 'b' });
    assert.deepEqual(Object.keys(next).sort(), ['/a'], '枚举不到任何键时不得新增工作区，也不得抛错');
    assert.equal(next['/a'], current['/a'], '没被枚举到的条目必须原样保留（同一个引用即可，别做无用深拷贝）');
  }
});

test('enumerableWorkspaceKeys：按枚举顺序去重、path 优先 workspaceId 兜底、解析不出键的条目跳过', () => {
  const { __test } = loadPlugin();
  assert.deepEqual(__test.enumerableWorkspaceKeys([
    { path: '/b' },
    { path: '/a' },
    { path: '/b' },
    { workspaceId: 7 },
    { path: '', workspaceId: 'w9' },
    {},
    null,
    'not-an-object',
  ]), ['/b', '/a', '7', 'w9'], '顺序必须跟随枚举、重复键只留一次、坏条目只跳过不产出 undefined 键');
  assert.deepEqual(__test.enumerableWorkspaceKeys(undefined), [], '非数组必须安全返回空表');
  assert.deepEqual(__test.enumerableWorkspaceKeys([]), []);
});
