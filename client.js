/**
 * dsh-force-subagent — 浏览器半边：按工作区保存的模型路由设置。
 *
 * 入口（会话内三处 + 侧栏常驻一处）：
 * - conversation.session.header.actions：非 blank 会话的会话头按钮；
 * - conversation.hero.options：新会话（blank）hero 区按钮（header chrome 被宿主隐藏时仍显示）；
 * - sidebar.workspaces.session.menu.item：会话行「…」菜单项；
 * - sidebar.panellist：左侧栏常驻入口（冷启动/无会话也能打开）。
 * 点击会话入口会切到 main 面板（key dsh-force-subagent），并绑定该会话所属工作区。
 *
 * sessionId → workspace：ctx.get('workspaces').list.getSnapshot().items 里找
 * sessionIds 含该 sessionId 的那条；没有绑定会话时面板显示工作区选择器。
 * 配置键 = workspace.path || String(workspaceId)，与 index.js 的 Config 契约一致。
 *
 * 模型下拉的数据源：
 * - 子代理允许模型策略（ctx.configForms.get('subagent-model-selection-settings')）；
 * - 宿主模型目录（ctx.get('remote').session.modelCatalog()）。
 * 策略启用时以 allowedModels 为合法性围栏；否则使用模型目录；始终并入当前值。
 */
