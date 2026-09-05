// main.js — 应用初始化与通用工具函数
// 依赖：db.js 必须先加载

// ===== 全局toast提示 =====
window.toast = function(msg, type) {
  var c = document.getElementById('toast-container')
  if (!c) {
    c = document.createElement('div')
    c.id = 'toast-container'
    document.body.appendChild(c)
  }
  var el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  c.appendChild(el)
  requestAnimationFrame(function() { el.classList.add('show') })
  setTimeout(function() {
    el.classList.remove('show')
    setTimeout(function() { el.remove() }, 200)
  }, 2200)
}

// ===== iOS检测 =====
var isIOSPWA = window.navigator.standalone === true
var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// ===== 异常安卓底部安全区兜底 =====
function setupAndroidBottomInset() {
  if (isIOS || !window.visualViewport) return
  var rafId = 0
  function update() {
    rafId = 0
    var vv = window.visualViewport
    var rawInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
    var inset = rawInset >= 8 && rawInset <= 80 ? Math.round(rawInset) : 0
    var root = document.documentElement
    root.style.setProperty('--android-bottom-inset', inset + 'px')
    root.classList.toggle('has-android-bottom-inset', inset > 0)
  }
  function scheduleUpdate() {
    if (rafId) return
    rafId = requestAnimationFrame(update)
  }
  update()
  window.addEventListener('resize', scheduleUpdate, { passive: true })
  window.addEventListener('orientationchange', scheduleUpdate, { passive: true })
  window.visualViewport.addEventListener('resize', scheduleUpdate, { passive: true })
  window.visualViewport.addEventListener('scroll', scheduleUpdate, { passive: true })
}
setupAndroidBottomInset()

// ===== 桌面/PWA 应用图标 =====
var APP_ICON_CONFIG_KEY = 'appIconSettings'
var APP_ICON_BRIDGE_KEY = 'wanwan_app_icon_settings'
var APP_ICON_PRESETS = {
  wanwan: { label: '默认', src: 'img/wanwan.png' },
  wanwan02: { label: '图标 02', src: 'img/wanwan02.png' },
  wanwan03: { label: '图标 03', src: 'img/wanwan03.png' }
}
var _wanwanManifestObjectUrl = ''
var _wanwanAppIconSettings = { type: 'preset', preset: 'wanwan' }

function normalizeWanWanAppIconSettings(value) {
  if (value && value.type === 'custom' &&
      typeof value.icon192 === 'string' && value.icon192.indexOf('data:image/png') === 0 &&
      typeof value.icon512 === 'string' && value.icon512.indexOf('data:image/png') === 0) {
    return { type: 'custom', icon192: value.icon192, icon512: value.icon512 }
  }
  var preset = value && APP_ICON_PRESETS[value.preset] ? value.preset : 'wanwan'
  return { type: 'preset', preset: preset }
}

function isWanWanAppIconSettings(value) {
  if (!value || typeof value !== 'object') return false
  if (value.type === 'preset') return !!APP_ICON_PRESETS[value.preset]
  return value.type === 'custom' &&
    typeof value.icon192 === 'string' && value.icon192.indexOf('data:image/png') === 0 &&
    typeof value.icon512 === 'string' && value.icon512.indexOf('data:image/png') === 0
}

function getWanWanAppIconSources(settings) {
  settings = normalizeWanWanAppIconSettings(settings)
  if (settings.type === 'custom') {
    return { icon192: settings.icon192, icon512: settings.icon512 }
  }
  var src = APP_ICON_PRESETS[settings.preset].src
  var absoluteSrc = new URL(src, document.baseURI).href
  return { icon192: absoluteSrc, icon512: absoluteSrc }
}

function updateWanWanHeadIcon(rel, id, href, type) {
  var link = document.getElementById(id) || document.querySelector('link[rel="' + rel + '"]')
  if (!link) {
    link = document.createElement('link')
    document.head.appendChild(link)
  }
  link.id = id
  link.rel = rel
  link.href = href
  if (type) link.type = type
  else link.removeAttribute('type')
}

