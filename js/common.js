'use strict';
/* 共用工具：密鑰、房間、驗證、QR Code、提示訊息、螢幕常亮、警示音 */
window.IPCam = (function () {
  const MAX_CAMS = 6;      // 一個房間最多幾支鏡頭
  const MAX_VIEWERS = 4;   // 每支鏡頭最多同時幾個監看端（保護拍攝手機不過熱）
  const PROTOCOL = 1;

  const enc = (s) => new TextEncoder().encode(s);
  const $ = (sel, root) => (root || document).querySelector(sel);

  function peerOptions() {
    return Object.assign({ debug: 0 }, window.IPCAM_PEER_OPTIONS || {});
  }

  function randBytes(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return a;
  }
  function b64url(bytes) {
    let s = '';
    bytes.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function hex(buf) {
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const newKey = () => b64url(randBytes(16));          // 128 位元隨機密鑰
  const randomId = () => b64url(randBytes(9));
  const isValidKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(k);

  // 房間代號由密鑰雜湊而來：配對伺服器只看得到雜湊，看不到密鑰本身
  async function roomIdFromKey(key) {
    const d = await crypto.subtle.digest('SHA-256', enc('ipcam-room:' + key));
    return hex(d).slice(0, 16);
  }
  const camPeerId = (room, n) => `ipcam-${room}-c${n}`;
  function slotFromPeerId(room, id) {
    const prefix = `ipcam-${room}-c`;
    if (typeof id !== 'string' || !id.startsWith(prefix)) return 0;
    const n = parseInt(id.slice(prefix.length), 10);
    return n >= 1 && n <= MAX_CAMS && String(n) === id.slice(prefix.length) ? n : 0;
  }

  async function hmacHex(key, msg) {
    const k = await crypto.subtle.importKey('raw', enc(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', k, enc(msg)));
  }
  function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  }

  // ---- 網址與儲存 ----
  function readHashKey() {
    const k = new URLSearchParams(location.hash.slice(1)).get('k');
    return isValidKey(k) ? k : null;
  }
  function setHashKey(k) {
    history.replaceState(null, '', location.pathname + location.search + '#k=' + k);
  }
  function pageUrl(page, key) {
    const u = new URL(page, location.href);
    u.search = '';
    u.hash = 'k=' + key;
    return u.href;
  }
  const store = {
    get(name, def) {
      try {
        const v = localStorage.getItem('ipcam.' + name);
        return v === null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set(name, val) {
      try { localStorage.setItem('ipcam.' + name, JSON.stringify(val)); } catch (e) { /* 無痕模式 */ }
    },
    del(name) {
      try { localStorage.removeItem('ipcam.' + name); } catch (e) { /* ignore */ }
    },
  };

  // ---- QR Code ----
  function qrSvg(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
  }

  // ---- 提示訊息 ----
  let toastTimer = null;
  function toast(msg, ms) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2600);
  }

  // ---- 螢幕常亮 ----
  const wake = {
    lock: null,
    want: false,
    async enable() { this.want = true; await this.request(); },
    async request() {
      if (!this.want || this.lock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      try {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.addEventListener('release', () => { this.lock = null; });
      } catch (e) { this.lock = null; }
    },
  };
  document.addEventListener('visibilitychange', () => wake.request());

  // ---- 聲音（需在使用者點擊時解鎖） ----
  let actx = null;
  function unlockAudio(forPlayback) {
    try {
      // iOS 16.4+：讓警示音不受靜音鍵影響（僅監看端使用）
      if (forPlayback && navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (e) { /* ignore */ }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended') actx.resume();
      const buf = actx.createBuffer(1, 1, 22050);
      const src = actx.createBufferSource();
      src.buffer = buf;
      src.connect(actx.destination);
      src.start(0);
    } catch (e) { /* ignore */ }
  }
  function beep() {
    if (!actx) return;
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime + 0.02;
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.22;
      const osc = actx.createOscillator();
      const g = actx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(i % 2 ? 1320 : 990, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(g).connect(actx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    }
  }

  // ---- 環境檢查 ----
  function envProblem(needCamera) {
    if (!window.isSecureContext) return '這個網頁必須用 https:// 開啟，相機與加密功能才能使用。';
    if (!window.crypto || !crypto.subtle) return '這個瀏覽器不支援加密功能，請改用 Safari。';
    if (!window.RTCPeerConnection) return '這個瀏覽器不支援 WebRTC 即時影像，請改用 Safari。';
    if (needCamera && !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      return '這個瀏覽器無法使用相機。iPhone 請用 Safari 開啟（不要在 LINE 等 App 內建瀏覽器開啟）。';
    }
    if (typeof window.Peer !== 'function') return '程式元件載入失敗，請重新整理頁面。';
    return null;
  }

  // ---- 同一個 Wi-Fi 自動加入 ----
  const LOBBY_SLOTS = 8;

  function expandV6(a) {
    a = String(a).split('%')[0].toLowerCase();
    const halves = a.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
    const all = head.concat(Array(fill).fill('0'), tail);
    if (all.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
    return all.map((x) => parseInt(x, 16).toString(16));
  }
  // 位址 → 網路識別：IPv4 用對外位址；IPv6 用前 64 位元（同一個區網的裝置相同）
  function netIdOf(addr) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr || '')) return '4:' + addr;
    const h = addr && addr.includes(':') ? expandV6(addr) : null;
    return h ? '6:' + h.slice(0, 4).join(':') : null;
  }

  // 用 STUN 收集這台裝置「所有網路」的對外識別（Wi-Fi、行動網路、IPv4、IPv6 都算）
  function getNetworkIds(timeoutMs) {
    return new Promise((resolve) => {
      const ids = new Set();
      let pc;
      let done = false;
      let settle = null;
      const finish = () => {
        if (done) return;
        done = true;
        try { pc.close(); } catch (e) { /* ignore */ }
        resolve([...ids].sort());
      };
      try {
        pc = new RTCPeerConnection({ iceServers: [
          { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ] });
      } catch (e) { resolve([]); return; }
      pc.createDataChannel('ip');
      pc.onicecandidate = (e) => {
        if (!e.candidate) { finish(); return; }
        const c = e.candidate;
        const parts = (c.candidate || '').split(' ');
        const type = c.type || parts[7];
        if (type !== 'srflx') return;
        const id = netIdOf(c.address || parts[4]);
        if (!id) return;
        ids.add(id);
        if (!settle) settle = setTimeout(finish, 3000); // 再多等一下，收集其他網路介面
      };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish());
      setTimeout(finish, timeoutMs || 7000);
    });
  }

  async function sha256Hex(s) {
    return hex(await crypto.subtle.digest('SHA-256', enc(s)));
  }
  async function lobbyBase(netId) { return 'ipcam-lobby-' + (await sha256Hex('ipcam-lobby:' + netId)).slice(0, 20); }
  async function netCode(netId) { return (await sha256Hex('ipcam-lobby:' + netId)).slice(0, 4).toUpperCase(); }
  const lobbyPeerId = (base, n) => `${base}-${n}`;
  async function roomTag(key) { return (await sha256Hex('ipcam-tag:' + key)).slice(0, 12); }
  // 配對碼由房間密鑰推算：同一房間的所有鏡頭顯示相同的 4 位數；建立新房間後就會改變
  async function pinFromKey(key) {
    const h = await hmacHex(key, 'ipcam-pin');
    return String(parseInt(h.slice(0, 8), 16) % 10000).padStart(4, '0');
  }

  function isPrivateAddr(a) {
    if (!a) return false;
    a = String(a).toLowerCase();
    if (a.endsWith('.local')) return true;
    if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(a) || /^fe80:/.test(a)) return true;
    return false;
  }
  // 判斷一條連線是否走區域網路：true＝同一個網路、false＝來自外網或經過中繼、null＝無法判斷
  async function connectionIsLocal(pc, myNetIds) {
    if (!pc || !pc.getStats) return null;
    try {
      const stats = await pc.getStats();
      let selectedId = null;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) selectedId = r.selectedCandidatePairId; });
      let pair = null;
      stats.forEach((r) => {
        if (r.type !== 'candidate-pair') return;
        if (selectedId ? r.id === selectedId : (r.state === 'succeeded' && (r.nominated || r.selected))) pair = pair || r;
      });
      if (!pair) return null;
      const rc = stats.get(pair.remoteCandidateId);
      const lc = stats.get(pair.localCandidateId);
      if ((rc && rc.candidateType === 'relay') || (lc && lc.candidateType === 'relay')) return false;
      const addr = rc && (rc.address || rc.ip);
      if (!addr) return null;
      if (isPrivateAddr(addr)) return true;
      // 同一台路由器回送（IPv4 對外位址相同），或同一個 IPv6 區網（前 64 位元相同）
      const id = netIdOf(addr);
      if (id && (myNetIds || []).includes(id)) return true;
      return false;
    } catch (e) { return null; }
  }

  // ---- 圖示（icons/sprite.svg） ----
  const ICON_URL = 'icons/sprite.svg?v=8';
  const icon = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="${ICON_URL}#${name}"></use></svg>`;
  function setIcon(elm, name) {
    const u = elm && elm.querySelector('use');
    if (u) u.setAttribute('href', `${ICON_URL}#${name}`);
  }

  function fmtTime(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  return {
    MAX_CAMS, MAX_VIEWERS, PROTOCOL, $, peerOptions, newKey, randomId, isValidKey, roomIdFromKey,
    camPeerId, slotFromPeerId, hmacHex, safeEqual, readHashKey, setHashKey, pageUrl, store, qrSvg,
    toast, wake, unlockAudio, beep, envProblem, fmtTime, escapeHtml,
    icon, setIcon, LOBBY_SLOTS, getNetworkIds, netIdOf, netCode, lobbyBase, lobbyPeerId, roomTag, pinFromKey, connectionIsLocal,
  };
})();
