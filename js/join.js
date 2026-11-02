'use strict';
/* 首頁「加入監看」：找出同一個 Wi-Fi 上正在拍攝的房間，輸入配對碼後取得密鑰 */
(function () {
  const C = window.IPCam;
  const $ = C.$;
  const el = {
    btn: $('#goJoin'), modal: $('#joinModal'), status: $('#joinStatus'), spinner: $('#joinSpinner'),
    list: $('#roomList'), pinForm: $('#pinForm'), pinRoom: $('#pinRoom'), pinInput: $('#pinInput'),
    pinError: $('#pinError'), btnPinBack: $('#btnPinBack'), btnRetry: $('#btnRetry'), btnClose: $('#btnJoinClose'),
  };
  if (!el.btn) return;
  C.autoUpdate(() => el.modal.classList.contains('hidden'));

  let peer = null;
  let rooms = new Map(); // tag -> { tag, names: Map(peerId -> name), conns: [] }
  let chosen = null;
  let searchId = 0;
  let pending = null; // 等待配對結果的連線
  let notLocal = false;

  function setStatus(text, spinning) {
    el.status.textContent = text;
    el.spinner.classList.toggle('hidden', !spinning);
  }

  function cleanup() {
    searchId++;
    rooms.forEach((r) => r.conns.forEach((c) => { try { c.close(); } catch (e) { /* ignore */ } }));
    rooms = new Map();
    chosen = null;
    pending = null;
    if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
    peer = null;
  }

  function showList() {
    el.pinForm.classList.add('hidden');
    el.list.classList.remove('hidden');
    renderRooms();
  }

  function renderRooms() {
    el.list.innerHTML = '';
    rooms.forEach((r) => {
      if (!r.conns.some((c) => c.open)) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'room';
      const names = [...r.names.values()];
      b.innerHTML = '<span class="row-icon blue">' + C.icon('cam') + '</span><span class="row-text"><b></b><small></small></span>' +
        '<svg class="chev" aria-hidden="true"><use href="icons/sprite.svg?v=10#chev"></use></svg>';
      b.querySelector('b').textContent = names.join('、');
      b.querySelector('small').textContent = `${names.length} 支鏡頭`;
      b.addEventListener('click', () => choose(r));
      el.list.appendChild(b);
    });
  }

  function choose(r) {
    chosen = r;
    el.list.classList.add('hidden');
    el.pinForm.classList.remove('hidden');
    el.pinRoom.textContent = [...r.names.values()].join('、');
    el.pinError.textContent = '';
    el.pinInput.value = '';
    setStatus('輸入鏡頭畫面上的 4 位數配對碼', false);
    setTimeout(() => el.pinInput.focus(), 50);
  }

  function onMsg(conn, msg, sid) {
    if (sid !== searchId || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': {
        if (typeof msg.tag !== 'string' || !/^[0-9a-f]{12}$/.test(msg.tag)) return;
        let r = rooms.get(msg.tag);
        if (!r) { r = { tag: msg.tag, names: new Map(), conns: [] }; rooms.set(msg.tag, r); }
        const name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim().slice(0, 20) : '鏡頭';
        r.names.set(conn.peer, name);
        if (!r.conns.includes(conn)) r.conns.push(conn);
        if (!chosen) {
          setStatus('選擇房間', true);
          renderRooms();
        }
        break;
      }
      case 'notlocal':
        notLocal = true;
        break;
      case 'key':
        if (conn !== pending) return;
        if (!C.isValidKey(msg.key)) { el.pinError.textContent = '收到的資料不正確，請重試'; return; }
        C.store.set('view.key', msg.key);
        setStatus('配對成功', true);
        location.href = 'viewer.html#k=' + msg.key;
        break;
      case 'bad':
        if (conn !== pending) return;
        pending = null;
        el.pinError.textContent = msg.locked
          ? `配對碼錯誤，嘗試太多次，請 ${Math.ceil(msg.locked / 60)} 分鐘後再試`
          : `配對碼錯誤，還可以再試 ${msg.left} 次`;
        el.pinInput.select();
        break;
      case 'locked':
        if (conn !== pending) return;
        pending = null;
        el.pinError.textContent = `嘗試太多次，請 ${Math.ceil(msg.seconds / 60)} 分鐘後再試`;
        break;
      default:
        break;
    }
  }

  async function search() {
    cleanup();
    const sid = searchId;
    notLocal = false;
    showList();
    el.btnRetry.classList.add('hidden');
    const problem = C.envProblem(false);
    if (problem) { setStatus(problem, false); return; }
    setStatus('搜尋鏡頭中…', true);

    const netIds = (await C.getNetworkIds(7000)).slice(0, 4);
    if (sid !== searchId) return;
    if (!netIds.length) {
      setStatus('無法偵測網路，請改用 QR Code', false);
      el.btnRetry.classList.remove('hidden');
      return;
    }
    const bases = await Promise.all(netIds.map(C.lobbyBase));
    const codes = (await Promise.all(netIds.map(C.netCode))).join('、');
    const p = new window.Peer(C.peerOptions());
    peer = p;
    p.on('error', (err) => {
      if (sid !== searchId) return;
      if (err && (err.type === 'peer-unavailable' || err.type === 'webrtc')) return; // 該公告位置沒有鏡頭
      if (!p.open) {
        setStatus('無法連線，請重試', false);
        el.btnRetry.classList.remove('hidden');
      }
    });
    p.on('open', () => {
      if (sid !== searchId) return;
      for (const base of bases) for (let n = 1; n <= C.LOBBY_SLOTS; n++) {
        let conn;
        try { conn = p.connect(C.lobbyPeerId(base, n), { serialization: 'json', reliable: true }); } catch (e) { conn = null; }
        if (!conn) continue;
        conn.on('data', (m) => onMsg(conn, m, sid));
        conn.on('close', () => {
          if (sid !== searchId) return;
          if (!chosen) renderRooms();
          if (conn === pending) { pending = null; el.pinError.textContent = '連線中斷，請再按一次「加入」'; }
        });
      }
      setTimeout(() => {
        if (sid !== searchId || chosen) return;
        const found = [...rooms.values()].some((r) => r.conns.some((c) => c.open));
        if (found) {
          setStatus('選擇房間', false);
        } else {
          setStatus(notLocal
            ? '請連上與鏡頭相同的 Wi-Fi，或改用 QR Code'
            : `找不到鏡頭
請確認鏡頭正在拍攝、兩台連同一個 Wi-Fi
網路代碼 ${codes}`, false);
          el.btnRetry.classList.remove('hidden');
        }
      }, 8000);
    });
  }

  el.pinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = el.pinInput.value.replace(/\D/g, '');
    if (pin.length !== 4) { el.pinError.textContent = '請輸入 4 位數字'; return; }
    if (!chosen) return;
    const conn = chosen.conns.find((c) => c.open);
    if (!conn) { el.pinError.textContent = '和這個房間的連線中斷了，請重新搜尋'; return; }
    el.pinError.textContent = '';
    pending = conn;
    try { conn.send({ t: 'join', pin }); } catch (err) { pending = null; el.pinError.textContent = '傳送失敗，請重試'; return; }
    setTimeout(() => {
      if (pending === conn) { pending = null; el.pinError.textContent = '鏡頭沒有回應，請再試一次'; }
    }, 8000);
  });
  el.pinInput.addEventListener('input', () => {
    el.pinInput.value = el.pinInput.value.replace(/\D/g, '').slice(0, 4);
  });
  el.btnPinBack.addEventListener('click', () => { chosen = null; pending = null; showList(); setStatus('選擇房間', false); });
  el.btnRetry.addEventListener('click', search);
  el.btn.addEventListener('click', () => { el.modal.classList.remove('hidden'); search(); });
  const close = () => { el.modal.classList.add('hidden'); cleanup(); };
  el.btnClose.addEventListener('click', close);
  el.modal.addEventListener('click', (e) => { if (e.target === el.modal) close(); });
  window.addEventListener('pagehide', cleanup);
})();
