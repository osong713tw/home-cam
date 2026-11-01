'use strict';
/* 監看端：自動尋找房間內所有鏡頭、通過密鑰驗證後接收影像，並在本機做移動偵測 */
(async function () {
  const C = window.IPCam;
  const $ = C.$;
  const store = C.store;

  const el = {
    status: $('#status'), statusText: $('#statusText'), dot: $('#status .dot'), grid: $('#grid'),
    empty: $('#empty'), emptyText: $('#emptyText'), startOverlay: $('#startOverlay'), noKey: $('#noKey'),
    hasKey: $('#hasKey'), btnStart: $('#btnStart'), startError: $('#startError'),
    btnSound: $('#btnSound'), btnMotion: $('#btnMotion'), btnLog: $('#btnLog'), logBadge: $('#logBadge'),
    btnShare: $('#btnShare'), motionModal: $('#motionModal'), chkMotion: $('#chkMotion'), chkSound: $('#chkSound'),
    rngSens: $('#rngSens'), sensVal: $('#sensVal'), btnTestBeep: $('#btnTestBeep'), logModal: $('#logModal'),
    logList: $('#logList'), btnClearLog: $('#btnClearLog'), shareModal: $('#shareModal'), qrBox: $('#qrBox'),
  };

  function showStartError(msg) {
    el.startError.textContent = msg;
    el.startError.classList.remove('hidden');
  }

  // ---- 房間密鑰：網址 > 已儲存 ----
  const hashKey = C.readHashKey();
  const savedKey = store.get('view.key', null);
  const key = hashKey || (C.isValidKey(savedKey) ? savedKey : null);
  if (!key) {
    el.hasKey.classList.add('hidden');
    el.noKey.classList.remove('hidden');
    return;
  }
  const problem = C.envProblem(false);
  if (problem) {
    el.btnStart.disabled = true;
    showStartError(problem);
    return;
  }
  store.set('view.key', key);
  C.setHashKey(key);
  const room = await C.roomIdFromKey(key);

  // ---- 設定 ----
  const settings = {
    motion: store.get('view.motion', true) !== false,
    sound: store.get('view.sound', true) !== false,
    sens: Math.min(10, Math.max(1, parseInt(store.get('view.sens', 5), 10) || 5)),
  };
  function saveSettings() {
    store.set('view.motion', settings.motion);
    store.set('view.sound', settings.sound);
    store.set('view.sens', settings.sens);
  }
  function renderSettings() {
    el.chkMotion.checked = settings.motion;
    el.chkSound.checked = settings.sound;
    el.rngSens.value = settings.sens;
    el.sensVal.textContent = settings.sens;
    el.btnSound.textContent = settings.sound ? '🔔' : '🔕';
    el.btnSound.classList.toggle('off', !settings.sound);
    el.btnMotion.classList.toggle('off', !settings.motion);
  }
  renderSettings();

  // ---- 鏡頭位置 ----
  const slots = [];
  for (let n = 1; n <= C.MAX_CAMS; n++) {
    slots.push({
      n, id: C.camPeerId(room, n), state: 'idle', gen: 0, conn: null, call: null, peerId: null,
      authSent: false, lastSeen: 0, deadline: 0, nextProbe: Date.now() + n * 200, info: null,
      everSeen: false, tile: null, audioOn: false, discTimer: null,
      motion: { prev: null, prevMean: 0, hits: 0, suppressUntil: 0, until: 0, lastAlert: 0 },
    });
  }
  const slotById = (id) => slots.find((s) => s.id === id);
  // 已知的鏡頭與「下一個空位」較常探測，其餘空位放慢，減少對公用配對伺服器的請求
  function probeDelay(s) {
    const highest = slots.reduce((m, x) => ((x.everSeen || x.state !== 'idle') ? Math.max(m, x.n) : m), 0);
    return (s.everSeen || s.n <= highest + 1) ? 4000 : 10000;
  }

  let peer = null;
  let started = false;
  let recoverTimer = null;
  let backoff = 0;
  let connectingSince = 0;
  let deniedShown = false;

  // ---- 狀態 ----
  function updateStatus() {
    const live = slots.filter((s) => s.state === 'live').length;
    let kind = 'wait';
    let text = '連線中…';
    if (peer && peer.open) {
      kind = live ? 'ok' : 'wait';
      text = live ? `${live} 支鏡頭在線` : '已連線，等待鏡頭';
    } else if (peer && peer.__everOpened) {
      text = live ? `重新連線中（${live} 支鏡頭仍在線）` : '重新連線中…';
    }
    el.dot.className = 'dot ' + kind;
    el.statusText.textContent = text;
    const tiles = slots.filter((s) => s.tile).length;
    el.empty.classList.toggle('hidden', tiles > 0);
    el.grid.dataset.count = String(tiles);
  }

  // ---- 配對伺服器連線 ----
  function createPeer() {
    const p = new window.Peer(C.peerOptions());
    peer = p;
    p.__fails = 0;
    connectingSince = Date.now();
    p.on('open', () => {
      if (peer !== p || p.__dead) return;
      p.__everOpened = true;
      p.__fails = 0;
      backoff = 0;
      updateStatus();
    });
    p.on('call', (call) => onCall(p, call));
    p.on('connection', (conn) => { try { conn.close(); } catch (e) { /* 監看端不接受連入 */ } });
    p.on('disconnected', () => {
      if (peer !== p || p.__dead) return;
      updateStatus();
      scheduleRecover();
    });
    p.on('error', (err) => {
      if (p.__dead) return;
      const t = err && err.type;
      if (t === 'peer-unavailable') {
        // 這個鏡頭位置目前沒有鏡頭
        const m = /peer (\S+)$/.exec((err && err.message) || '');
        const s = m && slotById(m[1]);
        if (s && s.state === 'connecting') resetSlot(s, probeDelay(s));
        return;
      }
      if (t === 'webrtc' || peer !== p) return;
      if (['browser-incompatible', 'invalid-key', 'ssl-unavailable'].includes(t)) {
        el.statusText.textContent = '錯誤：' + (err.message || t);
        el.dot.className = 'dot err';
        return;
      }
      updateStatus();
      scheduleRecover();
    });
  }

  // 停用舊的連線物件；若還有畫面透過它播放就先保留，等那些畫面結束再關閉
  const retired = new Map();
  function retirePeer(p) {
    p.__dead = true;
    const inUse = p.id && slots.some((s) => s.peerId === p.id && s.state !== 'idle');
    if (inUse) retired.set(p.id, p);
    else { try { p.destroy(); } catch (e) { /* ignore */ } }
  }
  function releaseRetired(id) {
    const p = retired.get(id);
    if (!p || slots.some((s) => s.peerId === id && s.state !== 'idle')) return;
    retired.delete(id);
    try { p.destroy(); } catch (e) { /* ignore */ }
  }

  function scheduleRecover(immediate) {
    if (recoverTimer) {
      if (!immediate) return;
      clearTimeout(recoverTimer);
    }
    const delay = immediate ? 300 : Math.min(30000, 2000 * Math.pow(1.6, backoff++));
    recoverTimer = setTimeout(() => {
      recoverTimer = null;
      const p = peer;
      if (!p || p.open) return;
      if (p.destroyed || !p.__everOpened || p.__fails >= 3) {
        retirePeer(p);
        createPeer();
        return;
      }
      if (p.disconnected) {
        p.__fails++;
        try { connectingSince = Date.now(); p.reconnect(); } catch (e) { scheduleRecover(); }
      }
    }, delay);
  }

  window.addEventListener('online', () => { backoff = 0; scheduleRecover(true); });

  // ---- 連到各鏡頭 ----
  function connectSlot(s) {
    const gen = ++s.gen;
    s.state = 'connecting';
    s.authSent = false;
    s.deadline = Date.now() + 10000;
    s.peerId = peer.id;
    let conn = null;
    try { conn = peer.connect(s.id, { serialization: 'json', reliable: true }); } catch (e) { conn = null; }
    if (!conn) { resetSlot(s, 5000); return; }
    s.conn = conn;
    conn.on('data', (msg) => { if (s.gen === gen) onCamData(s, gen, msg); });
    conn.on('close', () => { if (s.gen === gen) resetSlot(s, 2000); });
    conn.on('error', () => { if (s.gen === gen) resetSlot(s, 3000); });
  }

  function send(s, msg) {
    try { if (s.conn && s.conn.open) s.conn.send(msg); } catch (e) { /* ignore */ }
  }

  async function onCamData(s, gen, msg) {
    if (!msg || typeof msg !== 'object') return;
    s.lastSeen = Date.now();
    switch (msg.t) {
      case 'challenge': {
        if (typeof msg.nonce !== 'string' || msg.nonce.length > 64) return;
        const mac = await C.hmacHex(key, msg.nonce + '|' + s.peerId + '|' + room);
        if (s.gen !== gen) return;
        send(s, { t: 'auth', mac });
        s.authSent = true;
        break;
      }
      case 'ok':
        if (s.state === 'connecting') {
          s.state = 'authed';
          s.deadline = Date.now() + 15000;
        }
        setInfo(s, msg.info);
        break;
      case 'info':
        setInfo(s, msg.info);
        if (msg.reset) resetMotion(s);
        break;
      case 'denied':
        if (!deniedShown) { deniedShown = true; C.toast('密鑰不正確，請重新掃描鏡頭上的 QR Code', 6000); }
        resetSlot(s, 60000);
        break;
      case 'full':
        C.toast(`位置 ${s.n} 的鏡頭觀看人數已滿（最多 ${C.MAX_VIEWERS} 台）`, 4000);
        resetSlot(s, 20000);
        break;
      default:
        break; // ping
    }
  }

  function onCall(p, call) {
    const s = slotById(call.peer);
    // 只接受「我們已送出驗證」的鏡頭位置打來的影像
    if (p.__dead || !s || s.state === 'idle' || !s.authSent || s.peerId !== p.id) {
      try { call.close(); } catch (e) { /* ignore */ }
      return;
    }
    const gen = s.gen;
    if (s.call && s.call !== call) { try { s.call.close(); } catch (e) { /* ignore */ } }
    s.call = call;
    if (s.state === 'connecting') { s.state = 'authed'; s.deadline = Date.now() + 15000; }
    call.on('stream', (stream) => {
      if (s.gen !== gen) return;
      s.state = 'live';
      s.everSeen = true;
      s.lastSeen = Date.now();
      attachStream(s, stream);
      updateStatus();
    });
    call.on('close', () => { if (s.gen === gen) resetSlot(s, 1500); });
    call.on('error', () => { if (s.gen === gen) resetSlot(s, 3000); });
    call.on('iceStateChanged', (st) => {
      if (s.gen !== gen) return;
      if (st === 'failed' || st === 'closed') {
        resetSlot(s, 1500);
      } else if (st === 'disconnected') {
        clearTimeout(s.discTimer);
        s.discTimer = setTimeout(() => {
          if (s.gen !== gen) return;
          const pc = call.peerConnection;
          if (!pc || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') resetSlot(s, 1500);
        }, 8000);
      } else if (st === 'connected' || st === 'completed') {
        clearTimeout(s.discTimer);
      }
    });
    try { call.answer(); } catch (e) { resetSlot(s, 3000); }
  }

  function resetSlot(s, delay) {
    s.gen++;
    const { conn, call } = s;
    s.conn = null;
    s.call = null;
    s.state = 'idle';
    s.authSent = false;
    s.nextProbe = Date.now() + delay;
    clearTimeout(s.discTimer);
    try { if (call) call.close(); } catch (e) { /* ignore */ }
    try { if (conn) conn.close(); } catch (e) { /* ignore */ }
    if (s.tile) {
      if (s.everSeen) setTileOffline(s);
      else removeTile(s);
    }
    if (s.peerId && retired.has(s.peerId)) releaseRetired(s.peerId);
    updateStatus();
  }

  // 主迴圈：找新鏡頭、處理逾時、送心跳
  let tick = 0;
  setInterval(() => {
    if (!started) return;
    const now = Date.now();
    tick++;
    for (const s of slots) {
      if (s.state === 'idle') {
        if (peer && peer.open && !peer.__dead && now >= s.nextProbe) connectSlot(s);
      } else if (s.state === 'connecting' || s.state === 'authed') {
        if (now > s.deadline) resetSlot(s, 1000);
      } else if (s.state === 'live') {
        if (now - s.lastSeen > 12000) resetSlot(s, 1000);
      }
      if (s.state !== 'idle' && s.state !== 'connecting' && tick % 3 === 0) send(s, { t: 'ping' });
    }
    // 看門狗：配對連線卡住
    const p = peer;
    if (p && !p.open && !recoverTimer) {
      if (p.destroyed || p.disconnected) scheduleRecover();
      else if (now - connectingSince > 40000) { try { p.disconnect(); } catch (e) { /* ignore */ } scheduleRecover(); }
    }
  }, 1000);

  // ---- 畫面 ----
  function insertTileSorted(s) {
    const after = slots.filter((x) => x.tile && x.n > s.n).map((x) => x.tile)[0];
    el.grid.insertBefore(s.tile, after || null);
  }

  function ensureTile(s) {
    if (s.tile) return s.tile;
    const t = document.createElement('div');
    t.className = 'tile connecting';
    t.innerHTML = '<video playsinline autoplay muted></video>' +
      '<div class="tile-label"><span class="dot"></span><span class="name"></span><span class="mic"></span></div>' +
      '<div class="tile-state">連線中…</div>' +
      '<button type="button" class="tile-audio" aria-label="聲音開關">🔇</button>';
    s.tile = t;
    t.video = t.querySelector('video');
    t.addEventListener('click', (e) => {
      if (e.target.closest('.tile-audio')) return;
      toggleFocus(s);
    });
    t.querySelector('.tile-audio').addEventListener('click', () => toggleAudio(s));
    insertTileSorted(s);
    updateTileLabel(s);
    updateStatus();
    return t;
  }

  function removeTile(s) {
    if (!s.tile) return;
    if (s.tile.classList.contains('focus')) el.grid.classList.remove('has-focus');
    s.tile.video.srcObject = null;
    s.tile.remove();
    s.tile = null;
    s.audioOn = false;
    updateStatus();
  }

  function setTileOffline(s) {
    const t = s.tile;
    t.classList.remove('live', 'connecting', 'motion');
    t.classList.add('offline');
    t.querySelector('.tile-state').textContent = '離線，重新連線中…';
    t.video.srcObject = null;
  }

  function updateTileLabel(s) {
    if (!s.tile) return;
    const name = (s.info && s.info.name) || `鏡頭 ${s.n}`;
    s.tile.querySelector('.name').textContent = name;
    s.tile.querySelector('.mic').textContent = s.info && s.info.mic === false ? ' 🔇無聲' : '';
    s.tile.querySelector('.tile-audio').textContent = s.audioOn ? '🔊' : '🔇';
    s.tile.querySelector('.tile-audio').classList.toggle('on', s.audioOn);
  }

  function setInfo(s, info) {
    if (!info || typeof info !== 'object') return;
    s.info = {
      name: typeof info.name === 'string' && info.name.trim() ? info.name.trim().slice(0, 20) : `鏡頭 ${s.n}`,
      camId: typeof info.camId === 'string' ? info.camId.slice(0, 32) : null,
      mic: info.mic !== false,
    };
    // 同一支鏡頭換了位置（例如重新整理）：移除舊位置的離線畫面
    if (s.info.camId) {
      slots.forEach((o) => {
        if (o !== s && o.state === 'idle' && o.info && o.info.camId === s.info.camId) {
          o.everSeen = false;
          o.info = null;
          removeTile(o);
        }
      });
    }
    ensureTile(s);
    updateTileLabel(s);
  }

  function attachStream(s, stream) {
    const t = ensureTile(s);
    const v = t.video;
    if (v.srcObject !== stream) v.srcObject = stream;
    v.muted = !s.audioOn;
    v.play().catch(() => {
      if (!v.muted) { v.muted = true; s.audioOn = false; updateTileLabel(s); v.play().catch(() => {}); }
    });
    t.classList.remove('offline', 'connecting');
    t.classList.add('live');
    t.querySelector('.tile-state').textContent = '';
    resetMotion(s);
  }

  function toggleAudio(s) {
    if (!s.tile) return;
    const v = s.tile.video;
    s.audioOn = !s.audioOn;
    v.muted = !s.audioOn;
    if (s.audioOn) {
      C.unlockAudio(true);
      v.play().catch(() => { s.audioOn = false; v.muted = true; updateTileLabel(s); C.toast('無法播放聲音，請再點一次'); });
      if (s.info && s.info.mic === false) C.toast('這支鏡頭的麥克風已關閉');
    }
    updateTileLabel(s);
  }

  function toggleFocus(s) {
    const isFocus = s.tile.classList.contains('focus');
    slots.forEach((o) => o.tile && o.tile.classList.remove('focus'));
    if (!isFocus) s.tile.classList.add('focus');
    el.grid.classList.toggle('has-focus', !isFocus);
  }

  // 回到前景時恢復播放
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    slots.forEach((s) => {
      if (s.tile && s.state === 'live') {
        s.tile.video.play().catch(() => {});
        resetMotion(s);
      }
    });
    if (peer && !peer.open) scheduleRecover(true);
  });

  // ---- 移動偵測（在監看端計算，不增加鏡頭手機的負擔） ----
  const MW = 64;
  const MH = 48;
  const canvas = document.createElement('canvas');
  canvas.width = MW;
  canvas.height = MH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // 靈敏度 1~10 → 畫面變動比例門檻（約 30% ~ 0.3%）
  const sensToRatio = (n) => 0.3 * Math.pow(0.6, n - 1);

  function resetMotion(s) {
    s.motion.prev = null;
    s.motion.hits = 0;
    s.motion.suppressUntil = Date.now() + 3000; // 等待自動曝光穩定
  }

  function analyze(s, now) {
    const v = s.tile.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    try { ctx.drawImage(v, 0, 0, MW, MH); } catch (e) { return; }
    let data;
    try { data = ctx.getImageData(0, 0, MW, MH).data; } catch (e) { return; }
    const N = MW * MH;
    const g = new Uint8Array(N);
    let sum = 0;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const y = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
      g[i] = y;
      sum += y;
    }
    const mean = sum / N;
    const m = s.motion;
    if (!m.prev || now < m.suppressUntil) {
      m.prev = g; m.prevMean = mean; m.hits = 0;
      return;
    }
    const dm = mean - m.prevMean; // 扣掉整體亮度變化（例如自動曝光）
    let changed = 0;
    for (let i = 0; i < N; i++) if (Math.abs(g[i] - m.prev[i] - dm) > 28) changed++;
    m.prev = g;
    m.prevMean = mean;
    if (changed / N > sensToRatio(settings.sens)) m.hits++;
    else m.hits = 0;
    if (m.hits >= 2) onMotion(s, now);
  }

  function onMotion(s, now) {
    const m = s.motion;
    m.until = now + 2500;
    s.tile.classList.add('motion');
    if (now - m.lastAlert > 10000) {
      m.lastAlert = now;
      addLog(s);
      if (settings.sound) C.beep();
    }
  }

  setInterval(() => {
    const now = Date.now();
    for (const s of slots) {
      if (!s.tile) continue;
      if (s.tile.classList.contains('motion') && now > s.motion.until) s.tile.classList.remove('motion');
      if (settings.motion && started && s.state === 'live' && document.visibilityState === 'visible') analyze(s, now);
    }
  }, 500);

  // ---- 紀錄 ----
  const log = [];
  let unseen = 0;
  function addLog(s) {
    log.unshift({ t: new Date(), name: (s.info && s.info.name) || `鏡頭 ${s.n}` });
    if (log.length > 200) log.pop();
    if (el.logModal.classList.contains('hidden')) unseen++;
    renderLog();
  }
  function renderLog() {
    el.logBadge.textContent = unseen > 99 ? '99+' : String(unseen);
    el.logBadge.classList.toggle('hidden', unseen === 0);
    if (!log.length) {
      el.logList.innerHTML = '<li class="muted">目前沒有紀錄</li>';
      return;
    }
    el.logList.innerHTML = log.map((e) =>
      `<li><span class="time">${C.fmtTime(e.t)}</span>${C.escapeHtml(e.name)} 偵測到移動</li>`).join('');
  }
  renderLog();

  // ---- 按鈕 ----
  function openModal(m) { m.classList.remove('hidden'); }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.hasAttribute('data-close')) m.classList.add('hidden');
    });
  });
  el.btnSound.addEventListener('click', () => {
    settings.sound = !settings.sound;
    saveSettings();
    renderSettings();
    C.toast(settings.sound ? '警示音：開' : '警示音：關');
  });
  el.btnMotion.addEventListener('click', () => openModal(el.motionModal));
  el.chkMotion.addEventListener('change', () => { settings.motion = el.chkMotion.checked; saveSettings(); renderSettings(); });
  el.chkSound.addEventListener('change', () => { settings.sound = el.chkSound.checked; saveSettings(); renderSettings(); });
  el.rngSens.addEventListener('input', () => {
    settings.sens = parseInt(el.rngSens.value, 10) || 5;
    saveSettings();
    renderSettings();
  });
  el.btnTestBeep.addEventListener('click', () => { C.unlockAudio(true); C.beep(); });
  el.btnLog.addEventListener('click', () => { unseen = 0; renderLog(); openModal(el.logModal); });
  el.btnClearLog.addEventListener('click', () => { log.length = 0; unseen = 0; renderLog(); });
  el.btnShare.addEventListener('click', () => {
    el.qrBox.innerHTML = C.qrSvg(C.pageUrl('viewer.html', key));
    openModal(el.shareModal);
  });

  el.btnStart.addEventListener('click', () => {
    C.unlockAudio(true);
    C.wake.enable();
    el.startOverlay.classList.add('hidden');
    started = true;
    createPeer();
    updateStatus();
  });

  window.addEventListener('pagehide', () => {
    slots.forEach((s) => { try { if (s.call) s.call.close(); } catch (e) { /* ignore */ } });
    retired.forEach((p) => { try { p.destroy(); } catch (e) { /* ignore */ } });
    try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
  });
})();