// ===== 动态注入PWA manifest =====
function injectManifest(settings) {
  var icons = getWanWanAppIconSources(settings)
  var appRoot = new URL('./', document.baseURI).href
  var manifest = {
    id: appRoot,
    name: '弯弯',
    short_name: '弯弯',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    start_url: appRoot,
    scope: appRoot,
    description: '弯弯 - 你的专属应用',
    icons: [
      { src: icons.icon192, sizes: '192x192', type: 'image/png' },
      { src: icons.icon512, sizes: '512x512', type: 'image/png' }
    ]
  }
  var blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' })
  var nextUrl = URL.createObjectURL(blob)
  var link = document.getElementById('app-manifest') || document.querySelector('link[rel="manifest"]') || document.createElement('link')
  link.id = 'app-manifest'
  link.rel = 'manifest'
  link.href = nextUrl
  if (!link.parentNode) document.head.appendChild(link)
  if (_wanwanManifestObjectUrl) URL.revokeObjectURL(_wanwanManifestObjectUrl)
  _wanwanManifestObjectUrl = nextUrl
}

window.applyWanWanAppIcon = function(settings) {
  settings = normalizeWanWanAppIconSettings(settings)
  _wanwanAppIconSettings = settings
  var icons = getWanWanAppIconSources(settings)
  updateWanWanHeadIcon('icon', 'app-favicon', icons.icon192, 'image/png')
  updateWanWanHeadIcon('apple-touch-icon', 'app-apple-touch-icon', icons.icon512)
  injectManifest(settings)
  return settings
}

window.getWanWanAppIconSettings = function() {
  return normalizeWanWanAppIconSettings(_wanwanAppIconSettings)
}

window.saveWanWanAppIconSettings = async function(settings) {
  settings = normalizeWanWanAppIconSettings(settings)
  if (settings.type === 'preset' && settings.preset === 'wanwan') {
    await db.config.delete(APP_ICON_CONFIG_KEY)
  } else {
    await db.config.put({ key: APP_ICON_CONFIG_KEY, value: settings })
  }
  try {
    localStorage.setItem(APP_ICON_BRIDGE_KEY, JSON.stringify(settings))
  } catch (err) {
    console.warn('[弯弯] 保存登录页图标设置失败:', err)
  }
  return window.applyWanWanAppIcon(settings)
}

function readWanWanAppIconFile(file) {
  return new Promise(function(resolve, reject) {
    if (!file || !/^image\//i.test(file.type || '')) {
      reject(new Error('请选择有效的图片文件'))
      return
    }
    var reader = new FileReader()
    reader.onload = function() { resolve(String(reader.result || '')) }
    reader.onerror = function() { reject(new Error('图片读取失败')) }
    reader.readAsDataURL(file)
  })
}

function loadWanWanAppIconImage(source) {
  return new Promise(function(resolve, reject) {
    var image = new Image()
    var settled = false
    var timer = setTimeout(function() {
      if (settled) return
      settled = true
      image.src = ''
      reject(new Error('图片加载超时'))
    }, 15000)
    image.onload = function() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error('图片尺寸无效'))
        return
      }
      resolve(image)
    }
    image.onerror = function() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('图片无法加载'))
    }
    image.src = source
  })
}

function cropWanWanAppIconToPng(image, size) {
  var canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  var sourceSize = Math.min(image.naturalWidth, image.naturalHeight)
  var sourceX = Math.floor((image.naturalWidth - sourceSize) / 2)
  var sourceY = Math.floor((image.naturalHeight - sourceSize) / 2)
  var context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法处理图片')
  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size)
  return canvas.toDataURL('image/png')
}

window.saveWanWanCustomAppIconFile = async function(file) {
  var source = await readWanWanAppIconFile(file)
  var image = await loadWanWanAppIconImage(source)
  return await window.saveWanWanAppIconSettings({
    type: 'custom',
    icon192: cropWanWanAppIconToPng(image, 192),
    icon512: cropWanWanAppIconToPng(image, 512)
  })
}

