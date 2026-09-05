// api-config-groups.js — Float 风格的可展开 API 分组配置
// 一个分组共享 Base URL / API Key，并可保存多个模型。
(function() {
  'use strict'

  var GROUPS_KEY = 'apiConfigGroupsV2'
  var cache = null

  function makeId() {
    return 'api-group-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
  }

  function esc(value) {
    if (window.settingsEscHtml) return window.settingsEscHtml(value)
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function normalizeUrl(value) {
    if (window.normalizeApiBaseUrl) return window.normalizeApiBaseUrl(value)
    return String(value || '').trim().replace(/\/+$/, '')
  }

  function hostname(value) {
    try { return new URL(normalizeUrl(value)).hostname.toLowerCase() } catch (_) { return '' }
  }

  function inferTitle(url) {
    var host = hostname(url)
    if (!host) return 'API 配置'
    if (host === 'api.openai.com') return 'OpenAI'
    if (host === 'api.anthropic.com') return 'Anthropic'
    if (host === 'generativelanguage.googleapis.com') return 'Google Gemini'
    if (host === 'api.deepseek.com') return 'DeepSeek'
    if (host === 'openrouter.ai') return 'OpenRouter'
    return host.replace(/^api\./, '')
  }

  function uniqueModels(values) {
    var seen = {}
    return (Array.isArray(values) ? values : []).map(function(value) {
      return String(value || '').trim()
    }).filter(function(value) {
      if (!value || seen[value]) return false
      seen[value] = true
      return true
    })
  }

  function normalizeGroup(value, index) {
    var raw = value && typeof value === 'object' ? value : {}
    var legacyModel = String(raw.model || '').trim()
    var selectedModel = String(raw.selectedModel || legacyModel).trim()
    var models = uniqueModels((Array.isArray(raw.models) ? raw.models : []).concat([legacyModel, selectedModel]))
    if (!selectedModel && models.length) selectedModel = models[0]
    return {
      id: String(raw.id || makeId()),
      title: String(raw.title || raw.groupTitle || raw.name || inferTitle(raw.url || raw.baseUrl) || ('API 配置 ' + ((index || 0) + 1))).trim(),
      url: normalizeUrl(raw.url || raw.baseUrl),
      key: String(raw.key || raw.apiKey || '').trim(),
      models: models,
      selectedModel: selectedModel
    }
  }

  function sameConnection(group, api) {
    return normalizeUrl(group && group.url) === normalizeUrl(api && api.url) &&
      String(group && group.key || '') === String(api && api.key || '')
  }

  function isActiveGroup(group, activeApi) {
    var hasActive = !!(activeApi && (activeApi.url || activeApi.key || activeApi.model))
    return hasActive && sameConnection(group, activeApi)
  }

  function isActiveModel(group, model, activeApi) {
    return isActiveGroup(group, activeApi) && String(model || '') === String(activeApi && activeApi.model || '')
  }

  function legacyPresets(groups) {
    var rows = []
    groups.forEach(function(group) {
      uniqueModels(group.models).forEach(function(model) {
        rows.push({
          name: group.title,
          groupId: group.id,
          groupTitle: group.title,
          url: group.url,
          key: group.key,
          model: model
        })
      })
    })
    return rows
  }

  async function persistGroups(groups) {
    var normalized = (Array.isArray(groups) ? groups : []).map(normalizeGroup)
    cache = normalized
    await Promise.all([
      db.config.put({ key: GROUPS_KEY, value: normalized }),
      // 保留旧键，让旧备份和尚未更新的入口仍能读取全部模型。
      db.config.put({ key: 'apiPresets', value: legacyPresets(normalized) })
    ])
    return normalized
  }

  async function loadGroups(force) {
    if (cache && !force) return cache
    var rows = await Promise.all([
      db.config.get(GROUPS_KEY),
      db.config.get('apiPresets'),
      db.config.get('apiBaseUrl'),
      db.config.get('apiKey'),
      db.config.get('apiModel')
    ])
    if (rows[0] && Array.isArray(rows[0].value)) {
      cache = rows[0].value.map(normalizeGroup)
      return cache
    }

    var groups = []
    var oldPresets = rows[1] && Array.isArray(rows[1].value) ? rows[1].value : []
    oldPresets.forEach(function(preset) {
      var next = normalizeGroup(preset, groups.length)
      var existing = groups.find(function(group) { return sameConnection(group, next) })
      if (!existing) {
        groups.push(next)
        return
      }
      existing.models = uniqueModels(existing.models.concat(next.models))
      if (!existing.selectedModel) existing.selectedModel = next.selectedModel
    })

    var activeApi = {
      url: rows[2] ? rows[2].value : '',
      key: rows[3] ? rows[3].value : '',
      model: rows[4] ? rows[4].value : ''
    }
    if (activeApi.url || activeApi.key || activeApi.model) {
      var activeGroup = groups.find(function(group) { return sameConnection(group, activeApi) })
      if (!activeGroup) {
        activeGroup = normalizeGroup({
          title: inferTitle(activeApi.url),
          url: activeApi.url,
          key: activeApi.key,
          models: [activeApi.model],
          selectedModel: activeApi.model
        }, 0)
        groups.unshift(activeGroup)
      } else if (activeApi.model) {
        activeGroup.models = uniqueModels(activeGroup.models.concat([activeApi.model]))
        activeGroup.selectedModel = activeApi.model
      }
    }
    return await persistGroups(groups)
  }

  async function loadActiveApi() {
    if (window.loadApiConfig) return (await window.loadApiConfig()).primary
    var rows = await Promise.all([
      db.config.get('apiBaseUrl'),
      db.config.get('apiKey'),
      db.config.get('apiModel')
    ])
    return {
      url: rows[0] ? rows[0].value : '',
      key: rows[1] ? rows[1].value : '',
      model: rows[2] ? rows[2].value : ''
    }
  }

  async function setActive(group, model) {
    var selected = String(model || group.selectedModel || '').trim()
    await Promise.all([
      db.config.put({ key: 'apiBaseUrl', value: normalizeUrl(group.url) }),
      db.config.put({ key: 'apiKey', value: String(group.key || '').trim() }),
      db.config.put({ key: 'apiModel', value: selected })
    ])
    window._apiConfigCache = null
    var settingsPage = document.getElementById('settings-page')
    if (settingsPage && window.updateRowValues) await window.updateRowValues(settingsPage)
  }

  function modelRow(model, selected, index, radioName) {
    return '<div class="api-group-model-row" data-model-row>' +
      '<label class="api-group-model-radio" title="设为分组当前模型">' +
        '<input type="radio" name="' + esc(radioName) + '" data-model-current' + (selected ? ' checked' : '') + '>' +
        '<span></span>' +
      '</label>' +
      '<input class="input-field" data-model-input value="' + esc(model || '') + '" placeholder="模型 ' + (index + 1) + '，例如 gpt-4o-mini">' +
      '<button class="api-group-icon-btn btn-text-danger" type="button" data-action="remove-model" aria-label="删除模型"><i class="fa fa-trash"></i></button>' +
    '</div>'
  }

  function groupCard(group, activeApi, open) {
    var models = group.models.length ? group.models : ['']
    var selectedModel = group.selectedModel || models[0] || ''
    var active = isActiveGroup(group, activeApi)
    var radioName = 'api-group-model-' + group.id.replace(/[^a-zA-Z0-9_-]/g, '')
    return '<details class="api-config-group" data-group-id="' + esc(group.id) + '"' + (open ? ' open' : '') + '>' +
      '<summary class="api-config-group-summary">' +
        '<span class="api-config-group-copy">' +
          '<strong data-summary-title>' + esc(group.title || 'API 配置') + '</strong>' +
          '<small data-summary-model>' + esc(selectedModel || '未设置模型') + '</small>' +
        '</span>' +
        (active ? '<span class="api-group-active-badge">使用中</span>' : '') +
        '<i class="fa fa-angle-down api-config-group-chevron"></i>' +
      '</summary>' +
      '<div class="api-config-group-body">' +
        '<label class="form-label">服务商 / 分组名称</label>' +
        '<input class="input-field" data-field="title" value="' + esc(group.title) + '" placeholder="例如：ZenMux、橘子汽水">' +
        '<label class="form-label">Base URL</label>' +
        '<input class="input-field" data-field="url" value="' + esc(group.url) + '" placeholder="https://api.openai.com/v1">' +
        '<label class="form-label">API Key</label>' +
        '<div class="input-with-toggle">' +
          '<input class="input-field" data-field="key" type="password" autocomplete="off" value="' + esc(group.key) + '" placeholder="sk-...">' +
          '<button class="btn-text-toggle" data-action="toggle-key" type="button">显示</button>' +
        '</div>' +
        '<div class="api-group-model-head"><span class="form-label">已保存模型</span><button class="btn-ghost btn-sm" data-action="add-model" type="button"><i class="fa fa-plus"></i> 添加模型</button></div>' +
        '<div class="api-group-model-list" data-model-list>' +
          models.map(function(model, index) {
            return modelRow(model, model === selectedModel || (!selectedModel && index === 0), index, radioName)
          }).join('') +
        '</div>' +
        '<div class="model-row api-group-fetch-row">' +
          '<select class="input-field" data-fetched-model><option value="">拉取后选择并添加模型</option></select>' +
          '<button class="btn-ghost btn-sm" data-action="fetch-models" type="button">获取</button>' +
        '</div>' +
        '<div class="section-desc api-provider-hint" data-provider-hint hidden></div>' +
        '<div class="api-group-primary-actions">' +
          '<button class="btn-ghost" data-action="test" type="button">连接测试</button>' +
          '<button class="btn-pill" data-action="save" type="button">保存分组</button>' +
        '</div>' +
        '<button class="btn-ghost btn-full api-group-use-button" data-action="use" type="button">设为当前 API</button>' +
        '<button class="btn-ghost btn-full btn-text-danger api-group-delete-button" data-action="delete" type="button">删除整个分组</button>' +
      '</div>' +
    '</details>'
  }

  function getValue(card, selector) {
    return String((card.querySelector(selector) || {}).value || '').trim()
  }

  function readDraft(card) {
    var modelRows = Array.prototype.slice.call(card.querySelectorAll('[data-model-row]'))
    var models = uniqueModels(modelRows.map(function(row) {
      return String((row.querySelector('[data-model-input]') || {}).value || '').trim()
    }))
    var selectedRadio = card.querySelector('[data-model-current]:checked')
    var selectedRow = selectedRadio && selectedRadio.closest('[data-model-row]')
    var selectedModel = selectedRow
      ? String((selectedRow.querySelector('[data-model-input]') || {}).value || '').trim()
      : ''
    if (!selectedModel && models.length) selectedModel = models[0]
    return normalizeGroup({
      id: card.getAttribute('data-group-id'),
      title: getValue(card, '[data-field="title"]'),
      url: getValue(card, '[data-field="url"]'),
      key: getValue(card, '[data-field="key"]'),
      models: models,
      selectedModel: selectedModel
    }, 0)
  }

  function validateDraft(group) {
    if (!group.title) throw new Error('请填写服务商或分组名称')
    if (!group.url) throw new Error('请填写 Base URL')
    if (!group.key) throw new Error('请填写 API Key')
    if (!group.models.length || !group.selectedModel) throw new Error('请至少保存一个模型并选为当前模型')
  }

  function renumberRows(card) {
    var rows = Array.prototype.slice.call(card.querySelectorAll('[data-model-row]'))
    rows.forEach(function(row, index) {
      var input = row.querySelector('[data-model-input]')
      if (input) input.placeholder = '模型 ' + (index + 1) + '，例如 gpt-4o-mini'
    })
    if (rows.length && !card.querySelector('[data-model-current]:checked')) {
      rows[0].querySelector('[data-model-current]').checked = true
    }
  }

  function appendModelRow(card, model, select) {
    var list = card.querySelector('[data-model-list]')
    if (!list) return
    var cleanModel = String(model || '').trim()
    var existing = Array.prototype.slice.call(list.querySelectorAll('[data-model-input]')).find(function(input) {
      return cleanModel && String(input.value || '').trim() === cleanModel
    })
    if (existing) {
      if (select) existing.closest('[data-model-row]').querySelector('[data-model-current]').checked = true
      existing.focus()
      return
    }
    var radioName = 'api-group-model-' + String(card.getAttribute('data-group-id') || '').replace(/[^a-zA-Z0-9_-]/g, '')
    var holder = document.createElement('div')
    holder.innerHTML = modelRow(cleanModel, !!select, list.querySelectorAll('[data-model-row]').length, radioName)
    list.appendChild(holder.firstElementChild)
    if (select) list.lastElementChild.querySelector('[data-model-current]').checked = true
    renumberRows(card)
    list.lastElementChild.querySelector('[data-model-input]').focus()
  }

  function refreshSummary(card) {
    var selected = card.querySelector('[data-model-current]:checked')
    var selectedRow = selected && selected.closest('[data-model-row]')
    var modelInput = selectedRow && selectedRow.querySelector('[data-model-input]')
    var title = getValue(card, '[data-field="title"]')
    var summaryTitle = card.querySelector('[data-summary-title]')
    var summaryModel = card.querySelector('[data-summary-model]')
    if (summaryTitle) summaryTitle.textContent = title || 'API 配置'
    if (summaryModel) summaryModel.textContent = modelInput && modelInput.value.trim() ? modelInput.value.trim() : '未设置模型'
  }

  function refreshProviderHint(card) {
    var hint = card.querySelector('[data-provider-hint]')
    if (!hint || !window.getGeminiPromptCacheInfo) return
    var group = readDraft(card)
    var info = window.getGeminiPromptCacheInfo(group.url, group.selectedModel)
    if (!info) {
      hint.hidden = true
      hint.textContent = ''
      return
    }
    hint.textContent = info.channel === 'Gemini 官方'
      ? (info.supported ? 'Gemini 官方将自动使用隐式缓存，命中以 API 控制台的上游用量为准。' : 'Gemini 官方端点；当前模型未确认支持隐式缓存。')
      : '此 Gemini 中转的缓存能力由服务商决定；API 控制台只显示上游返回的真实用量。'
    hint.hidden = false
  }

  async function fetchModels(card, button) {
    var group = readDraft(card)
    if (!group.url) throw new Error('请先填写 Base URL')
    if (!group.key) throw new Error('请先填写 API Key')
    var oldText = button.textContent
    button.textContent = '获取中...'
    button.disabled = true
    try {
      var officialGemini = hostname(group.url) === 'generativelanguage.googleapis.com'
      var modelsUrl = officialGemini ? '/api/gemini/models' : normalizeUrl(group.url) + '/models'
      var response = await fetch(modelsUrl, { headers: { Authorization: 'Bearer ' + group.key } })
      var json = await window.readApiTestJsonResponse(response, '获取模型失败')
      var models = window.parseModelList(json)
      var select = card.querySelector('[data-fetched-model]')
      select.innerHTML = '<option value="">选择一个模型加入分组</option>' + models.map(function(model) {
        return '<option value="' + esc(model) + '">' + esc(model) + '</option>'
      }).join('')
      window.toast('已加载 ' + models.length + ' 个模型')
    } finally {
      button.textContent = oldText
      button.disabled = false
    }
  }

  async function testConnection(card, button) {
    var group = readDraft(card)
    var oldText = button.textContent
    button.textContent = '测试中...'
    button.disabled = true
    try {
      validateDraft(group)
      var json = await window.runTrackedChatCompletion({
        url: group.url,
        key: group.key,
        model: group.selectedModel
      }, {
        model: group.selectedModel,
        messages: [{ role: 'user', content: '请只回复：连接成功' }]
      }, group.title + ' 连接测试')
      var reply = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
      if (!reply) throw new Error('接口已响应，但没有返回有效的聊天内容。')
      window.showApiTestModal(group.title + ' 连接成功', true, '连接成功，模型已返回内容。', '模型回复：' + reply)
    } catch (error) {
      var hint = window.getApiTestHint ? window.getApiTestHint(error.status, error.detail || error.message) : ''
      window.showApiTestModal(group.title + ' 连接失败', false, error.message || '连接测试失败', hint)
    } finally {
      button.textContent = oldText
      button.disabled = false
    }
  }

  async function saveFromCard(page, card, activate) {
    var draft = readDraft(card)
    validateDraft(draft)
    var groups = await loadGroups()
    var activeApi = await loadActiveApi()
    var previous = groups.find(function(group) { return group.id === draft.id })
    var wasActive = previous ? isActiveGroup(previous, activeApi) : false
    var index = groups.findIndex(function(group) { return group.id === draft.id })
    if (index >= 0) groups[index] = draft
    else groups.push(draft)
    await persistGroups(groups)
    if (activate || wasActive) await setActive(draft, draft.selectedModel)
    await renderList(page, draft.id)
    window.toast(activate ? '分组已保存并设为当前 API' : 'API 分组已保存')
  }

  async function removeGroup(page, card) {
    var draft = readDraft(card)
    var groups = await loadGroups()
    var existing = groups.find(function(group) { return group.id === draft.id })
    if (!existing) {
      card.remove()
      return
    }
    if (!confirm('删除“' + draft.title + '”及其中保存的全部模型？')) return
    var activeApi = await loadActiveApi()
    var deletingActive = isActiveGroup(existing, activeApi)
    await persistGroups(groups.filter(function(group) { return group.id !== draft.id }))
    if (deletingActive) {
      await Promise.all([
        db.config.delete('apiBaseUrl'),
        db.config.delete('apiKey'),
        db.config.delete('apiModel')
      ])
      window._apiConfigCache = null
      var settingsPage = document.getElementById('settings-page')
      if (settingsPage && window.updateRowValues) await window.updateRowValues(settingsPage)
    }
    await renderList(page)
    window.toast(deletingActive ? '分组已删除，当前 API 已清空' : 'API 分组已删除')
  }

  function bindCard(page, card) {
    card.addEventListener('input', function(event) {
      if (event.target.matches('[data-field="title"], [data-model-input], [data-model-current]')) refreshSummary(card)
      if (event.target.matches('[data-field="url"], [data-model-input], [data-model-current]')) refreshProviderHint(card)
    })
    card.addEventListener('change', function(event) {
      if (event.target.matches('[data-model-current]')) {
        refreshSummary(card)
        refreshProviderHint(card)
      }
      if (event.target.matches('[data-fetched-model]') && event.target.value) {
        appendModelRow(card, event.target.value, true)
        event.target.value = ''
        refreshSummary(card)
        refreshProviderHint(card)
      }
    })
    card.addEventListener('click', function(event) {
      var action = event.target.closest('[data-action]')
      if (!action) return
      var name = action.getAttribute('data-action')
      if (name === 'toggle-key') {
        var key = card.querySelector('[data-field="key"]')
        var visible = key.type === 'text'
        key.type = visible ? 'password' : 'text'
        action.textContent = visible ? '显示' : '隐藏'
      } else if (name === 'add-model') {
        appendModelRow(card, '', false)
      } else if (name === 'remove-model') {
        var row = action.closest('[data-model-row]')
        if (row) row.remove()
        if (!card.querySelector('[data-model-row]')) appendModelRow(card, '', true)
        renumberRows(card)
        refreshSummary(card)
        refreshProviderHint(card)
      } else if (name === 'fetch-models') {
        fetchModels(card, action).catch(function(error) { window.toast('获取模型失败：' + (error.message || error)) })
      } else if (name === 'test') {
        testConnection(card, action)
      } else if (name === 'save') {
        saveFromCard(page, card, false).catch(function(error) { window.toast('保存失败：' + (error.message || error)) })
      } else if (name === 'use') {
        saveFromCard(page, card, true).catch(function(error) { window.toast('切换失败：' + (error.message || error)) })
      } else if (name === 'delete') {
        removeGroup(page, card).catch(function(error) { window.toast('删除失败：' + (error.message || error)) })
      }
    })
    refreshProviderHint(card)
  }

  async function renderList(page, openGroupId) {
    var list = page.querySelector('#api-group-list')
    if (!list) return
    var groups = await loadGroups(true)
    var activeApi = await loadActiveApi()
    list.innerHTML = groups.length
      ? groups.map(function(group) { return groupCard(group, activeApi, group.id === openGroupId) }).join('')
      : '<div class="api-group-empty">还没有 API 分组，点下方按钮添加。</div>'
    list.querySelectorAll('.api-config-group').forEach(function(card) { bindCard(page, card) })
  }

  async function initPage(page) {
    await renderList(page)
    if (window.initTemperaturePresetSection) window.initTemperaturePresetSection(page)
    page.querySelector('#btn-add-api-group').addEventListener('click', async function() {
      var list = page.querySelector('#api-group-list')
      var empty = list.querySelector('.api-group-empty')
      if (empty) empty.remove()
      var activeApi = await loadActiveApi()
      var group = normalizeGroup({ id: makeId(), title: '新 API', models: [], selectedModel: '' }, 0)
      var holder = document.createElement('div')
      holder.innerHTML = groupCard(group, activeApi, true)
      var card = holder.firstElementChild
      list.appendChild(card)
      bindCard(page, card)
      var titleInput = card.querySelector('[data-field="title"]')
      if (titleInput) { titleInput.focus(); titleInput.select() }
    })
  }

  function openConfigPage() {
    var html =
      '<div class="api-group-page">' +
        '<div class="api-group-intro">同一服务商的 Base URL 和 Key 只需保存一次，展开分组后可管理多个模型。</div>' +
        '<div class="api-group-list" id="api-group-list"></div>' +
        '<button class="btn-pill btn-full api-group-add" id="btn-add-api-group" type="button"><i class="fa fa-plus"></i> 新增 API 分组</button>' +
      '</div>' +
      '<div class="setting-section temperature-preset-section">' +
        '<div class="temperature-preset-header" id="btn-temperature-presets">' +
          '<span>温度预设</span><i class="fa fa-angle-down temperature-preset-chevron"></i>' +
        '</div>' +
        '<div class="temperature-preset-body" id="temperature-preset-body" style="display:none"></div>' +
      '</div>'
    var page = window.buildSubPage('sub-api-config', 'API 配置', html)
    window.openSubPage(page)
    initPage(page).catch(function(error) { window.toast('API 配置加载失败：' + (error.message || error)) })
  }

  async function applyGroupModel(groupId, model) {
    var groups = await loadGroups()
    var group = groups.find(function(item) { return item.id === groupId })
    if (!group) throw new Error('找不到这个 API 分组')
    var selected = String(model || '').trim()
    if (!selected || group.models.indexOf(selected) < 0) throw new Error('找不到这个模型')
    group.selectedModel = selected
    await persistGroups(groups)
    await setActive(group, selected)
    return group
  }

  window.WanWanApiGroups = {
    openConfigPage: openConfigPage,
    loadGroups: loadGroups,
    persistGroups: persistGroups,
    loadActiveApi: loadActiveApi,
    sameConnection: sameConnection,
    isActiveGroup: isActiveGroup,
    isActiveModel: isActiveModel,
    applyGroupModel: applyGroupModel,
    esc: esc
  }
})()