window.__ModuleLoader__.load({
  id: 'dsh-force-subagent',
  factory(require) {
    var module = { exports: {} };
    var React = require('react');
    var h = React.createElement;

    var ENTRY = 'dsh-force-subagent';
    var PANEL = 'dsh-force-subagent';
    var POLICY_NS = 'subagent-model-selection-settings';
    var STYLE_ID = 'dsh-force-subagent-style';

    // 当前绑定的 sessionId：两个会话入口共用，页面订阅它。
    var boundSessionId = null;
    var bindListeners = new Set();
    var warnedWorkspaceRead = false;

    function subscribeBind(listener) {
      bindListeners.add(listener);
      return function () { bindListeners.delete(listener); };
    }

    function bindSession(sessionId) {
      boundSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
      bindListeners.forEach(function (listener) { listener(); });
    }

    // ------------------------------------------------------------------
    // 纯逻辑（无副作用；module.exports.__test 暴露给 Node 测试）
    // ------------------------------------------------------------------

    function isObject(value) {
      return value !== null && typeof value === 'object';
    }

    function nonEmptyString(value) {
      return typeof value === 'string' && value.length > 0;
    }

    function routeOf(value) {
      var source = isObject(value) ? value : {};
      return {
        provider: nonEmptyString(source.provider) ? source.provider : '',
        model: nonEmptyString(source.model) ? source.model : '',
      };
    }

    function routeText(route) {
      var source = routeOf(route);
      return source.provider ? source.provider + ' / ' + source.model : '继承默认';
    }

    /** 工作区配置键：优先绝对路径，注册 id 仅作兜底；与 index.js 的 workspaceKey 同语义。 */
    function workspaceKeyOf(item) {
      if (!isObject(item)) return undefined;
      if (nonEmptyString(item.path)) return item.path;
      if (item.workspaceId !== undefined && item.workspaceId !== null && String(item.workspaceId).length > 0) {
        return String(item.workspaceId);
      }
      return undefined;
    }

    function workspaceTitleOf(item) {
      if (!isObject(item)) return '未命名工作区';
      if (nonEmptyString(item.title)) return item.title;
      if (nonEmptyString(item.path)) return item.path;
      if (nonEmptyString(item.name)) return item.name;
      return workspaceKeyOf(item) || '未命名工作区';
    }

    /**
     * 读取工作区列表。服务故障返回 {items:[], error}，不得伪装成“没有工作区”；
     * 同一失败只 warn 一次，避免每次渲染刷屏。
     */
    function readWorkspaceState(ctx) {
      try {
        var service = ctx.get('workspaces');
        var list = service !== null && service !== undefined ? service.list : undefined;
        var snapshot = list !== null && list !== undefined && typeof list.getSnapshot === 'function'
          ? list.getSnapshot()
          : undefined;
        var items = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.items) ? snapshot.items : [];
        return {
          items: items.filter(function (item) { return workspaceKeyOf(item) !== undefined; }),
          error: '',
        };
      } catch (error) {
        var message = error instanceof Error ? error.message : String(error);
        if (!warnedWorkspaceRead) {
          warnedWorkspaceRead = true;
          try {
            if (ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger.warn === 'function') {
              ctx.logger.warn('[force-subagent] 读取工作区列表失败：' + message + '；面板显示不可用态。');
            }
          } catch (logError) {
            // 日志服务自身失败不能阻断面板；错误已经被 error 状态带出。
          }
        }
        return { items: [], error: message };
      }
    }

    function workspaceBySession(items, sessionId) {
      if (!Array.isArray(items) || !nonEmptyString(sessionId)) return null;
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        if (isObject(item) && Array.isArray(item.sessionIds) && item.sessionIds.indexOf(sessionId) >= 0) return item;
      }
      return null;
    }

    /**
     * 解析会话所属工作区，顺序：
     * 1) 直接命中 workspace.sessionIds；
     * 2) 沿 sessions.byId[id].parentId 上溯（≤8 层、防环）——宿主只登记顶层会话；
     * 3) 用 sessions.byId[id].cwd 匹配 workspace.path；
     * 4) 未注册目录用 cwd 本身当 key（与 index.js 同语义，按目录隔离）。
     * 任何一步失败都返回 null，由调用方要求用户显式选择，绝不默认落到第一个工作区。
     */
    function workspaceOf(ctx, sessionId, items) {
      if (!nonEmptyString(sessionId)) return null;
      var list = Array.isArray(items) ? items : [];
      var direct = workspaceBySession(list, sessionId);
      if (direct !== null) return direct;

      var sessions;
      try {
        sessions = ctx.get('sessions');
      } catch (error) {
        sessions = undefined;
      }
      if (sessions === undefined || sessions === null || sessions.list === undefined
        || typeof sessions.list.getSnapshot !== 'function') return null;
      var snapshot = sessions.list.getSnapshot();
      var byId = snapshot !== null && typeof snapshot === 'object'
        && snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : {};

      var seen = {};
      seen[sessionId] = true;
      var cursor = byId[sessionId];
      var hops = 0;
      while (cursor !== undefined && cursor !== null && hops < 8) {
        var parentId = cursor.parentId;
        if (!nonEmptyString(parentId) || seen[parentId] === true) break;
        seen[parentId] = true;
        hops += 1;
        var hit = workspaceBySession(list, parentId);
        if (hit !== null) return hit;
        cursor = byId[parentId];
      }

      var self = byId[sessionId];
      var cwd = isObject(self) && nonEmptyString(self.cwd) ? self.cwd : '';
      if (cwd.length > 0) {
        for (var index = 0; index < list.length; index += 1) {
          if (isObject(list[index]) && list[index].path === cwd) return list[index];
        }
        return { path: cwd, title: '', workspaceId: '' };
      }
      return null;
    }

    function workspacesRecordOf(value) {
      var source = isObject(value) ? value : {};
      return isObject(source.workspaces) ? source.workspaces : {};
    }

    function routeAt(workspaces, key, kind) {
      var record = isObject(workspaces) && nonEmptyString(key) ? workspaces[key] : undefined;
      return routeOf(isObject(record) ? record[kind] : undefined);
    }

    function buildDraft(workspaces, key) {
      var member = routeAt(workspaces, key, 'member');
      var subagent = routeAt(workspaces, key, 'subagent');
      return {
        memberProvider: member.provider,
        memberModel: member.model,
        subagentProvider: subagent.provider,
        subagentModel: subagent.model,
      };
    }

    /** 返回一份新的 workspaces 字典，不修改入参；保留其它工作区与条目上的其它字段。 */
    function buildWorkspacesMutation(currentWorkspaces, key, draft) {
      var next = {};
      var source = isObject(currentWorkspaces) ? currentWorkspaces : {};
      Object.keys(source).forEach(function (name) { next[name] = source[name]; });
      if (!nonEmptyString(key)) return next;
      var existing = isObject(source[key]) ? source[key] : {};
      var record = {};
      Object.keys(existing).forEach(function (name) { record[name] = existing[name]; });
      var route = routeOf(draft && { provider: draft.memberProvider, model: draft.memberModel });
      var subagent = routeOf(draft && { provider: draft.subagentProvider, model: draft.subagentModel });
      record.member = { provider: route.provider, model: route.model };
      record.subagent = { provider: subagent.provider, model: subagent.model };
      next[key] = record;
      return next;
    }

    /** 保存载荷：enabled / workspaces 两个必发 set op，加 mode 这个可选 set op（仅取 nested|flat，未提供则不写该字段）。revision 围栏由调用方 form.mutate(ops, revision) 传入。 */
    function buildSaveOperations(currentWorkspaces, key, draft, enabled, mode) {
      var operations = [
        { op: 'set', path: ['enabled'], value: enabled === true },
        { op: 'set', path: ['workspaces'], value: buildWorkspacesMutation(currentWorkspaces, key, draft) },
      ];
      if (mode === 'nested' || mode === 'flat') operations.push({ op: 'set', path: ['mode'], value: mode });
      return operations;
    }

    function draftIsValid(draft) {
      var pairs = [
        [draft.memberProvider, draft.memberModel],
        [draft.subagentProvider, draft.subagentModel],
      ];
      return pairs.every(function (pair) {
        var provider = nonEmptyString(pair[0]) ? pair[0] : '';
        var model = nonEmptyString(pair[1]) ? pair[1] : '';
        return (provider === '' && model === '') || (provider !== '' && model !== '');
      });
    }

    function policyRoutes(snapshot) {
      if (!isObject(snapshot) || snapshot.status !== 'ready' || !isObject(snapshot.value)) {
        return { active: false, routes: [] };
      }
      var enabled = snapshot.value.enabled === true;
      var list = Array.isArray(snapshot.value.allowedModels) ? snapshot.value.allowedModels : [];
      var routes = [];
      list.forEach(function (entry) {
        var route = routeOf(entry);
        if (route.provider && route.model) routes.push(route);
      });
      return { active: enabled, routes: routes };
    }

    /**
     * 合并允许模型策略与模型目录，产出下拉选项。
     * input: { policy, catalog, current }
     * 返回: { status, source, providers:[{provider,label,models:[{model,label}]}] }
     */
    function buildModelOptions(input) {
      var source = isObject(input) ? input : {};
      var policy = isObject(source.policy) ? source.policy : null;
      var catalog = isObject(source.catalog) ? source.catalog : null;
      var current = routeOf(source.current);
      var groups = [];
      var byId = Object.create(null);
      var status = 'ready';
      var origin = 'current';

      function add(provider, model, providerLabel, modelLabel) {
        if (!nonEmptyString(provider)) return;
        var group = byId[provider];
        if (group === undefined) {
          group = { provider: provider, label: providerLabel || provider, models: [], seen: Object.create(null) };
          byId[provider] = group;
          groups.push(group);
        }
        if (!nonEmptyString(model)) return;
        if (group.seen[model] !== undefined) {
          if (modelLabel && group.seen[model].label === group.seen[model].model) group.seen[model].label = modelLabel;
          return;
        }
        var entry = { model: model, label: modelLabel || model };
        group.seen[model] = entry;
        group.models.push(entry);
      }

      var allowed = policyRoutes(policy);
      if (allowed.active) {
        origin = 'allowed';
        if (allowed.routes.length === 0) status = 'policy-empty';
        allowed.routes.forEach(function (route) { add(route.provider, route.model); });
      } else if (catalog !== null && catalog.status === 'ready'
        && Array.isArray(catalog.groups) && catalog.groups.length > 0) {
        origin = 'catalog';
        catalog.groups.forEach(function (group) {
          var sourceGroup = isObject(group) ? group : {};
          var provider = nonEmptyString(sourceGroup.id) ? sourceGroup.id : '';
          var providerLabel = nonEmptyString(sourceGroup.name) ? sourceGroup.name : provider;
          var models = Array.isArray(sourceGroup.models) ? sourceGroup.models : [];
          models.forEach(function (model) {
            var sourceModel = isObject(model) ? model : {};
            var id = nonEmptyString(sourceModel.id) ? sourceModel.id : '';
            var name = nonEmptyString(sourceModel.name) ? sourceModel.name : id;
            add(provider, id, providerLabel, name);
          });
        });
      } else if (catalog !== null && catalog.status === 'loading') {
        status = 'loading';
      } else if (catalog !== null && catalog.status === 'error') {
        status = 'error';
      }

      if (current.provider) add(current.provider, current.model);

      if (groups.length === 0 && status === 'ready') status = 'empty';

      groups.sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
      groups.forEach(function (group) {
        group.models.sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
      });

      return { status: status, source: origin, providers: groups };
    }

    function providerGroupOf(options, provider) {
      if (!isObject(options) || !Array.isArray(options.providers)) return null;
      for (var index = 0; index < options.providers.length; index += 1) {
        if (options.providers[index].provider === provider) return options.providers[index];
      }
      return null;
    }

    // ------------------------------------------------------------------
    // 样式：一次注入、幂等、作用域限定 #dsh-force-subagent
    // ------------------------------------------------------------------

    var PANEL_CSS = [
      '#dsh-force-subagent{',
      '--fsx-bg:var(--dsw-alias-bg-base,#fff);',
      '--fsx-text:var(--dsw-alias-label-primary,#0f1115);',
      '--fsx-muted:var(--dsw-alias-label-secondary,#61666b);',
      '--fsx-faint:var(--dsw-alias-label-tertiary,#81858c);',
      '--fsx-hair:var(--dsw-alias-border-l2,rgba(0,0,0,.1));',
      '--fsx-card:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,#fff));',
      '--fsx-stroke:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4,rgba(0,0,0,.12)));',
      '--fsx-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));',
      '--fsx-accent:var(--dsw-alias-state-business-primary,#4176e6);',
      '--fsx-ok:var(--dsw-alias-state-success-primary,#22c55e);',
      '--fsx-warn:var(--dsw-alias-state-warn-primary,#f59e0b);',
      '--fsx-err:var(--dsw-alias-state-error-primary,#ec1313);',
      'width:100%;max-width:560px;margin:0 auto;padding:28px 24px 44px;',
      'color:var(--fsx-text);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);',
      'font-size:14px;line-height:22px;box-sizing:border-box;',
      'animation:fsx-rise var(--ds-transition-duration-slow,.3s) var(--ds-ease-in-out,ease) both;',
      '}',
      '#dsh-force-subagent *,#dsh-force-subagent *::before,#dsh-force-subagent *::after{box-sizing:border-box;}',
      '#dsh-force-subagent :focus-visible{outline:2px solid var(--fsx-accent);outline-offset:2px;}',
      '.fsx-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:10px;}',
      '.fsx-heading{display:flex;align-items:center;gap:12px;min-width:0;}',
      '.fsx-mark{width:40px;height:40px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;background:var(--fsx-hover);color:var(--fsx-text);flex:none;}',
      '.fsx-eyebrow{margin:0 0 2px;font-size:11px;line-height:14px;letter-spacing:.12em;font-weight:600;color:var(--fsx-faint);}',
      '.fsx-title{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.2px;}',
      '.fsx-subtitle{margin:0 0 18px;color:var(--fsx-muted);font-size:13px;line-height:20px;}',
      '.fsx-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border-radius:999px;background:var(--fsx-hover);font-size:12px;line-height:16px;font-weight:500;white-space:nowrap;flex:none;}',
      '.fsx-dot{width:7px;height:7px;border-radius:999px;background:var(--fsx-muted);}',
      '.fsx-chip--ok .fsx-dot{background:var(--fsx-ok);}',
      '.fsx-chip--warn .fsx-dot{background:var(--fsx-warn);}',
      '.fsx-chip--error .fsx-dot{background:var(--fsx-err);}',
      '.fsx-card{background:var(--fsx-card);border:1px solid var(--fsx-stroke);border-radius:var(--dsw-radius-md,12px);padding:16px;margin:0 0 12px;box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.04));transition:border-color 160ms var(--ds-ease-in-out,ease),box-shadow 160ms var(--ds-ease-in-out,ease);}',
      '.fsx-card:hover{border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.16));}',
      '.fsx-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;}',
      '.fsx-card-title{font-size:13px;font-weight:600;line-height:18px;margin:0;}',
      '.fsx-card-desc{font-size:12px;line-height:17px;color:var(--fsx-faint);margin:0;}',
      '.fsx-grid{display:grid;grid-template-columns:1fr;gap:12px;}',
      '@media (min-width:480px){.fsx-grid{grid-template-columns:1fr 1fr;}}',
      '.fsx-field{display:flex;flex-direction:column;gap:6px;min-width:0;}',
      '.fsx-label{font-size:12px;line-height:17px;font-weight:500;color:var(--fsx-muted);}',
      '.fsx-select{appearance:none;-webkit-appearance:none;width:100%;min-height:44px;padding:8px 34px 8px 12px;border:1px solid var(--fsx-hair);border-radius:var(--dsw-radius-sm,8px);background-color:var(--fsx-bg);color:var(--fsx-text);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:border-color 160ms var(--ds-ease-in-out,ease),background 160ms var(--ds-ease-in-out,ease);background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath d=%27M1 1.5 6 6.5l5-5%27 fill=%27none%27 stroke=%27%2381858c%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;}',
      '.fsx-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.16));}',
      'body[data-ds-dark-theme] #dsh-force-subagent .fsx-select{background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath d=%27M1 1.5 6 6.5l5-5%27 fill=%27none%27 stroke=%27%23cfd3d6%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E");}',
      '.fsx-select:disabled{opacity:.55;cursor:not-allowed;}',
      '.fsx-hint{margin:0;font-size:12px;line-height:17px;color:var(--fsx-faint);}',
      '.fsx-hint--error{color:var(--fsx-err);}',
      '.fsx-switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;}',
      '.fsx-switch-copy{display:flex;flex-direction:column;gap:3px;min-width:0;}',
      '.fsx-checkbox{width:18px;height:18px;accent-color:var(--fsx-accent);cursor:pointer;flex:none;}',
      '.fsx-savebar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:16px;}',
      '.fsx-primary{min-height:44px;padding:0 18px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);font:inherit;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:background 160ms var(--ds-ease-in-out,ease),transform 120ms var(--ds-ease-in-out,ease),opacity 160ms;}',
      '.fsx-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#2a2a2e);}',
      '.fsx-primary:active:not(:disabled){transform:translateY(1px);}',
      '.fsx-primary:disabled{opacity:.45;cursor:not-allowed;}',
      '.fsx-feedback{margin:0;font-size:12px;line-height:18px;}',
      '.fsx-feedback--ok{color:var(--fsx-muted);}',
      '.fsx-feedback--error{color:var(--fsx-err);}',
      '.fsx-spinner{width:12px;height:12px;border-radius:999px;border:2px solid currentColor;border-right-color:transparent;display:inline-block;animation:fsx-spin .8s linear infinite;}',
      '.fsx-banner{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);background:var(--fsx-hover);font-size:12px;line-height:18px;color:var(--fsx-muted);margin:0 0 12px;}',
      '.fsx-banner strong{color:var(--fsx-text);font-weight:600;}',
      '.fsx-link{background:none;border:0;padding:0;color:var(--fsx-accent);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;text-underline-offset:2px;}',
      '.fsx-empty{padding:18px;border:1px dashed var(--fsx-hair);border-radius:var(--dsw-radius-md,12px);text-align:center;color:var(--fsx-muted);font-size:13px;line-height:20px;}',
      '.fsx-skeleton{height:14px;border-radius:999px;background:var(--fsx-hover);animation:fsx-pulse 1.2s ease-in-out infinite;}',
      '@keyframes fsx-rise{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
      '@keyframes fsx-pulse{0%,100%{opacity:.45;}50%{opacity:.9;}}',
      '@keyframes fsx-spin{to{transform:rotate(360deg);}}',
      '@media (prefers-reduced-motion:reduce){',
      '#dsh-force-subagent{animation:none;}',
      '#dsh-force-subagent *{transition-duration:0ms !important;}',
      '.fsx-skeleton,.fsx-spinner{animation:none !important;}',
      '.fsx-card{animation:none;}',
      '}',
    ].join('\n');

    function useInjectedStyle() {
      React.useEffect(function () {
        if (typeof document === 'undefined' || document === null) return undefined;
        if (document.getElementById(STYLE_ID) !== null) return undefined;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.setAttribute('data-plugin', ENTRY);
        style.textContent = PANEL_CSS;
        document.head.appendChild(style);
        return function () {
          var node = document.getElementById(STYLE_ID);
          if (node !== null && node.parentNode !== null) node.parentNode.removeChild(node);
        };
      }, []);
    }

    // ------------------------------------------------------------------
    // 图标 / 入口组件
    // ------------------------------------------------------------------

    /** 分叉图形：一根主干分叉成两条支线（团队 / 委派语义），非齿轮、非字体字符。 */
    function ForkGlyph(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      },
        h('path', {
          d: 'M4.6 4.8 8 8.2l3.4-3.4M8 8.2V12.4',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M4.6 3.2h.01M11.4 3.2h.01M8 12.9h.01',
          stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round',
        }));
    }

    function apply(ctx) {
      var form;
      try {
        form = ctx.configForms.get(ENTRY);
      } catch (error) {
        form = null;
      }
      if (form === null || form === undefined || typeof form.getSnapshot !== 'function') {
        form = {
          getSnapshot: function () { return { status: 'unavailable', value: null, revision: 0, writable: false }; },
          subscribe: function () { return function () {}; },
          mutate: function () { return Promise.resolve(false); },
        };
      }

      var policyScope;
      try {
        policyScope = ctx.configForms.get(POLICY_NS);
      } catch (error) {
        policyScope = null;
      }
      if (policyScope === null || policyScope === undefined || typeof policyScope.getSnapshot !== 'function') {
        policyScope = {
          getSnapshot: function () { return { status: 'unavailable', value: null, revision: 0, writable: false }; },
          subscribe: function () { return function () {}; },
        };
      }

      function openPanel(sessionId) {
        bindSession(sessionId);
        try {
          ctx.layout.selectPanel(PANEL);
        } catch (error) {
          if (ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger.warn === 'function') {
            ctx.logger.warn('[force-subagent] 打开面板失败：' + (error instanceof Error ? error.message : String(error)));
          }
        }
      }

      /** 会话头按钮（工作区语境）：按钮本身就是自绘图标。 */
      function HeaderButton(props) {
        return h('button', {
          type: 'button',
          title: '强制委派模型设置（当前工作区）',
          'aria-label': '强制委派模型设置（当前工作区）',
          onClick: function () { openPanel(props.sessionId); },
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0, border: '0.5px solid var(--dsw-alias-border-l2, #494949)',
            borderRadius: 'var(--dsw-radius-sm, 8px)', background: 'transparent',
            color: 'inherit', cursor: 'pointer',
          },
        }, h(ForkGlyph, { size: 15 }));
      }

      /** 侧栏常驻入口：侧栏拥有按钮与点击，occupant 只渲染图标。 */
      function PanelIcon(props) {
        var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 18;
        return h(ForkGlyph, { size: size });
      }

      /** 会话行「…」菜单项（工作区树里）。 */
      function WorkspaceMenuItem(props) {
        return h('button', {
          type: 'button', role: 'menuitem',
          onClick: function () {
            var pair = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null;
            if (pair !== null && pair !== undefined) pair[1](false);
            openPanel(props.sessionId);
          },
          style: {
            display: 'block', width: '100%', padding: '6px 10px', border: 0,
            background: 'transparent', color: 'inherit', textAlign: 'left',
            font: 'inherit', cursor: 'pointer',
          },
        }, '强制委派模型设置');
      }

      /** 新会话 hero 区入口：blank 会话不渲染 header chrome，但会渲染 hero.options。 */
      function HeroAction(props) {
        return h('button', {
          type: 'button',
          title: '强制委派模型设置',
          'aria-label': '强制委派模型设置',
          onClick: function () { openPanel(props.sessionId); },
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 8,
            minHeight: 36, padding: '0 12px',
            border: '1px solid var(--dsw-alias-border-l2, #494949)',
            borderRadius: 'var(--dsw-radius-sm, 8px)',
            background: 'transparent', color: 'inherit',
            font: 'inherit', fontSize: 13, cursor: 'pointer',
          },
        }, h(ForkGlyph, { size: 15 }), h('span', null, '强制委派模型'));
      }

      // ------------------------------------------------------------------
      // hooks
      // ------------------------------------------------------------------

      function useScopeSnapshot(scope) {
        var state = React.useState(scope.getSnapshot());
        var snapshot = state[0], setSnapshot = state[1];
        React.useEffect(function () {
          var off = scope.subscribe(function () { setSnapshot(scope.getSnapshot()); });
          setSnapshot(scope.getSnapshot());
          return function () { if (typeof off === 'function') off(); };
        }, [scope]);
        return snapshot;
      }

      function useWorkspaceItems() {
        var state = React.useState(function () { return readWorkspaceState(ctx); });
        var current = state[0], setCurrent = state[1];
        React.useEffect(function () {
          var service;
          try {
            service = ctx.get('workspaces');
          } catch (error) {
            setCurrent(readWorkspaceState(ctx));
            return undefined;
          }
          var list = service !== null && service !== undefined ? service.list : undefined;
          var applyLatest = function () { setCurrent(readWorkspaceState(ctx)); };
          applyLatest();
          if (list === null || list === undefined || typeof list.subscribe !== 'function') return undefined;
          var off;
          try {
            off = list.subscribe(applyLatest);
          } catch (error) {
            setCurrent(readWorkspaceState(ctx));
            return undefined;
          }
          return function () { if (typeof off === 'function') off(); };
        }, []);
        return current;
      }

      function useBoundSession() {
        var state = React.useState(boundSessionId);
        var sessionId = state[0], setSessionId = state[1];
        React.useEffect(function () {
          return subscribeBind(function () { setSessionId(boundSessionId); });
        }, []);
        return sessionId;
      }

      function useCatalog() {
        var state = React.useState({ status: 'idle', groups: [], failures: [], error: '' });
        var catalog = state[0], setCatalog = state[1];
        var generation = React.useRef(0);

        var load = React.useCallback(function () {
          var remote;
          try {
            remote = ctx.get('remote');
          } catch (error) {
            remote = undefined;
          }
          var session = remote !== null && remote !== undefined ? remote.session : undefined;
          if (session === null || session === undefined || typeof session.modelCatalog !== 'function') {
            setCatalog({ status: 'unavailable', groups: [], failures: [], error: '' });
            return;
          }
          var current = generation.current + 1;
          generation.current = current;
          setCatalog(function (previous) {
            return { status: 'loading', groups: previous.groups, failures: [], error: '' };
          });
          Promise.resolve()
            .then(function () { return session.modelCatalog(); })
            .then(function (response) {
              if (generation.current !== current) return;
              if (response !== null && response !== undefined && response.ok === true && isObject(response.value)) {
                var groups = Array.isArray(response.value.groups) ? response.value.groups : [];
                var failures = Array.isArray(response.value.failures) ? response.value.failures : [];
                setCatalog({ status: 'ready', groups: groups, failures: failures, error: '' });
              } else {
                var message = response !== null && response !== undefined && isObject(response.error)
                  && typeof response.error.message === 'string' ? response.error.message : '模型目录请求失败';
                setCatalog({ status: 'error', groups: [], failures: [], error: message });
              }
            })
            .catch(function (failure) {
              if (generation.current !== current) return;
              setCatalog({
                status: 'error', groups: [], failures: [],
                error: failure instanceof Error ? failure.message : String(failure),
              });
            });
        }, []);

        React.useEffect(function () {
          load();
          var remote;
          try {
            remote = ctx.get('remote');
          } catch (error) {
            remote = undefined;
          }
          var off;
          if (remote !== null && remote !== undefined && typeof remote.$on === 'function') {
            try {
              off = remote.$on('llm/adapters-updated', load);
            } catch (error) {
              off = undefined;
            }
          }
          return function () {
            generation.current += 1;
            if (typeof off === 'function') off();
          };
        }, [load]);

        return { catalog: catalog, reload: load };
      }

      // ------------------------------------------------------------------
      // 面板
      // ------------------------------------------------------------------

      function SettingsPanel() {
        useInjectedStyle();

        var snapshot = useScopeSnapshot(form);
        var policySnapshot = useScopeSnapshot(policyScope);
        var workspaceState = useWorkspaceItems();
        var workspaces = workspaceState.items;
        var workspaceError = workspaceState.error;
        var bound = useBoundSession();
        var catalogState = useCatalog();
        var catalog = catalogState.catalog;
        var keyState = React.useState(null);
        var selectedKey = keyState[0], setSelectedKey = keyState[1];
        var draftState = React.useState({
          memberProvider: '', memberModel: '', subagentProvider: '', subagentModel: '',
        });
        var draft = draftState[0], setDraft = draftState[1];
        var enabledState = React.useState(true);
        var enabled = enabledState[0], setEnabled = enabledState[1];
        var modeState = React.useState('nested');
        var mode = modeState[0], setMode = modeState[1];
        var busyState = React.useState(false);
        var busy = busyState[0], setBusy = busyState[1];
        var noticeState = React.useState('');
        var notice = noticeState[0], setNotice = noticeState[1];
        var errorState = React.useState('');
        var error = errorState[0], setError = errorState[1];

        var itemsVersion = workspaces.map(function (item) { return workspaceKeyOf(item) || ''; }).join('\u0001');

        React.useEffect(function () {
          if (bound !== null && bound !== undefined) {
            var match = workspaceOf(ctx, bound, workspaces);
            setSelectedKey(match !== null ? workspaceKeyOf(match) : null);
            return;
          }
          if (selectedKey !== null && selectedKey !== undefined) {
            var exists = workspaces.some(function (item) { return workspaceKeyOf(item) === selectedKey; });
            if (exists) return;
          }
          // 根入口没有会话上下文：不自动挑第一个工作区，要求用户显式选择，避免静默写错。
          setSelectedKey(null);
        }, [bound, itemsVersion]);

        React.useEffect(function () {
          if (snapshot.status !== 'ready' || selectedKey === null || selectedKey === undefined) return;
          setDraft(buildDraft(workspacesRecordOf(snapshot.value), selectedKey));
          setEnabled(isObject(snapshot.value) && snapshot.value.enabled === true);
          setMode(isObject(snapshot.value) && typeof snapshot.value.mode === 'string' ? snapshot.value.mode : 'nested');
        }, [selectedKey, snapshot.revision, snapshot.status]);

        var value = isObject(snapshot.value) ? snapshot.value : {};
        var inherited = {
          member: routeOf(value.member),
          subagent: routeOf(value.subagent),
        };
        var memberOptions = buildModelOptions({ policy: policySnapshot, catalog: catalog, current: {
          provider: draft.memberProvider, model: draft.memberModel,
        } });
        var subagentOptions = buildModelOptions({ policy: policySnapshot, catalog: catalog, current: {
          provider: draft.subagentProvider, model: draft.subagentModel,
        } });

        var editable = snapshot.status === 'ready' && selectedKey !== null && selectedKey !== undefined && busy !== true;
        var valid = draftIsValid(draft);
        var canSave = editable && valid;

        var chip = { tone: 'ok', text: '已就绪' };
        if (snapshot.status === 'loading') chip = { tone: 'warn', text: '加载中' };
        else if (snapshot.status === 'unavailable') chip = { tone: 'error', text: '配置不可用' };
        else if (selectedKey === null || selectedKey === undefined) chip = { tone: 'warn', text: '未选择工作区' };
        else if (policySnapshot.status === 'ready' && isObject(policySnapshot.value)
          && policySnapshot.value.enabled === true && policyOptionsEmpty(policySnapshot)) {
          chip = { tone: 'warn', text: '允许模型为空' };
        }

        function resetFeedback() {
          setNotice('');
          setError('');
        }

        function selectWorkspace(event) {
          resetFeedback();
          setSelectedKey(event.target.value === '' ? null : event.target.value);
        }

        function changeProvider(field, modelField, options, provider) {
          resetFeedback();
          setDraft(function (previous) {
            var next = {};
            Object.keys(previous).forEach(function (name) { next[name] = previous[name]; });
            next[field] = provider;
            if (provider === '') {
              next[modelField] = '';
              return next;
            }
            var group = providerGroupOf(options, provider);
            next[modelField] = group !== null && group.models.length > 0 ? group.models[0].model : '';
            return next;
          });
        }

        function changeModel(field, model) {
          resetFeedback();
          setDraft(function (previous) {
            var next = {};
            Object.keys(previous).forEach(function (name) { next[name] = previous[name]; });
            next[field] = model;
            return next;
          });
        }

        function save() {
          if (!canSave) return;
          var fresh = form.getSnapshot();
          if (fresh.status !== 'ready') {
            setError('配置尚未就绪，稍后重试');
            return;
          }
          var key = selectedKey;
          var operations = buildSaveOperations(workspacesRecordOf(fresh.value), key, draft, enabled === true, mode);
          setBusy(true);
          setNotice('');
          setError('');
          var pending;
          try {
            pending = form.mutate(operations, fresh.revision);
          } catch (failure) {
            setBusy(false);
            setError('保存失败：' + (failure instanceof Error ? failure.message : String(failure)));
            return;
          }
          Promise.resolve(pending).then(function (ok) {
            setBusy(false);
            if (ok === true) setNotice('已保存');
            else setError('保存未生效：配置可能已在别处更新，请重试');
          }, function (failure) {
            setBusy(false);
            setError('保存失败：' + (failure !== null && failure !== undefined && failure.message
              ? failure.message : String(failure)));
          });
        }

        function renderSelect(id, label, hint, value, disabled, options, onChange) {
          var hintId = id + '-hint';
          return h('div', { className: 'fsx-field' },
            h('label', { className: 'fsx-label', htmlFor: id }, label),
            h('select', {
              id: id, className: 'fsx-select', value: value,
              disabled: disabled === true,
              'aria-describedby': hintId,
              onChange: function (event) { onChange(event.target.value); },
            }, options),
            h('p', { className: 'fsx-hint', id: hintId }, hint));
        }

        function providerChoices(options) {
          var list = [h('option', { value: '' }, '继承默认')];
          options.providers.forEach(function (group) {
            var text = group.label === group.provider ? group.provider : group.label;
            list.push(h('option', { value: group.provider, title: group.provider }, text));
          });
          return list;
        }

        function modelChoices(provider, options) {
          var group = providerGroupOf(options, provider);
          var list = [h('option', { value: '' }, provider === '' ? '继承默认' : '请选择模型')];
          if (group === null) return list;
          group.models.forEach(function (entry) {
            var text = entry.label === entry.model ? entry.model : entry.label;
            list.push(h('option', { value: entry.model, title: entry.model }, text));
          });
          return list;
        }

        function renderRouteCard(title, description, options, inheritedRoute, providerField, modelField) {
          var provider = draft[providerField];
          var model = draft[modelField];
          var group = providerGroupOf(options, provider);
          var noModels = provider !== '' && (group === null || group.models.length === 0);
          var providerHint = inheritedRoute.provider
            ? '留空则继承全局默认：' + routeText(inheritedRoute)
            : '留空则继承全局默认路由';
          var modelHint = provider === ''
            ? '选择 provider 后可选模型'
            : noModels ? '该 provider 暂无可选模型' : ('当前：' + routeText({ provider: provider, model: model }));
          var catalogHint = null;
          if (options.status === 'loading') catalogHint = h('p', { className: 'fsx-hint' }, '模型目录加载中…');
          else if (options.status === 'error') {
            catalogHint = h('p', { className: 'fsx-hint fsx-hint--error', role: 'status' },
              '模型目录加载失败，仅显示当前配置。',
              h('button', {
                type: 'button', className: 'fsx-link',
                onClick: function () { catalogState.reload(); },
              }, '重试'));
          } else if (options.status === 'policy-empty') {
            catalogHint = h('p', { className: 'fsx-hint fsx-hint--error' },
              '子代理允许模型策略已启用但列表为空，请先在 设置 → 子代理 → 允许模型 中添加。');
          } else if (options.status === 'empty') {
            catalogHint = h('p', { className: 'fsx-hint fsx-hint--error' },
              '没有可用模型：请检查模型 provider 或子代理允许模型设置。');
          } else if (catalogState.catalog.status === 'unavailable' && options.source === 'current') {
            catalogHint = h('p', { className: 'fsx-hint' }, '模型目录不可用，仅显示当前配置。');
          }
          return h('section', { className: 'fsx-card' },
            h('div', { className: 'fsx-card-head' },
              h('h2', { className: 'fsx-card-title' }, title),
              h('p', { className: 'fsx-card-desc' }, description)),
            h('div', { className: 'fsx-grid' },
              renderSelect('fsx-' + providerField, 'Provider', providerHint, provider,
                editable !== true, providerChoices(options),
                function (next) { changeProvider(providerField, modelField, options, next); }),
              renderSelect('fsx-' + modelField, 'Model', modelHint, model,
                editable !== true || provider === '' || noModels, modelChoices(provider, options),
                function (next) { changeModel(modelField, next); })),
            catalogHint);
        }

        var banner = null;
        if (snapshot.status === 'unavailable') {
          banner = h('p', { className: 'fsx-banner', role: 'alert' },
            h('span', null, h('strong', null, '配置不可用。'), '宿主没有提供 ' + ENTRY + ' 的设置命名空间，请检查插件是否安装并重启宿主。'));
        } else if (snapshot.status === 'loading') {
          banner = h('p', { className: 'fsx-banner', role: 'status' }, h('span', null, '正在读取配置…'));
        } else if (workspaceError !== '') {
          banner = h('p', { className: 'fsx-banner', role: 'alert' },
            h('span', null, h('strong', null, '工作区服务不可用。'), '原因：' + workspaceError + '。请重启宿主或检查插件加载。'));
        } else if (selectedKey === null || selectedKey === undefined) {
          banner = h('p', { className: 'fsx-banner', role: 'status' },
            h('span', null,
              h('strong', null, bound !== null && bound !== undefined ? '当前会话未归属任何工作区。' : '请选择工作区。'),
              bound !== null && bound !== undefined
                ? '不会自动回退到第一个工作区；请手动选择，避免把路由写错地方。'
                : '选择后即可编辑该工作区的模型路由。'));
        } else if (policySnapshot.status === 'loading') {
          banner = h('p', { className: 'fsx-banner', role: 'status' }, h('span', null, '允许模型策略加载中…'));
        } else if (policySnapshot.status === 'unavailable') {
          banner = h('p', { className: 'fsx-banner', role: 'alert' },
            h('span', null, h('strong', null, '允许模型策略不可读。'), '下拉仅显示模型目录与当前路由；保存的模型路由可能被宿主拒绝。'));
        } else if (policySnapshot.status === 'ready' && isObject(policySnapshot.value)
          && policySnapshot.value.enabled === true && policyOptionsEmpty(policySnapshot)) {
          banner = h('p', { className: 'fsx-banner', role: 'status' },
            h('span', null, h('strong', null, '允许模型为空。'), '子代理模型策略已启用但未配置 allowedModels，保存的模型路由会被宿主拒绝。'));
        }

        var workspaceSelect = null;
        if (workspaceError !== '') {
          workspaceSelect = h('p', { className: 'fsx-hint fsx-hint--error', role: 'alert' },
            '工作区服务不可用，无法选择工作区。');
        } else if (workspaces.length > 0 || (selectedKey !== null && selectedKey !== undefined)) {
          var workspaceChoices = workspaces.slice();
          var selectedListed = workspaceChoices.some(function (item) { return workspaceKeyOf(item) === selectedKey; });
          if (!selectedListed && selectedKey !== null && selectedKey !== undefined) {
            workspaceChoices.push({ path: selectedKey, title: '', workspaceId: '' });
          }
          var workspaceOptions = [h('option', { value: '' }, '请选择工作区…')];
          workspaceChoices.forEach(function (item) {
            var key = workspaceKeyOf(item);
            if (key === undefined) return;
            workspaceOptions.push(h('option', { key: key, value: key }, workspaceTitleOf(item)));
          });
          workspaceSelect = h('div', { className: 'fsx-field' },
            h('label', { className: 'fsx-label', htmlFor: 'fsx-workspace' }, '工作区'),
            h('select', {
              id: 'fsx-workspace', className: 'fsx-select',
              value: selectedKey === null || selectedKey === undefined ? '' : selectedKey,
              disabled: busy === true,
              onChange: selectWorkspace,
            }, workspaceOptions),
            h('p', { className: 'fsx-hint' },
              selectedKey !== null && selectedKey !== undefined ? selectedKey : '选择一个工作区以编辑其模型路由'));
        } else {
          workspaceSelect = h('div', { className: 'fsx-empty' }, '没有找到工作区。请先创建工作区，再从工作区里的会话打开本页。');
        }

        var disabledReason = '';
        if (snapshot.status !== 'ready') disabledReason = '配置不可用';
        else if (selectedKey === null || selectedKey === undefined) disabledReason = '请选择工作区';
        else if (!valid) disabledReason = 'provider 与 model 需成对选择';
        else if (busy === true) disabledReason = '保存中…';

        return h('section', { id: PANEL },
          h('header', { className: 'fsx-header' },
            h('div', { className: 'fsx-heading' },
              h('span', { className: 'fsx-mark', 'aria-hidden': 'true' }, h(ForkGlyph, { size: 20 })),
              h('div', { style: { minWidth: 0 } },
                h('p', { className: 'fsx-eyebrow' }, 'AGENT TEAM'),
                h('h1', { className: 'fsx-title' }, '强制委派'))),
            h('span', { className: 'fsx-chip fsx-chip--' + chip.tone },
              h('span', { className: 'fsx-dot', 'aria-hidden': 'true' }), chip.text)),
          h('p', { className: 'fsx-subtitle' },
            '按工作区设置成员与子代理的模型路由；保存后对该工作区的新会话同样生效。'),
          banner,
          h('section', { className: 'fsx-card' },
            h('div', { className: 'fsx-card-head' },
              h('h2', { className: 'fsx-card-title' }, '工作区配置'),
              h('p', { className: 'fsx-card-desc' }, '模型路由跟随工作区保存')),
            workspaceSelect),
          renderRouteCard('成员模型', 'Team 成员子代理使用的模型路由（flat 模式下成员不派子代理，此路由不生效）',
            memberOptions, inherited.member, 'memberProvider', 'memberModel'),
          renderRouteCard('子代理模型', '普通 subagent 使用的模型路由',
            subagentOptions, inherited.subagent, 'subagentProvider', 'subagentModel'),
          renderSelect('fsx-mode', '委派模式', 'A：成员可派子代理；B：只用成员，成员不再派子代理。', mode,
            editable !== true,
            [h('option', { value: 'nested' }, '成员可派子代理'), h('option', { value: 'flat' }, '仅用成员（不派子代理）')],
            function (next) { setMode(next); resetFeedback(); }),
          h('section', { className: 'fsx-card fsx-switch-row' },
            h('div', { className: 'fsx-switch-copy' },
              h('label', { className: 'fsx-card-title', htmlFor: 'fsx-enabled' }, '启用强制委派提示（全局）'),
              h('p', { className: 'fsx-hint' }, '全局开关：关闭后对所有工作区生效，子代理不再套用本页的模型路由；Agent-Team 提示词由 /using-agent-team 命令控制。')),
            h('input', {
              id: 'fsx-enabled', className: 'fsx-checkbox', type: 'checkbox',
              checked: enabled === true, disabled: editable !== true,
              onChange: function (event) { setEnabled(event.target.checked === true); resetFeedback(); },
            })),
          h('div', { className: 'fsx-savebar' },
            h('button', {
              type: 'button', className: 'fsx-primary', disabled: canSave !== true, onClick: save,
              'aria-busy': busy === true,
            },
              busy === true ? h('span', { className: 'fsx-spinner', 'aria-hidden': 'true' }) : null,
              busy === true ? '保存中…' : '保存设置'),
            h('p', { className: 'fsx-hint' }, '保存会同时写入全局开关与当前工作区的模型路由。'),
            disabledReason === '' ? null
              : h('p', { className: 'fsx-hint' }, disabledReason),
            notice === '' ? null : h('p', { className: 'fsx-feedback fsx-feedback--ok', role: 'status' }, notice),
            error === '' ? null : h('p', { className: 'fsx-feedback fsx-feedback--error', role: 'alert' }, error)));
      }

      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({
          name: 'main', key: PANEL,
          inject: function () { return {}; },
        }, SettingsPanel);
      });

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL,
          order: 20,
          label: '强制委派',
        }, PanelIcon);
      });

      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'force-subagent-route',
          order: 30,
          inject: function () { return {}; },
        }, HeaderButton);
      });

      ctx.slots.inject('conversation.hero.options', function () {
        return ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'force-subagent-route',
          order: 100,
          inject: function () { return {}; },
        }, HeroAction);
      });

      ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
        return ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'force-subagent-route',
          order: 900,
          inject: function () { return {}; },
        }, WorkspaceMenuItem);
      });
    }

    function policyOptionsEmpty(snapshot) {
      if (!isObject(snapshot) || !isObject(snapshot.value)) return false;
      var list = Array.isArray(snapshot.value.allowedModels) ? snapshot.value.allowedModels : [];
      return list.length === 0;
    }

    module.exports = {
      name: ENTRY,
      inject: ['slots', 'configForms', 'layout', 'workspaces', 'sessions', 'remote', 'remote.session'],
      apply: apply,
      __test: {
        buildModelOptions: buildModelOptions,
        buildDraft: buildDraft,
        buildSaveOperations: buildSaveOperations,
        buildWorkspacesMutation: buildWorkspacesMutation,
        draftIsValid: draftIsValid,
        providerGroupOf: providerGroupOf,
        routeOf: routeOf,
        routeText: routeText,
        readWorkspaceState: readWorkspaceState,
        workspaceBySession: workspaceBySession,
        workspaceOf: workspaceOf,
        workspaceKeyOf: workspaceKeyOf,
        workspaceTitleOf: workspaceTitleOf,
        workspacesRecordOf: workspacesRecordOf,
      },
    };

    return module.exports;
  },
});