async function loadWanWanAppIcon() {
  await waitForDB()
  var settings = null
  var bridgedSettings = null
  try {
    var bridgedValue = localStorage.getItem(APP_ICON_BRIDGE_KEY)
    if (bridgedValue) {
      var parsedBridge = JSON.parse(bridgedValue)
      if (isWanWanAppIconSettings(parsedBridge)) {
        bridgedSettings = normalizeWanWanAppIconSettings(parsedBridge)
      } else {
        localStorage.removeItem(APP_ICON_BRIDGE_KEY)
      }
    }
  } catch (err) {
    localStorage.removeItem(APP_ICON_BRIDGE_KEY)
    console.warn('[弯弯] 读取登录页图标设置失败:', err)
  }
  try {
    if (bridgedSettings) {
      settings = bridgedSettings
      if (settings.type === 'preset' && settings.preset === 'wanwan') {
        await db.config.delete(APP_ICON_CONFIG_KEY)
      } else {
        await db.config.put({ key: APP_ICON_CONFIG_KEY, value: settings })
      }
    } else {
      var cfg = window.db && db.config ? await db.config.get(APP_ICON_CONFIG_KEY) : null
      settings = cfg && cfg.value
      localStorage.setItem(APP_ICON_BRIDGE_KEY, JSON.stringify(normalizeWanWanAppIconSettings(settings)))
    }
  } catch (err) {
    console.warn('[弯弯] 读取桌面图标设置失败:', err)
  }
  window.applyWanWanAppIcon(settings)
}

// ===== PWA通知与Service Worker =====
var _wanwanServiceWorkerReady = null

function registerWanWanServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null)
  if (window.location.protocol === 'file:') return Promise.resolve(null)
  if (_wanwanServiceWorkerReady) return _wanwanServiceWorkerReady
  _wanwanServiceWorkerReady = navigator.serviceWorker.register('service.js')
    .then(function() { return navigator.serviceWorker.ready })
    .catch(function(err) {
      console.warn('[弯弯] Service Worker 注册失败:', err)
      return null
    })
  return _wanwanServiceWorkerReady
}

window.ensureWanWanNotificationPermission = async function() {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  var result = await Notification.requestPermission()
  return result === 'granted'
}

window.isWanWanNotificationEnabled = async function() {
  if (!('Notification' in window)) return false
  if (!window.db || !db.config) return Notification.permission === 'granted'
  try {
    var cfg = await db.config.get('notificationEnabled')
    if (cfg) return cfg.value === true
  } catch (err) {
    console.warn('[弯弯] 读取通知设置失败:', err)
  }
  return Notification.permission === 'granted'
}

window.sendWanWanNotification = async function(body, options) {
  var enabled = await window.isWanWanNotificationEnabled()
  if (!enabled) return false

  var granted = await window.ensureWanWanNotificationPermission()
  if (!granted) return false

  var opts = options || {}
  var title = opts.title || '弯弯'
  var dataUrl = window.location.href
  var notifOptions = Object.assign({
    body: body,
    icon: 'img/wanwan.png',
    badge: 'img/wanwan.png',
    tag: 'wanwan-test-' + Date.now(),
    data: { url: dataUrl }
  }, opts, {
    data: Object.assign({ url: dataUrl }, opts.data || {})
  })
  delete notifOptions.title

  var reg = await registerWanWanServiceWorker()
  if (reg && reg.showNotification) {
    await reg.showNotification(title, notifOptions)
  } else {
    new Notification(title, notifOptions)
  }
  return true
}

// ===== 等待DB就绪 =====
function waitForDB() {
  return new Promise(function(resolve) {
    if (window.db) return resolve()
    var elapsed = 0
    var t = setInterval(function() {
      elapsed += 50
      if (window.db || elapsed >= 8000) { clearInterval(t); resolve() }
    }, 50)
  })
}

// ===== 开屏Tap to Start逻辑 =====
var _splashReady = false
var _splashTapped = false
var _splashStarting = false
var _appStarted = false

function _onSplashReady() {
  _splashReady = true
  var tap = document.getElementById('splash-tap')
  if (tap) tap.classList.add('ready')
  if (_splashTapped) _handleSplashStart()
}

function _dismissSplash() {
  var loading = document.getElementById('loading')
  if (!loading) return
  loading.classList.add('hidden')
  setTimeout(function() { loading.remove() }, 700)
}

async function removeLegacyHostedServiceState() {
  ;[
    'wanwan_auth_qq',
    'wanwan_auth_session_token',
    'wanwan_auth_device_id',
    'wanwan_auth_api_base',
    'wanwan_char_import_device_code',
    'wanwan_char_import_unlocked_v1',
    'wanwan_builtin_ai_daily_quota_v1',
    'WANWAN_LINK_PARSE_API_BASE'
  ].forEach(function(key) { localStorage.removeItem(key) })

  if (window.db && db.config) {
    await db.config.bulkDelete([
      'apiMode',
      'builtinApiModel',
      'subApiBaseUrl',
      'subApiKey',
      'subApiModel'
    ])
  }
}

