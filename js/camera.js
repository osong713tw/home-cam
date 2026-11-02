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

  // iPhone 預設宣告 H.264 Level 3.1（最高只能編到 720p），1080p 時編碼器會停止輸出。
  // 鏡頭端在套用監看端的回應時把等級提高到 4.0（支援 1080p），監看端的解碼器本來就能處理。
  function raiseH264Level(sdp) {
    return sdp.replace(/(profile-level-id=)([0-9a-fA-F]{4})([0-9a-fA-F]{2})/g,
      (m, k, profile, lvl) => (parseInt(lvl, 16) < 0x28 ? k + profile + '28' : m));
  }
  (function patchRemoteAnswer() {
    const P = window.RTCPeerConnection && window.RTCPeerConnection.prototype;
    if (!P || P.__ipcamPatched) return;
    const orig = P.setRemoteDescription;
    P.setRemoteDescription = function (desc, ...rest) {
      if (!rest.length && desc && desc.type === 'answer' && typeof desc.sdp === 'string' && /H264/i.test(desc.sdp)) {
        const sdp = raiseH264Level(desc.sdp);
        if (sdp !== desc.sdp) {
          // 若瀏覽器不接受調整後的內容，退回原本的設定，不影響連線
          return orig.call(this, { type: desc.type, sdp }).catch(() => orig.call(this, desc));
        }
      }
      return orig.call(this, desc, ...rest);
    };
    P.__ipcamPatched = true;
  })();

  const el = {
    preview: $('#preview'), status: $('#status'), statusText: $('#statusText'), dot: $('#status .dot'),
    camName: $('#camName'), viewerCount: $('#viewerCount'), btnFlip: $('#btnFlip'), selQuality: $('#selQuality'),
    btnMic: $('#btnMic'), btnBlack: $('#btnBlack'), btnQR: $('#btnQR'), btnSettings: $('#btnSettings'),
    blackout: $('#blackout'), blackoutHint: $('#blackoutHint'), startOverlay: $('#startOverlay'),
    btnStart: $('#btnStart'), startError: $('#startError'), joinNote: $('#joinNote'),
    qrModal: $('#qrModal'), qrBox: $('#qrBox'), qrDesc: $('#qrDesc'), btnCopy: $('#btnCopy'),
    settingsModal: $('#settingsModal'), inpName: $('#inpName'), roomCode: $('#roomCode'), slotNo: $('#slotNo'),
    btnNewRoom: $('#btnNewRoom'), pinChip: $('#pinChip'), pinText: $('#pinText'), pinText2: $('#pinText2'),
    pinNote: $('#pinNote'), netCodes: $('#netCodes'),
  };

  function showStartError(msg) {
    el.startError.textContent = msg;
    el.startError.classList.remove('hidden');
  }

  C.autoUpdate(() => !el.startOverlay.classList.contains('hidden'));
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
    videoSince: Date.now(), // 最近一次更換影像來源的時間
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
    $('#viewerNum').textContent = String(n);
    const micOn = state.hadAudio && state.mic;
    C.setIcon(el.btnMic, micOn ? 'mic' : 'micoff');
    el.btnMic.setAttribute('aria-label', !state.hadAudio ? '沒有麥克風' : (state.mic ? '麥克風：開' : '麥克風：關'));
    el.btnMic.classList.toggle('alert', !micOn);
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
      state.videoSince = Date.now();
      state.viewers.forEach((v) => { v.stall = 0; replaceInCall(v, 'video', vt); });
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

  // 畫面傳送檢查：確認實際有送出畫面；1080p 送不出去時自動改回 720p
  async function checkVideoFlow(v, now) {
    const pc = v.call && v.call.peerConnection;
    if (!pc || !['connected', 'completed'].includes(pc.iceConnectionState)) { v.stall = 0; return; }
    const sender = senderFor(pc, 'video');
    if (!sender || !sender.getStats || !sender.track || sender.track.readyState !== 'live' || sender.track.muted) {
      v.stall = 0;
      return;
    }
    let frames = null;
    try {
      const stats = await sender.getStats();
      stats.forEach((r) => {
        if (r.type !== 'outbound-rtp' || (r.kind || r.mediaType) !== 'video') return;
        const f = typeof r.framesEncoded === 'number' ? r.framesEncoded : r.framesSent;
        if (typeof f === 'number') frames = (frames || 0) + f;
      });
    } catch (e) { return; }
    if (frames === null || state.viewers.get(v.id) !== v) return;
    if (v.lastFrames === undefined || frames !== v.lastFrames || now - state.videoSince < 3000) {
      v.stall = 0;
      if (state.quality === '1080' && v.lastFrames !== undefined && frames > v.lastFrames &&
          now - state.videoSince > 10000) store.del('cam.1080fail');
    } else {
      v.stall = (v.stall || 0) + 1;
    }
    v.lastFrames = frames;
    if (v.stall >= 2 && state.quality === '1080' && !state.switching) fallbackFrom1080();
  }

  function fallbackFrom1080() {
    const prev = { facing: state.facing, quality: state.quality };
    state.quality = '720';
    el.selQuality.value = '720';
    store.set('cam.1080fail', true);
    state.viewers.forEach((v) => { v.stall = 0; });
    replaceVideo(prev).then(() => C.toast('這支 iPhone 無法傳送 1080p 畫面，已自動改回 720p', 6000));
  }

  // 心跳：確認監看端仍在線，清掉離開的連線
  setInterval(() => {
    const now = Date.now();
    state.viewers.forEach((v) => {
      if (v.authed) {
        safeSend(v.conn, { t: 'ping' });
        checkVideoFlow(v, now);
        if (now - v.lastSeen > 15000) dropViewer(v);
      } else if (now - v.created > 12000) {
        dropViewer(v);
      }
    });
  }, 3000);

  // ---- 同一個 Wi-Fi 自動加入：公告房間，驗證配對碼後交付密鑰 ----
  const pin = await C.pinFromKey(key);
  const tag = await C.roomTag(key);
  el.pinText.textContent = pin;
  el.pinText2.textContent = pin;
  const lobby = { netIds: [], entries: [], timer: null, fails: 0, lockouts: 0, lockUntil: 0, conns: new Set() };

  function updatePinChip() {
    const on = lobby.entries.some((e) => e.open);
    el.pinChip.classList.remove('hidden');
    el.pinChip.classList.toggle('warn', !on);
    el.pinChip.title = on ? '同一個 Wi-Fi 的裝置在首頁按「加入監看」輸入這組配對碼' : '目前無法使用配對碼加入，請改用 QR Code';
    el.pinNote.textContent = on
      ? `或在首頁點「加入監看」，輸入配對碼 ${pin}`
      : '配對碼暫時無法使用，請先用 QR Code';
  }

  // 收集這台手機所有網路的位址（Wi-Fi／行動網路、IPv4／IPv6），各自公告一次
  async function startLobby() {
    clearTimeout(lobby.timer);
    lobby.timer = null;
    lobby.entries.forEach((e) => { if (e.peer) killPeer(e.peer); });
    lobby.entries = [];
    lobby.netIds = (await C.getNetworkIds(7000)).slice(0, 4);
    el.netCodes.textContent = lobby.netIds.length ? (await Promise.all(lobby.netIds.map(C.netCode))).join('、') : '偵測不到';
    if (!lobby.netIds.length) { updatePinChip(); lobby.timer = setTimeout(startLobby, 60000); return; }
    for (const netId of lobby.netIds) {
      const e = { netId, base: await C.lobbyBase(netId), peer: null, open: false };
      lobby.entries.push(e);
      createLobbyPeer(e, 1);
    }
    updatePinChip();
  }

  function createLobbyPeer(e, n) {
    const p = new window.Peer(C.lobbyPeerId(e.base, n), C.peerOptions());
    e.peer = p;
    e.open = false;
    p.on('open', () => { if (e.peer === p && !p.__dead) { e.open = true; updatePinChip(); } });
    p.on('connection', (conn) => onLobbyConn(conn));
    p.on('call', (c) => { try { c.close(); } catch (err) { /* ignore */ } });
    p.on('disconnected', () => {
      if (e.peer !== p || p.__dead) return;
      e.open = false;
      retryLobby(15000);
    });
    p.on('error', (err) => {
      if (e.peer !== p || p.__dead) return;
      const t = err && err.type;
      if (t === 'peer-unavailable' || t === 'webrtc') return;
      if (t === 'unavailable-id' && n < C.LOBBY_SLOTS) {
        // 這個公告位置已被同網路的其他鏡頭使用：換下一個
        killPeer(p);
        createLobbyPeer(e, n + 1);
        return;
      }
      e.open = false;
      retryLobby(t === 'unavailable-id' ? 60000 : 15000);
    });
  }

  function retryLobby(delay) {
    updatePinChip();
    if (lobby.timer) return;
    lobby.timer = setTimeout(startLobby, delay); // 重新偵測，網路可能換了
  }

  function onLobbyConn(conn) {
    if (lobby.conns.size >= 6) {
      conn.on('open', () => setTimeout(() => conn.close(), 300));
      return;
    }
    lobby.conns.add(conn);
    let attempts = 0;
    let ok = false;
    const closeTimer = setTimeout(() => conn.close(), 120000);
    const cleanup = () => { clearTimeout(closeTimer); lobby.conns.delete(conn); };
    conn.on('close', cleanup);
    conn.on('error', cleanup);
    conn.on('open', async () => {
      // 只接受走區域網路的連線（同一個 Wi-Fi／熱點）；來自外網或經過中繼伺服器的一律拒絕
      const local = await C.connectionIsLocal(conn.peerConnection, lobby.netIds);
      if (local === false) {
        safeSend(conn, { t: 'notlocal' });
        setTimeout(() => conn.close(), 500);
        return;
      }
      ok = true;
      safeSend(conn, { t: 'hello', tag, name: displayName(), p: C.PROTOCOL });
    });
    conn.on('data', (msg) => {
      if (!ok || !msg || msg.t !== 'join') return;
      const now = Date.now();
      if (now < lobby.lockUntil) {
        safeSend(conn, { t: 'locked', seconds: Math.ceil((lobby.lockUntil - now) / 1000) });
        return;
      }
      if (typeof msg.pin === 'string' && C.safeEqual(msg.pin, pin)) {
        lobby.fails = 0;
        lobby.lockouts = 0;
        safeSend(conn, { t: 'key', key });
        C.toast('有裝置用配對碼加入了');
        setTimeout(() => conn.close(), 3000);
        return;
      }
      lobby.fails++;
      attempts++;
      // 每錯 5 次鎖定，鎖定時間逐次加倍（1、2、4、8… 分鐘）
      if (lobby.fails % 5 === 0) lobby.lockUntil = now + 60000 * Math.pow(2, lobby.lockouts++);
      C.toast('有裝置輸入了錯誤的配對碼');
      const locked = lobby.lockUntil > now ? Math.ceil((lobby.lockUntil - now) / 1000) : 0;
      safeSend(conn, { t: 'bad', left: 5 - (lobby.fails % 5), locked });
      if (attempts >= 5) setTimeout(() => conn.close(), 500);
    });
  }

  // ---- 介面 ----
  function openModal(m) { m.classList.remove('hidden'); }
  function closeModal(m) { m.classList.add('hidden'); }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) closeModal(m);
    });
  });

  let qrTab = 'view';
  function renderQR() {
    const url = C.pageUrl(qrTab === 'view' ? 'viewer.html' : 'camera.html', key);
    el.qrBox.innerHTML = C.qrSvg(url);
    el.qrBox.dataset.url = url;
    el.qrDesc.textContent = qrTab === 'view'
      ? '用「相機」App 掃描即可監看'
      : '用另一支 iPhone 掃描，加入成為鏡頭';
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
    if (!confirm('建立新房間？所有裝置需重新加入。')) return;
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
    if (state.quality === '1080') {
      C.toast(store.get('cam.1080fail', false)
        ? '上次 1080p 傳送失敗；若監看端沒有畫面，幾秒後會自動改回 720p'
        : '1080p 比較耗電、容易發熱，長時間監看建議用 720p', 5000);
    }
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
    startLobby();
    renderQR();
    openModal(el.qrModal);
  });

  window.addEventListener('pagehide', () => {
    try { if (state.peer) state.peer.destroy(); } catch (e) { /* ignore */ }
    try { if (lobby.peer) lobby.peer.destroy(); } catch (e) { /* ignore */ }
  });
})();
