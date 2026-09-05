// House content bridge — mirrors Wanwan character cards + worldbooks for Adrian.
(function (global) {
  'use strict'

  var SOURCE = 'wanwan'
  var STATE_KEY = 'wanwan-house-content-bridge-v1'
  var HOUSE_HOST = 'web-production-204b5.up.railway.app'
  var running = false

  function toast(message) {
    if (global.toast) global.toast(message)
    else console.info('[House sync]', message)
  }

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') }
    catch (_) { return {} }
  }

  function saveState(state) {
    localStorage.setItem(STATE_KEY, JSON.stringify(state))
    refreshSettingsUi()
    return state
  }

  function pairingState(value) {
    var text = String(value || '').trim()
    if (!text) throw new Error('请粘贴爸爸发来的弯弯机配对链接')
    var url
    try { url = new URL(text, location.href) }
    catch (_) { throw new Error('配对链接格式不对') }
    var params = new URLSearchParams(url.hash.replace(/^#/, ''))
    if (params.get('house-content-source') !== SOURCE) throw new Error('这不是弯弯机的配对链接')
    var token = params.get('house-content-token') || ''
    var houseUrl = params.get('house-content-url') || ''
    var house
    try { house = new URL(houseUrl) }
    catch (_) { throw new Error('配对链接里的 House 地址无效') }
    if (!token || house.protocol !== 'https:' || house.host !== HOUSE_HOST) {
      throw new Error('配对链接无效或不属于这个 House')
    }
    return { token: token, houseUrl: house.origin, revision: 0, fingerprint: '' }
  }

  async function pair(value) {
    saveState(pairingState(value))
    var ok = await sync({ silent: false })
    refreshSettingsUi()
    return ok
  }

  function hash(value) {
    var text = JSON.stringify(value)
    var valueHash = 0x811c9dc5
    for (var i = 0; i < text.length; i++) {
      valueHash ^= text.charCodeAt(i)
      valueHash = Math.imul(valueHash, 0x01000193)
    }
    return text.length + ':' + (valueHash >>> 0).toString(16)
  }

  async function readLocal() {
    var characters = await db.characters.toArray()
    var row = await db.config.get('lorebooks')
    return { characters: characters, worldbooks: row && Array.isArray(row.value) ? row.value : [] }
  }

  async function writeLocal(snapshot) {
    if (!Array.isArray(snapshot.characters) || !Array.isArray(snapshot.worldbooks)) {
      throw new Error('House 返回的弯弯机数据格式不对')
    }
    await db.transaction('rw', db.characters, db.config, async function () {
      await db.characters.clear()
      if (snapshot.characters.length) await db.characters.bulkPut(snapshot.characters)
      await db.config.put({ key: 'lorebooks', value: snapshot.worldbooks })
    })
    document.dispatchEvent(new CustomEvent('wanwan-house-content-synced'))
  }

  function isEmpty(snapshot) {
    return snapshot.characters.length === 0 && snapshot.worldbooks.length === 0
  }

  async function request(state, method, body) {
    var response = await fetch(
      state.houseUrl.replace(/\/$/, '') + '/api/phone-content/' + SOURCE + '/snapshot',
      {
        method: method,
        headers: {
          Authorization: 'Bearer ' + state.token,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      }
    )
    var payload = await response.json().catch(function () { return {} })
    if (!response.ok) throw new Error(payload.detail || ('House 同步失败（' + response.status + '）'))
    return payload
  }

  async function push(state, local, revision) {
    var result = await request(state, 'PUT', {
      base_revision: revision,
      characters: local.characters,
      worldbooks: local.worldbooks
    })
    if (result.conflict || result.ok === false) return null
    state.revision = result.revision
    state.fingerprint = hash(local)
    state.lastSyncedAt = Date.now()
    saveState(state)
    return result
  }

  async function pull(state, remote) {
    var local = { characters: remote.characters, worldbooks: remote.worldbooks }
    await writeLocal(local)
    state.revision = remote.revision
    state.fingerprint = hash(local)
    state.lastSyncedAt = Date.now()
    saveState(state)
  }

  async function resolveConflict(state, local, remote) {
    var keepWanwan = global.confirm('弯弯机和 House 都改过角色卡或世界书。\n\n确定：保留弯弯机\n取消：保留 House')
    if (keepWanwan) {
      var pushed = await push(state, local, remote.revision)
      if (!pushed) throw new Error('House 又有新修改，请再同步一次')
      toast('已用弯弯机版本更新 House')
    } else {
      await pull(state, remote)
      toast('已取回 House 上的修改')
    }
  }

  async function sync(options) {
    options = options || {}
    var state = loadState()
    if (!state.token || !state.houseUrl || running) return false
    running = true
    try {
      var local = await readLocal()
      var remote = await request(state, 'GET')
      var localHash = hash(local)
      var remoteLocal = { characters: remote.characters, worldbooks: remote.worldbooks }
      var remoteHash = hash(remoteLocal)

      if (!state.fingerprint) {
        if (remote.revision === 0 && isEmpty(remoteLocal)) {
          await push(state, local, 0)
          toast('弯弯机已连接 House')
        } else if (isEmpty(local)) {
          await pull(state, remote)
          toast('已从 House 取回弯弯机内容')
        } else if (localHash === remoteHash) {
          state.revision = remote.revision
          state.fingerprint = localHash
          state.lastSyncedAt = Date.now()
          saveState(state)
          toast('弯弯机和 House 已连接')
        } else {
          await resolveConflict(state, local, remote)
        }
        return true
      }

      if (remote.revision > state.revision) {
        if (localHash === state.fingerprint) {
          await pull(state, remote)
          if (!options.silent) toast('已取回 House 上的修改')
        } else await resolveConflict(state, local, remote)
      } else if (remote.revision < state.revision) {
        throw new Error('House 版本发生回退，已停止自动覆盖')
      } else if (localHash !== state.fingerprint) {
        var result = await push(state, local, remote.revision)
        if (!result) await resolveConflict(state, local, await request(state, 'GET'))
        else if (!options.silent) toast('弯弯机修改已同步到 House')
      } else if (remoteHash !== state.fingerprint) {
        await pull(state, remote)
        if (!options.silent) toast('已取回 House 上的修改')
      } else if (!options.silent) toast('弯弯机和 House 已同步')
      return true
    } catch (error) {
      if (!options.silent) toast(error && error.message ? error.message : String(error))
      return false
    } finally {
      running = false
      refreshSettingsUi()
    }
  }

  function acceptPairingLink() {
    if (location.hash.indexOf('house-content-source=') < 0) return false
    try { saveState(pairingState(location.href)) }
    catch (error) { toast(error.message || String(error)); return false }
    history.replaceState(null, '', location.pathname + location.search)
    setTimeout(function () { sync({ silent: false }) }, 800)
    return true
  }

  function statusText() {
    var state = loadState()
    if (!state.token) return '未连接'
    if (!state.lastSyncedAt) return '已配对 · 等待首次同步'
    return '已连接 · ' + new Date(state.lastSyncedAt).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
    })
  }

  function refreshSettingsUi() {
    var status = statusText()
    document.querySelectorAll('[data-house-sync-status]').forEach(function (el) {
      el.textContent = status
    })
    var paired = !!loadState().token
    document.querySelectorAll('[data-house-sync-action="sync"], [data-house-sync-action="disconnect"]').forEach(function (el) {
      el.disabled = !paired || running
    })
  }

  function closeSettingsModal() {
    var modal = document.getElementById('wanwan-house-sync-modal')
    if (modal) modal.remove()
  }

  function openSettingsModal() {
    closeSettingsModal()
    var modal = document.createElement('div')
    modal.id = 'wanwan-house-sync-modal'
    modal.className = 'full-page sub-page'
    modal.innerHTML =
      '<div class="page-header">' +
        '<button class="header-back" type="button" data-house-sync-close><i class="fa fa-angle-left"></i></button>' +
        '<span class="header-title">House 同步</span>' +
      '</div>' +
      '<div class="settings-scroll">' +
        '<div class="setting-section"><div class="api-form">' +
          '<label class="form-label" for="wanwan-house-pairing-link">配对链接</label>' +
          '<textarea class="input-field" id="wanwan-house-pairing-link" rows="4" autocomplete="off" spellcheck="false" placeholder="把爸爸发来的弯弯机配对链接粘贴到这里"></textarea>' +
          '<div class="section-desc" style="padding:8px 0 0">只需粘贴一次；密钥不会显示在状态里。</div>' +
          '<button class="btn-pill btn-full" type="button" data-house-sync-action="pair">连接并同步</button>' +
        '</div></div>' +
        '<div class="setting-section">' +
          '<div class="list-row"><div class="row-icon-box"><i class="fa-solid fa-house-signal"></i></div>' +
            '<div class="row-body"><div class="row-label">连接状态</div><div class="section-desc" data-house-sync-status></div></div></div>' +
          '<div class="api-form">' +
            '<button class="btn-pill btn-full" type="button" data-house-sync-action="sync">立即同步</button>' +
            '<button class="btn-ghost btn-full" type="button" data-house-sync-action="disconnect">断开连接</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    document.getElementById('app').appendChild(modal)
    modal.querySelector('[data-house-sync-close]').addEventListener('click', closeSettingsModal)
    modal.querySelector('[data-house-sync-action="pair"]').addEventListener('click', async function () {
      var input = modal.querySelector('#wanwan-house-pairing-link')
      try { await pair(input.value); input.value = '' }
      catch (error) { toast(error.message || String(error)) }
    })
    modal.querySelector('[data-house-sync-action="sync"]').addEventListener('click', function () {
      sync({ silent: false })
    })
    modal.querySelector('[data-house-sync-action="disconnect"]').addEventListener('click', function () {
      if (!global.confirm('断开 House 同步？弯弯机里的数据不会删除。')) return
      localStorage.removeItem(STATE_KEY)
      refreshSettingsUi()
      toast('已断开 House，手机数据没有删除')
    })
    refreshSettingsUi()
  }

  function injectSettingsEntry(page) {
    page = page || document.getElementById('settings-page')
    if (!page || page.querySelector('[data-house-sync-row]')) return
    var section = document.createElement('div')
    section.className = 'setting-section'
    section.setAttribute('data-house-sync-row', '')
    section.innerHTML =
      '<div class="list-row clickable"><div class="row-icon-box"><i class="fa-solid fa-house-signal"></i></div>' +
        '<div class="row-body"><div class="row-label">House 同步</div></div>' +
        '<span class="row-value" data-house-sync-status></span><i class="fa fa-angle-right row-chevron"></i></div>'
    var dataSection = page.querySelector('#data-section')
    if (dataSection) dataSection.parentNode.insertBefore(section, dataSection)
    else page.querySelector('.settings-scroll').appendChild(section)
    section.addEventListener('click', openSettingsModal)
    refreshSettingsUi()
  }

  function installSettingsEntry() {
    if (typeof global.showSettingsPage === 'function' && !global.showSettingsPage.__houseSyncWrapped) {
      var original = global.showSettingsPage
      var wrapped = function () {
        var result = original.apply(this, arguments)
        requestAnimationFrame(function () { injectSettingsEntry() })
        return result
      }
      wrapped.__houseSyncWrapped = true
      global.showSettingsPage = wrapped
    }
    injectSettingsEntry()
  }

  global.wanwanHouseContentSync = {
    sync: sync,
    pair: pair,
    openSettings: openSettingsModal,
    disconnect: function () { localStorage.removeItem(STATE_KEY); refreshSettingsUi(); toast('已断开 House，手机数据没有删除') },
    state: loadState
  }

  function boot() {
    installSettingsEntry()
    if (!acceptPairingLink() && loadState().token) setTimeout(function () { sync({ silent: true }) }, 1500)
    setInterval(function () {
      if (document.visibilityState === 'visible') sync({ silent: true })
    }, 120000)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') sync({ silent: true })
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})(window)