async function _handleSplashStart() {
  if (_splashStarting) return
  if (!_splashReady) { _splashTapped = true; return }
  _splashStarting = true
  var tap = document.getElementById('splash-tap')
  if (tap) tap.querySelector('span').textContent = 'Starting'
  _dismissSplash()
  await startWanWanApp()
}

// ===== 三阶段初始化 =====
async function phase1_restoreUI() {
  await loadDesktopIconCustomizations()
  await loadDesktopLabelColor()
  await loadDesktopWidgets()
  await loadDesktopLayout()
  if (window.loadWechatAppTheme) await window.loadWechatAppTheme()
  renderDesktop()
  if (window.loadPersonalization) await window.loadPersonalization()
}

async function phase2_loadData() {
  await loadCharacterCache()
  await renderTopWidget()
}

async function phase3_services() {
  if (window.loadAndApplySettings) await window.loadAndApplySettings()
  if (window.WanWanOnline) await window.WanWanOnline.init()
}

window.startWanWanApp = async function() {
  if (_appStarted) return
  _appStarted = true
  await phase1_restoreUI()
  await phase2_loadData()
  await phase3_services()
  if (window.WanWanMCP && window.WanWanMCP.resumePendingOAuthResult) {
    await window.WanWanMCP.resumePendingOAuthResult()
  }
  if (window.showDisclaimerIfNeeded) await window.showDisclaimerIfNeeded()
}

// ===== 主入口 =====
document.addEventListener('DOMContentLoaded', async function() {
  await loadWanWanAppIcon()
  registerWanWanServiceWorker()

  // 绑定开屏点击
  var loading = document.getElementById('loading')
  if (loading) {
    loading.addEventListener('click', function() {
      if (_splashReady) _handleSplashStart()
      else _splashTapped = true
    })
  }

  try {
    await waitForDB()
    await removeLegacyHostedServiceState()
    if (window.WanWanMCP && window.WanWanMCP.handleOAuthCallback) {
      await window.WanWanMCP.handleOAuthCallback()
    }
  } catch(e) {
    console.error('[弯弯] 初始化失败:', e)
  } finally {
    _onSplashReady()
  }

  // ===== 回前台后恢复后台保活 =====
  document.addEventListener('visibilitychange', async function() {
    if (document.visibilityState !== 'visible') return
    if (window._avgBgmActive) return
    var cfg = await db.config.get('keepAliveEnabled')
    if (!cfg || !cfg.value) return
    if (window.WanWanKeepAlive) window.WanWanKeepAlive.resume()
  })
})

function escapeMainHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function(ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  })
}

// ===== 首次使用免责声明 =====
var DISCLAIMER_STORAGE_KEY = 'wanwan_disclaimer_confirmed_version'
var DISCLAIMER_CONFIRM_DELAY = 10
var DISCLAIMER_CONTENT = {
  title: '免责声明',
  sections: [
    {
      title: '1. 内容生成方式',
      content: '弯弯机内所有对话、动态、图片描述等内容均由第三方 AI 大语言模型「用户自行配制」生成，作者无法审核或者干预，同时不对生成内容承担任何责任。'
    },
    {
      title: '2. 虚构性声明',
      content: '弯弯机中的角色、情节均为 AI 生成的虚构内容，不代表作者立场。用户需要自行判断内容的适用性。'
    },
    {
      title: '3. 数据存储',
      content: '弯弯机的业务数据保存在本地设备或用户自行搭建的同步后端中，请自行做好备份。'
    },
    {
      title: '4. 年龄限制',
      content: '弯弯机仅限成年人使用。使用即代表您已年满18周岁，未成年人请勿使用。'
    },
    {
      title: '5. 责任限制',
      content: '弯弯机旨在为用户提供陪伴与愉悦体验。因不当使用本应用产生的任何后果，均由用户自行承担，作者不承担任何法律责任。'
    },
    {
      title: '6. 个人声明',
      content: '弯弯机为个人开发项目，作者保留随时修改、暂停或终止服务的权利，使用即代表接受以上条款。'
    }
  ],
  closing: '继续使用本网页即视为您已阅读、理解并同意本免责声明的全部内容。',
  credit: '作者：月酱 ｜ 特别鸣谢：小厌厌'
}
var _activeDisclaimerPromise = null

