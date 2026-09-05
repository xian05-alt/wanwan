// keepalive.js — 不占用系统「正在播放」的后台保活
// HTMLAudioElement 持续播放会让 iOS 常驻灵动岛/锁屏播放器。
// 这里改用 Worker + Wake Lock；非 iOS 浏览器再用极低电平 Web Audio。
(function () {
  'use strict'

  var KEEP_ALIVE_GAIN = 0.0001
  var KEEP_ALIVE_FREQ = 30
  var worker = null
  var audioContext = null
  var oscillator = null
  var gainNode = null
  var wakeLock = null
  var wanted = false
  var suspendedForMedia = false
  var retryListening = false

  function isIOS() {
    var ua = navigator.userAgent || ''
    if (/iPad|iPhone|iPod/.test(ua)) return true
    return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  }

  function startWorker() {
    if (worker || typeof Worker === 'undefined') return
    try {
      var code = "setInterval(function(){postMessage('ping')},5000)"
      var blob = new Blob([code], { type: 'application/javascript' })
      var blobUrl = URL.createObjectURL(blob)
      worker = new Worker(blobUrl)
      URL.revokeObjectURL(blobUrl)
      worker.onmessage = function () {
        try { window.dispatchEvent(new CustomEvent('wanwan-keepalive-tick')) } catch (_) {}
      }
    } catch (_) {
      worker = null
    }
  }

  async function requestWakeLock() {
    if (!wanted || document.visibilityState !== 'visible') return false
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return false
    if (wakeLock && !wakeLock.released) return true
    try {
      wakeLock = await navigator.wakeLock.request('screen')
      wakeLock.addEventListener('release', function () { wakeLock = null })
      return true
    } catch (_) {
      wakeLock = null
      return false
    }
  }

  function createAudioContext() {
    if (audioContext) return audioContext
    var AudioContextCtor = window.AudioContext || window.webkitAudioContext
    if (!AudioContextCtor) return null
    try {
      audioContext = new AudioContextCtor()
      return audioContext
    } catch (_) {
      audioContext = null
      return null
    }
  }

  async function startWebAudio() {
    if (!wanted || suspendedForMedia || isIOS()) return false
    var ctx = createAudioContext()
    if (!ctx) return false
    if (!oscillator) {
      try {
        oscillator = ctx.createOscillator()
        gainNode = ctx.createGain()
        oscillator.frequency.value = KEEP_ALIVE_FREQ
        gainNode.gain.value = KEEP_ALIVE_GAIN
        oscillator.connect(gainNode)
        gainNode.connect(ctx.destination)
        oscillator.start()
      } catch (_) {
        oscillator = null
        gainNode = null
        return false
      }
    }
    try { await ctx.resume() } catch (_) {}
    return ctx.state === 'running'
  }

  function addGestureRetry() {
    if (retryListening || isIOS() || suspendedForMedia) return
    retryListening = true
    document.addEventListener('pointerdown', resumeFromGesture, true)
    document.addEventListener('touchstart', resumeFromGesture, true)
    document.addEventListener('click', resumeFromGesture, true)
  }

  function removeGestureRetry() {
    if (!retryListening) return
    retryListening = false
    document.removeEventListener('pointerdown', resumeFromGesture, true)
    document.removeEventListener('touchstart', resumeFromGesture, true)
    document.removeEventListener('click', resumeFromGesture, true)
  }

  async function resumeFromGesture() {
    if (!wanted || suspendedForMedia) return
    requestWakeLock()
    if (await startWebAudio()) removeGestureRetry()
  }

  async function start() {
    wanted = true
    startWorker()
    requestWakeLock()
    var running = await startWebAudio()
    if (!running) addGestureRetry()
    return running
  }

  function stopWebAudio() {
    try { if (oscillator) oscillator.stop() } catch (_) {}
    try { if (oscillator) oscillator.disconnect() } catch (_) {}
    try { if (gainNode) gainNode.disconnect() } catch (_) {}
    oscillator = null
    gainNode = null
    var ctx = audioContext
    audioContext = null
    if (ctx) {
      try { ctx.close() } catch (_) {}
    }
  }

  function stop() {
    wanted = false
    suspendedForMedia = false
    removeGestureRetry()
    if (worker) {
      worker.terminate()
      worker = null
    }
    if (wakeLock) {
      try { wakeLock.release() } catch (_) {}
      wakeLock = null
    }
    stopWebAudio()
  }

  function suspendForMedia() {
    suspendedForMedia = true
    removeGestureRetry()
    if (audioContext) {
      try { audioContext.suspend() } catch (_) {}
    }
  }

  function resumeAfterMedia() {
    suspendedForMedia = false
    if (wanted) start()
  }

  function resume() {
    if (!wanted || suspendedForMedia) return
    start()
  }

  function getStatus() {
    return {
      wanted: wanted,
      worker: !!worker,
      wakeLock: !!wakeLock && !wakeLock.released,
      webAudio: !!oscillator && !!audioContext && audioContext.state === 'running',
      ios: isIOS()
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') resume()
  })

  window.WanWanKeepAlive = {
    start: start,
    stop: stop,
    resume: resume,
    resumeFromGesture: resumeFromGesture,
    suspendForMedia: suspendForMedia,
    resumeAfterMedia: resumeAfterMedia,
    getStatus: getStatus
  }
})()
