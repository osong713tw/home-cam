'use strict';
/* 鏡頭端：開啟相機、在房間中占一個鏡頭位置，驗證通過的監看端才傳送影像 */
(async function () {
  const C = window.IPCam;
  const $ = C.$;
  const store = C.store;

  const QUALITY = {
    480: { w: 640, h: 480, br: 800000 },
    720: { w: 1280, h: 720, br: 1800000 },
    1080: { w: 1920, h: 1080, br: 3500000 },
  };

  const el = {
    preview: $('#preview'), status: $('#status'), statusText: $('#statusText'), dot: $('#status .dot'),
    camName: $('#camName'), viewerCount: $('#viewerCount'), btnFlip: $('#btnFlip'), selQuality: $('#selQuality'),
    btnMic: $('#btnMic'), btnBlack: $('#btnBlack'), btnQR: $('#btnQR'), btnSettings: $('#btnSettings'),
    blackout: $('#blackout'), blackoutHint: $('#blackoutHint'), startOverlay: $('#startOverlay'),
    btnStart: $('#btnStart'), startError: $('#startError'), joinNote: $('#joinNote'),
    qrModal: $('#qrModal'), qrBox: $('#qrBox'), qrDesc: $('#qrDesc'), btnCopy: $('#btnCopy'),
    settingsModal: $('#settingsModal'), inpName: $('#inpName'), roomCode: $('#roomCode'), slotNo: $('#slotNo'),
    btnNewRoom: $('#btnNewRoom'),
  };

  function showStartError(msg) {
    el.startError.textContent = msg;
    el.startError.classList.remove('hidden');
  }

  const problem = C.envProblem(true);
  if (problem) {
    el.btnStart.disabled = true;
    showStartError(problem);
    return;
  }

  // ---- 房間密鑰：網址 > 已儲存 > 新建 ----
  const hashKey = C.readHashKey();
  const savedKey = store.get('cam.key', null);
  let key = hashKey || (C.isValidKey(savedKey) ? savedKey : null);
  if (!key) key = C.newKey();
  if (hashKey && hashKey !== savedKey) el.joinNote.classList.remove('hidden');
  store.set('cam.key', key);
  C.setHashKey(key); // 讓「加入主畫面」時保留密鑰
  const room = await C.roomIdFromKey(key);

  let camId = store.get('cam.id', null);
  if (!camId) { camId = C.randomId(); store.set('cam.id', camId); }

  const state = {
    peer: null,
    slot: 0,
    everOpened: false,
    stream: null,
    hadAudio: false,
    facing: store.get('cam.facing', 'environment') === 'user' ? 'user' : 'environment',
    quality: QUALITY[store.get('cam.quality', '720')] ? String(store.get('cam.quality', '720')) : '720',
    mic: store.get('cam.mic', true) !== false,
    name: String(store.get('cam.name', '') || '').slice(0, 20),
    viewers: new Map(),
    switching: false,
  };
  el.selQuality.value = state.quality;
  el.inpName.value = state.name;
  el.roomCode.textContent = room.slice(0, 4).toUpperCase();

  const displayName = () => state.name || (state.slot ? `鏡頭 ${state.slot}` : '鏡頭');
  const info = () => ({
    name: displayName(), camId, slot: state.slot, facing: state.facing, quality: state.quality,
    mic: !!(state.hadAudio && state.mic),
  });

  // ---- 狀態顯示 ----
  function setStatus(kind, text) {
    el.dot.className = 'dot ' + ({ online: 'ok', error: 'err', full: 'err' }[kind] || 'wait');
    if (!text) {
      text = {
        connecting: '連線中…',
        online: `上線中 · 位置 ${state.slot}`,
        reconnecting: state.viewers.size ? '重新連線中（畫面仍在傳送）' : '重新連線中…',
        full: '房間的鏡頭已滿（最多 ' + C.MAX_CAMS + ' 支）',
      }[kind] || kind;
    }
    el.statusText.textContent = text;
  }
  function updateLabels() {
    el.camName.textContent = displayName();
    el.slotNo.textContent = state.slot || '-';
    const n = [...state.viewers.values()].filter((v) => v.authed).length;
    el.viewerCount.textContent = '👁 ' + n;
    el.btnMic.querySelector('span').textContent = !state.hadAudio ? '無麥克風' : (state.mic ? '麥克風開' : '麥克風關');
    el.btnMic.classList.toggle('off', !state.hadAudio || !state.mic);
    el.preview.classList.toggle('mirror', state.facing === 'user');
  }

  // ---- 相機 ----
  function constraints(withVideo, withAudio) {
    const q = QUALITY[state.quality];
    const c = {};
    c.video = withVideo ? {
      facingMode: { ideal: state.facing },
      width: { ideal: q.w }, height: { ideal: q.h },
      frameRate: { ideal: 24, max: 30 },
    } : false;
    c.audio = withAudio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false;
    return c;
  }

  function mediaErrorText(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return '沒有相機權限。請到 iPhone「設定 › Safari › 相機／麥克風」選「允許」，或點網址列左邊的「ᴀA」› 網站設定 › 允許相機，然後重新整理。';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return '找不到可用的相機。';
    if (n === 'NotReadableError' || n === 'AbortError') return '相機正被其他 App 使用中，請關閉其他使用相機的 App 後再試。';
    return '無法開啟相機：' + (e && (e.message || e.name) || e);
  }

  function hookTrack(track) {
    track.addEventListener('ended', () => setTimeout(ensureMedia, 800));
  }

  async function playPreview() {
    el.preview.srcObject = null;
    el.preview.srcObject = state.stream;
    try { await el.preview.play(); } catch (e) { /* 自動播放限制，靜音影片不影響拍攝 */ }
  }

  async function openInitialStream() {
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia(constraints(true, true));
    } catch (e) {
      if (e && e.name === 'NotAllowedError') throw e;
      // 可能是麥克風不可用：改成只開影像
      s = await navigator.mediaDevices.getUserMedia(constraints(true, false));
    }
    state.stream = s;
    state.hadAudio = s.getAudioTracks().length > 0;
    s.getTracks().forEach(hookTrack);
    applyMic();
    await playPreview();
  }

  function applyMic() {
    if (!state.stream) return;
    state.stream.getAudioTracks().forEach((t) => { t.enabled = state.mic; });
    updateLabels();
  }

  function senderFor(pc, kind) {
    const tr = pc.getTransceivers().find((t) => (t.sender && t.sender.track && t.sender.track.kind === kind) ||
      (t.receiver && t.receiver.track && t.receiver.track.kind === kind));
    return tr ? tr.sender : null;
  }

  function replaceInCall(v, kind, track) {
    const pc = v.call && v.call.peerConnection;
    if (!pc) return;
    const sender = senderFor(pc, kind);
    if (!sender) return;
    sender.replaceTrack(track).then(() => { if (kind === 'video') applyBitrate(v); }).catch(() => {});
  }

  function applyBitrate(v) {
    const pc = v.call && v.call.peerConnection;
    if (!pc) return;
    const sender = senderFor(pc, 'video');
    if (!sender || !sender.getParameters) return;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) return; // 尚未協商完成，連線後會再套用
      p.encodings[0].maxBitrate = QUALITY[state.quality].br;
      sender.setParameters(p).catch(() => {});
    } catch (e) { /* 部分瀏覽器不支援 */ }
  }

  function setControlsBusy(b) {
    el.btnFlip.disabled = b;
    el.selQuality.disabled = b;
  }

  // 更換影像來源（切換前後鏡頭／畫質／相機被系統關閉後恢復）
  async function replaceVideo(prev) {
    if (state.switching || !state.stream) return;
    state.switching = true;
    setControlsBusy(true);
    const old = state.stream.getVideoTracks()[0];
    try {
      if (old) old.stop(); // iOS 必須先釋放目前的相機
      let ns;
      try {
        ns = await navigator.mediaDevices.getUserMedia(constraints(true, false));
      } catch (e) {
        if (!prev) throw e;
        state.facing = prev.facing;
        state.quality = prev.quality;
        el.selQuality.value = state.quality;
        ns = await navigator.mediaDevices.getUserMedia(constraints(true, false));
        C.toast('無法切換，已恢復原本的設定');
      }
      const vt = ns.getVideoTracks()[0];
      if (old) state.stream.removeTrack(old);
      state.stream.addTrack(vt);
      hookTrack(vt);
      await playPreview();
      state.viewers.forEach((v) => replaceInCall(v, 'video', vt));
      store.set('cam.facing', state.facing);
      store.set('cam.quality', state.quality);
      updateLabels();
      broadcast({ t: 'info', info: info(), reset: true });
    } catch (e) {
      C.toast(mediaErrorText(e), 6000);
      setTimeout(ensureMedia, 3000); // 相機暫時無法使用時自動重試
    } finally {
      state.switching = false;
      setControlsBusy(false);
    }
  }

  async function replaceAudio() {
    try {
      const ns = await navigator.mediaDevices.getUserMedia(constraints(false, true));
      const at = ns.getAudioTracks()[0];
      state.stream.getAudioTracks().forEach((t) => { t.stop(); state.stream.removeTrack(t); });
      state.stream.addTrack(at);
      hookTrack(at);
      applyMic();
      state.viewers.forEach((v) => replaceInCall(v, 'audio', at));
    } catch (e) { /* 保持無聲 */ }
  }

  // 頁面回到前景時，檢查相機／麥克風是否被系統關閉
  async function ensureMedia() {
    if (!state.stream || state.switching || document.visibilityState !== 'visible') return;
    const vt = state.stream.getVideoTracks()[0];
    if (!vt || vt.readyState === 'ended') await replaceVideo(null);
    const at = state.stream.getAudioTracks()[0];
    if (state.hadAudio && (!at || at.readyState === 'ended')) await replaceAudio();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(ensureMedia, 500);
  });

  // ---- 配對與連線 ----
  let order = [];
  let orderIdx = 0;
  let recoverTimer = null;
  let backoff = 0;
  let connectingSince = 0;

  function slotOrder() {
    const pref = store.get('cam.slot.' + room, 0);
    const arr = [];
    if (pref >= 1 && pref <= C.MAX_CAMS) arr.push(pref);
    for (let i = 1; i <= C.MAX_CAMS; i++) if (i !== pref) arr.push(i);
    return arr;
  }

  function createPeer(slot) {
    const p = new window.Peer(C.camPeerId(room, slot), C.peerOptions());
    state.peer = p;
    connectingSince = Date.now();
    setStatus('connecting', state.everOpened ? null : `連線中（嘗試位置 ${slot}）…`);

    p.on('open', () => {
      if (state.peer !== p || p.__dead) return;
      state.slot = slot;
      state.everOpened = true;
      backoff = 0;
      store.set('cam.slot.' + room, slot);
      setStatus('online');
      updateLabels();
      broadcast({ t: 'info', info: info() });
    });
    p.on('connection', (conn) => onConnection(p, conn));
    p.on('call', (call) => { try { call.close(); } catch (e) { /* ignore */ } });
    p.on('disconnected', () => {
      if (state.peer !== p || p.__dead) return;
      setStatus('reconnecting');
      scheduleRecover();
    });
    p.on('error', (err) => onPeerError(p, err));
  }

  function killPeer(p) {
    p.__dead = true; // 主動銷毀時不要觸發重新連線
    try { p.destroy(); } catch (e) { /* ignore */ }
  }

  function onPeerError(p, err) {
    if (state.peer !== p || p.__dead) return;
    const t = err && err.type;
    if (t === 'peer-unavailable' || t === 'webrtc') return; // 個別連線問題，由各連線自行處理
    if (t === 'unavailable-id') {
      if (!state.everOpened) {
        // 這個位置已有其他鏡頭：換下一個
        killPeer(p);
        orderIdx++;
        if (orderIdx >= order.length) {
          orderIdx = 0;
          setStatus('full');
          setTimeout(() => { if (state.peer === p) createPeer(order[0]); }, 10000);
          return;
        }
        createPeer(order[orderIdx]);
        return;
      }
      // 重新連線時伺服器還沒釋放舊連線：保留現有畫面傳送，稍後再試
      setStatus('reconnecting');
      scheduleRecover();
      return;
    }
    if (['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable'].includes(t)) {
      setStatus('error', '錯誤：' + (err.message || t));
      return;
    }
    setStatus('reconnecting');
    scheduleRecover();
  }

  function scheduleRecover(immediate) {
    if (recoverTimer) {
      if (!immediate) return;
      clearTimeout(recoverTimer);
    }
    const delay = immediate ? 300 : Math.min(30000, 2000 * Math.pow(1.6, backoff++));
    recoverTimer = setTimeout(() => {
      recoverTimer = null;
      const p = state.peer;
      if (!p || p.open) return;
      if (p.destroyed || !state.everOpened) {
        if (!p.destroyed) killPeer(p);
        createPeer(state.everOpened ? state.slot : order[orderIdx]);
        return;
      }
      if (p.disconnected) {
        try { connectingSince = Date.now(); p.reconnect(); } catch (e) { scheduleRecover(); }
      }
    }, delay);
  }

  // 看門狗：避免連線卡在半途
  setInterval(() => {
    const p = state.peer;
    if (!p || p.open || recoverTimer) return;
    if (p.destroyed || p.disconnected) { scheduleRecover(); return; }
    if (Date.now() - connectingSince > 40000) {
      try { p.disconnect(); } catch (e) { /* ignore */ }
      scheduleRecover();
    }
  }, 10000);
  window.addEventListener('online', () => { backoff = 0; scheduleRecover(true); });

  function safeSend(conn, msg) {
    try { if (conn && conn.open) conn.send(msg); } catch (e) { /* ignore */ }
  }
  function broadcast(msg) {
    state.viewers.forEach((v) => { if (v.authed) safeSend(v.conn, msg); });
  }

  function onConnection(p, conn) {
    const vid = conn.peer;
    const existing = state.viewers.get(vid);
    if (existing) dropViewer(existing);
    if (state.viewers.size >= C.MAX_VIEWERS) {
      conn.on('open', () => { safeSend(conn, { t: 'full' }); setTimeout(() => conn.close(), 800); });
      return;
    }
    const v = { id: vid, peer: p, conn, call: null, authed: false, checking: false, nonce: C.randomId(),
      created: Date.now(), lastSeen: Date.now(), discTimer: null };
    state.viewers.set(vid, v);
    conn.on('open', () => safeSend(conn, { t: 'challenge', nonce: v.nonce, p: C.PROTOCOL }));
    conn.on('data', (msg) => onViewerData(v, msg));
    conn.on('close', () => dropViewer(v));
    conn.on('error', () => dropViewer(v));
  }

  async function onViewerData(v, msg) {
    if (state.viewers.get(v.id) !== v || !msg || typeof msg !== 'object') return;
    v.lastSeen = Date.now();
    if (msg.t === 'auth' && !v.authed && !v.checking) {
      v.checking = true;
      const expect = await C.hmacHex(key, v.nonce + '|' + v.id + '|' + room);
      if (state.viewers.get(v.id) !== v) return;
      if (C.safeEqual(expect, msg.mac)) {
        v.authed = true;
        safeSend(v.conn, { t: 'ok', info: info() });
        startCall(v);
        updateLabels();
        C.toast('有新的監看端連上了');
      } else {
        safeSend(v.conn, { t: 'denied' });
        setTimeout(() => dropViewer(v), 600);
      }
    }
  }

  function startCall(v) {
    if (!state.stream || !v.peer || v.peer.destroyed) { dropViewer(v); return; }
    let call;
    try { call = v.peer.call(v.id, state.stream, { metadata: { slot: state.slot } }); } catch (e) { call = null; }
    if (!call) { dropViewer(v); return; }
    v.call = call;
    call.on('iceStateChanged', (st) => {
      if (state.viewers.get(v.id) !== v) return;
      if (st === 'connected' || st === 'completed') {
        clearTimeout(v.discTimer);
        applyBitrate(v);
      } else if (st === 'failed' || st === 'closed') {
        dropViewer(v);
      } else if (st === 'disconnected') {
        clearTimeout(v.discTimer);
        v.discTimer = setTimeout(() => {
          const pc = call.peerConnection;
          if (!pc || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') dropViewer(v);
        }, 10000);
      }
    });
    call.on('close', () => dropViewer(v));
    call.on('error', () => dropViewer(v));
  }

  function dropViewer(v) {
    if (state.viewers.get(v.id) !== v) return;
    state.viewers.delete(v.id);
    clearTimeout(v.discTimer);
    try { if (v.call) v.call.close(); } catch (e) { /* ignore */ }
    try { v.conn.close(); } catch (e) { /* ignore */ }
    updateLabels();
  }

  // 心跳：確認監看端仍在線，清掉離開的連線
  setInterval(() => {
    const now = Date.now();
    state.viewers.forEach((v) => {
      if (v.authed) {
        safeSend(v.conn, { t: 'ping' });
        if (now - v.lastSeen > 15000) dropViewer(v);
      } else if (now - v.created > 12000) {
        dropViewer(v);
      }
    });
  }, 3000);

  // ---- 介面 ----
  function openModal(m) { m.classList.remove('hidden'); }
  function closeModal(m) { m.classList.add('hidden'); }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.hasAttribute('data-close')) closeModal(m);
    });
  });

  let qrTab = 'view';
  function renderQR() {
    const url = C.pageUrl(qrTab === 'view' ? 'viewer.html' : 'camera.html', key);
    el.qrBox.innerHTML = C.qrSvg(url);
    el.qrBox.dataset.url = url;
    el.qrDesc.textContent = qrTab === 'view'
      ? '用其他 iPhone／iPad 的「相機」App 掃描，就能開始監看這個房間的所有鏡頭。'
      : '用另一支要當鏡頭的 iPhone 掃描，它會加入同一個房間，監看端會自動多一個畫面。';
    el.qrModal.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === qrTab));
  }
  el.qrModal.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { qrTab = b.dataset.tab; renderQR(); }));
  el.btnQR.addEventListener('click', () => { renderQR(); openModal(el.qrModal); });
  el.btnCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el.qrBox.dataset.url); C.toast('已複製連結'); }
    catch (e) { C.toast('無法複製，請直接掃描 QR Code'); }
  });

  el.btnSettings.addEventListener('click', () => openModal(el.settingsModal));
  el.inpName.addEventListener('change', () => {
    state.name = el.inpName.value.trim().slice(0, 20);
    store.set('cam.name', state.name);
    updateLabels();
    broadcast({ t: 'info', info: info() });
  });
  el.btnNewRoom.addEventListener('click', () => {
    if (!confirm('建立新房間後，舊的 QR Code 會全部失效，監看端與其他鏡頭都需要重新掃描。確定嗎？')) return;
    const k = C.newKey();
    store.set('cam.key', k);
    C.setHashKey(k);
    location.reload();
  });

  el.btnFlip.addEventListener('click', () => {
    const prev = { facing: state.facing, quality: state.quality };
    state.facing = state.facing === 'user' ? 'environment' : 'user';
    replaceVideo(prev);
  });
  el.selQuality.addEventListener('change', () => {
    const prev = { facing: state.facing, quality: state.quality };
    if (!QUALITY[el.selQuality.value]) return;
    state.quality = el.selQuality.value;
    replaceVideo(prev);
  });
  el.btnMic.addEventListener('click', () => {
    if (!state.hadAudio) { C.toast('沒有麥克風權限，監看端將聽不到聲音'); return; }
    state.mic = !state.mic;
    store.set('cam.mic', state.mic);
    applyMic();
    broadcast({ t: 'info', info: info() });
  });

  // 省電黑畫面：連點兩下解除
  let lastTap = 0;
  let hintTimer = null;
  el.btnBlack.addEventListener('click', () => {
    el.blackout.classList.remove('hidden');
    el.blackoutHint.classList.remove('show');
    el.preview.pause();
  });
  el.blackout.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 450) {
      el.blackout.classList.add('hidden');
      playPreview();
      lastTap = 0;
      return;
    }
    lastTap = now;
    el.blackoutHint.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.blackoutHint.classList.remove('show'), 2000);
  });

  updateLabels();

  el.btnStart.addEventListener('click', async () => {
    el.btnStart.disabled = true;
    el.startError.classList.add('hidden');
    C.unlockAudio(false);
    try {
      await openInitialStream();
    } catch (e) {
      el.btnStart.disabled = false;
      showStartError(mediaErrorText(e));
      return;
    }
    el.startOverlay.classList.add('hidden');
    C.wake.enable();
    order = slotOrder();
    orderIdx = 0;
    createPeer(order[0]);
    renderQR();
    openModal(el.qrModal);
  });

  window.addEventListener('pagehide', () => {
    try { if (state.peer) state.peer.destroy(); } catch (e) { /* ignore */ }
  });
})();