function getDisclaimerVersion() {
  var source = JSON.stringify(DISCLAIMER_CONTENT)
  var hash = 0
  for (var i = 0; i < source.length; i++) {
    hash = ((hash << 5) - hash) + source.charCodeAt(i)
    hash |= 0
  }
  return 'disclaimer_' + Math.abs(hash).toString(36)
}

function shouldShowDisclaimer() {
  try {
    return localStorage.getItem(DISCLAIMER_STORAGE_KEY) !== getDisclaimerVersion()
  } catch (e) {
    return true
  }
}

function confirmDisclaimer() {
  try {
    localStorage.setItem(DISCLAIMER_STORAGE_KEY, getDisclaimerVersion())
  } catch (e) {}
}

function buildDisclaimerHTML(mode) {
  var sections = DISCLAIMER_CONTENT.sections.map(function(section) {
    return '' +
      '<section class="disclaimer-section">' +
        '<h3>' + escapeMainHtml(section.title) + '</h3>' +
        '<p>' + escapeMainHtml(section.content) + '</p>' +
      '</section>'
  }).join('')
  var required = mode === 'required'
  var buttonText = required ? '请等待 ' + DISCLAIMER_CONFIRM_DELAY + 's' : '关闭'

  return '' +
    '<div class="disclaimer-overlay" id="disclaimer-overlay">' +
      '<div class="disclaimer-modal" role="dialog" aria-modal="true" aria-labelledby="disclaimer-title">' +
        '<div class="disclaimer-header">' +
          '<h2 id="disclaimer-title">' + escapeMainHtml(DISCLAIMER_CONTENT.title) + '</h2>' +
          '<p>' + (required ? '请完整阅读以下内容后确认' : '弯弯机使用说明与责任声明') + '</p>' +
        '</div>' +
        '<div class="disclaimer-body">' +
          sections +
          '<p class="disclaimer-closing">' + escapeMainHtml(DISCLAIMER_CONTENT.closing) + '</p>' +
          '<p class="disclaimer-credit">' + escapeMainHtml(DISCLAIMER_CONTENT.credit) + '</p>' +
        '</div>' +
        '<div class="disclaimer-footer">' +
          '<button class="disclaimer-confirm" id="disclaimer-confirm" type="button"' + (required ? ' disabled' : '') + '>' +
            '<span>' + buttonText + '</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>'
}

window.showDisclaimer = function(options) {
  options = options || {}
  var mode = options.mode === 'required' ? 'required' : 'view'
  if (_activeDisclaimerPromise) return _activeDisclaimerPromise

  _activeDisclaimerPromise = new Promise(function(resolve) {
    document.body.insertAdjacentHTML('beforeend', buildDisclaimerHTML(mode))
    var overlay = document.getElementById('disclaimer-overlay')
    var btn = document.getElementById('disclaimer-confirm')
    var label = btn && btn.querySelector('span')
    if (!overlay || !btn || !label) {
      _activeDisclaimerPromise = null
      resolve()
      return
    }

    requestAnimationFrame(function() {
      overlay.classList.add('show')
    })

    var timer = null
    if (mode === 'required') {
      var remaining = DISCLAIMER_CONFIRM_DELAY
      timer = setInterval(function() {
        remaining -= 1
        if (remaining > 0) {
          label.textContent = '请等待 ' + remaining + 's'
          return
        }
        clearInterval(timer)
        timer = null
        btn.disabled = false
        label.textContent = '同意'
      }, 1000)
    }

    var close = function() {
      if (btn.disabled) return
      if (timer) clearInterval(timer)
      if (mode === 'required') confirmDisclaimer()
      btn.disabled = true
      overlay.classList.remove('show')
      setTimeout(function() {
        overlay.remove()
        _activeDisclaimerPromise = null
        resolve()
      }, 220)
    }
    btn.addEventListener('click', close)
  })

  return _activeDisclaimerPromise
}

window.showDisclaimerIfNeeded = function() {
  if (!shouldShowDisclaimer()) return Promise.resolve()
  return window.showDisclaimer({ mode: 'required' })
}

// ===== 角色内存缓存 =====
window._charCache = {}

async function loadCharacterCache() {
  var chars = await db.characters.toArray()
  window._charCache = {}
  chars.forEach(function(c) { window._charCache[c.id] = c })
}

// 从缓存获取角色（找不到时回退到DB）
window.getCharacter = async function(id) {
  if (window._charCache[id]) return window._charCache[id]
  var char = await db.characters.get(id)
  if (char) window._charCache[id] = char
  return char
}

// 刷新单个角色缓存
window.refreshCharCache = async function(id) {
  var char = await db.characters.get(id)
  if (char) window._charCache[id] = char
  else delete window._charCache[id]
}

// ===== 关闭全屏页面 =====
window.closePage = function(pageId) {
  var page = document.getElementById(pageId)
  if (page) {
    page.classList.add('is-closing')
    page.style.pointerEvents = 'none'
    page.style.overflow = 'hidden'
    page.style.transform = 'translateY(100%)'
    var done = false
    var cleanup = function() {
      if (done) return
      done = true
      page.removeEventListener('transitionend', cleanup)
      page.remove()
    }
    page.addEventListener('transitionend', cleanup)
    setTimeout(cleanup, 350)
  }
}

// ===== 打开全屏页面 =====
window.openPage = function(pageEl) {
  pageEl.classList.add('is-opening')
  pageEl.style.transform = 'translateY(100%)'
  document.getElementById('app').appendChild(pageEl)
  requestAnimationFrame(function() {
    pageEl.style.transition = 'transform 0.3s var(--ease)'
    pageEl.style.transform = 'translateY(0)'
    var cleanup = function() {
      pageEl.classList.remove('is-opening')
      pageEl.removeEventListener('transitionend', cleanup)
    }
    pageEl.addEventListener('transitionend', cleanup)
    setTimeout(cleanup, 350)
  })
}

// ===== 通用图片选择弹窗 =====
window.showImagePicker = function(callback) {
  var overlay = document.createElement('div')
  overlay.className = 'img-picker-overlay'
  var modal = document.createElement('div')
  modal.className = 'img-picker-modal'
  modal.innerHTML =
    '<div class="img-picker-title">选择图片</div>' +
    '<div class="img-picker-options">' +
      '<button class="img-picker-btn" id="img-pick-local">' +
        '<i class="fa fa-folder-open"></i><span>本地文件</span>' +
      '</button>' +
      '<button class="img-picker-btn" id="img-pick-url">' +
        '<i class="fa fa-link"></i><span>输入URL</span>' +
      '</button>' +
    '</div>' +
    '<div class="img-picker-url-area" id="img-picker-url-area" style="display:none">' +
      '<input class="input-field" id="img-picker-url-input" placeholder="粘贴图片URL...">' +
      '<button class="btn-pill img-picker-confirm" id="img-picker-url-confirm">确认</button>' +
    '</div>' +
    '<input type="file" id="img-picker-file" accept="image/*" style="display:none">' +
    '<button class="img-picker-cancel" id="img-picker-cancel">取消</button>'
  document.getElementById('app').appendChild(overlay)
  document.getElementById('app').appendChild(modal)
  requestAnimationFrame(function() {
    overlay.classList.add('show')
    modal.classList.add('show')
  })
  bindImagePickerEvents(overlay, modal, callback)
}

// ===== 图片选择弹窗事件绑定 =====
function bindImagePickerEvents(overlay, modal, callback) {
  var close = function() {
    overlay.classList.remove('show')
    modal.classList.remove('show')
    setTimeout(function() { overlay.remove(); modal.remove() }, 200)
  }
  overlay.addEventListener('click', close)
  modal.querySelector('#img-picker-cancel').addEventListener('click', close)

  // 本地文件选择
  var fileInput = modal.querySelector('#img-picker-file')
  modal.querySelector('#img-pick-local').addEventListener('click', function() {
    fileInput.click()
  })
  fileInput.addEventListener('change', function(e) {
    var file = e.target.files[0]
    if (!file) return
    var reader = new FileReader()
    reader.onload = function(ev) { close(); callback(ev.target.result) }
    reader.readAsDataURL(file)
  })

  // URL输入
  modal.querySelector('#img-pick-url').addEventListener('click', function() {
    modal.querySelector('#img-picker-url-area').style.display = 'flex'
    modal.querySelector('#img-picker-url-input').focus()
  })
  modal.querySelector('#img-picker-url-confirm').addEventListener('click', function() {
    var url = modal.querySelector('#img-picker-url-input').value.trim()
    if (!url) { window.toast('请输入图片URL'); return }
    close()
    callback(url)
  })
}
