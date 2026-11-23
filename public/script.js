// 果果五子棋 v3 · 前端
// 本地对战(纯前端) / 在线对战(WebSocket): 账号与果果麻将通用, 好友邀请, AI 对手, 多局同时开
'use strict';

const SIZE_MAX = 19;
const EMPTY = 0, BLACK = 1, WHITE = 2;
const BOT_LABEL = { easy: '🍎 新手', medium: '🍌 进阶', hard: '🍈 高手' };

const $ = id => document.getElementById(id);
const lobbyEl = $('lobby'), onlineEl = $('onlinePanel'), gameEl = $('gameArea');
const boardEl = $('board'), statusEl = $('status'), errEl = $('msgErr');
const tabsEl = $('roomTabs');
const chatLog = $('chatLog'), chatForm = $('chatForm'), chatInput = $('chatInput');

function show(el) { [lobbyEl, onlineEl, gameEl].forEach(x => x.classList.add('hidden')); el.classList.remove('hidden'); }

// ---- 页面内导航: 把 视图切换 写进浏览器历史, 让手机返回键在 棋局→在线面板→玩法大厅 之间逐级回退,
//      而不是直接退出到站外(果果大厅)。退出对局视图后, 大厅里用"回到对局"按钮随时回去 ----
function ensurePush(v) { if (!history.state || history.state.view !== v) history.pushState({ view: v }, ''); }
function applyView(v) {
  if (v === 'game') {
    if (mode === 'local') { show(gameEl); return; } // 本地对战棋盘常驻可回
    if (rooms.size) {
      mode = 'game';
      if (!activeRoom || !rooms.has(activeRoom)) activeRoom = [...rooms.keys()][0];
      updateGameButtons(); show(gameEl); renderTabs(null); renderActive(); return;
    }
    v = 'lobby'; // 对局已不存在, 落回玩法大厅
  }
  if (v === 'online') { mode = 'online'; show(onlineEl); updateResumeBtn(); return; }
  mode = 'lobby'; show(lobbyEl); renderUser(); updateResumeBtn();
}
window.addEventListener('popstate', e => applyView((e.state && e.state.view) || 'lobby'));
function setStatus(t) { statusEl.textContent = t; }
function setErr(t) { errEl.textContent = t || ''; setTimeout(() => { if (errEl.textContent === t) errEl.textContent = ''; }, 4000); }
function stoneName(p) { return p === BLACK ? '黑棋 ●' : '白棋 ○'; }

// ================== 全屏 ==================
$('fsBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});

// ================== 本地对战 (原版逻辑) ==================
const local = { board: null, current: BLACK, over: false, mode: 'lobby', last: null };
let localSize = 15;

// 本地战局保存/恢复 (退出或刷新后不丢)
function localSave() {
  try {
    localStorage.setItem('gg_wzq_local', JSON.stringify({
      board: local.board, current: local.current, over: local.over, last: local.last,
    }));
  } catch (e) {}
}

function localReset(resume) {
  localSize = Number(localStorage.getItem('gg_wzq_local_size') || 15);
  const saved = resume ? JSON.parse(localStorage.getItem('gg_wzq_local') || 'null') : null;
  if (saved && Array.isArray(saved.board) && saved.board.length === localSize && !saved.over
      && saved.board.some(row => row.some(v => v !== EMPTY))) {
    // 继续上局
    local.board = saved.board; local.current = saved.current; local.last = saved.last; local.over = false;
    setStatus(`继续上局 · 当前回合：${stoneName(local.current)} (${localSize} 路)`);
  } else {
    local.board = Array.from({ length: localSize }, () => Array(localSize).fill(EMPTY));
    local.current = BLACK; local.over = false; local.last = null;
    setStatus(`当前回合：黑棋 ● (${localSize} 路)`);
  }
  renderBoard(null);
  localSave();
}

function localWin(r, c, p) {
  const n0 = localSize;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let n = 1;
    for (const s of [1, -1]) {
      let rr = r + dr * s, cc = c + dc * s;
      while (rr >= 0 && rr < n0 && cc >= 0 && cc < n0 && local.board[rr][cc] === p) { n++; rr += dr * s; cc += dc * s; }
    }
    if (n >= 5) return true;
  }
  return false;
}

function localMove(r, c) {
  if (local.over || local.board[r][c] !== EMPTY) return;
  local.board[r][c] = local.current;
  local.last = { row: r, col: c };
  if (localWin(r, c, local.current)) { local.over = true; setStatus(`胜者：${stoneName(local.current)} 🎉`); }
  else if (local.board.every(row => row.every(v => v !== EMPTY))) { local.over = true; setStatus('平局'); }
  else { local.current = local.current === BLACK ? WHITE : BLACK; setStatus(`当前回合：${stoneName(local.current)}`); }
  renderBoard(null);
  localSave();
}

// ================== 在线对战 ==================
const me = { user: null, name: null, token: null, vapidPub: null, friends: [], requests: [] };
const rooms = new Map(); // code -> {state, seat, size}
let activeRoom = null;
let mode = 'lobby';

const conn = {
  ws: null, connected: false, timer: null, wantResume: false,
  pending: [], // 连接建立后要发的消息队列
};

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return `${proto}${location.host}/gmk-ws`;
}

function oSend(obj) {
  if (conn.ws && conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj));
  else conn.pending.push(obj);
}

function oConnect() {
  clearTimeout(conn.timer);
  try { conn.ws = new WebSocket(wsUrl()); } catch (e) { return scheduleReconnect(); }
  conn.ws.onopen = () => {
    conn.connected = true;
    const queue = conn.pending.splice(0);
    // 1. 自动登录 2. 恢复之前的所有对局
    if (me.token) oSend({ t: 'auto_login', token: me.token });
    const sids = JSON.parse(localStorage.getItem('gg_wzq_sids') || '{}');
    const keys = Object.keys(sids);
    for (const code of keys) oSend({ t: 'resume', sid: sids[code] });
    queue.forEach(m => oSend(m));
    if (!keys.length && !queue.length && mode !== 'game') show(lobbyEl);
    if (!me.token && !keys.length) show(lobbyEl);
  };
  conn.ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    handleMsg(m);
  };
  conn.ws.onclose = () => {
    conn.connected = false;
    if (mode === 'game' || rooms.size) { setStatus('⚠ 连接断开, 正在重连…'); scheduleReconnect(); }
  };
}

function scheduleReconnect() {
  clearTimeout(conn.timer);
  conn.timer = setTimeout(oConnect, 2000);
}

// ---------- 消息处理 ----------
function handleMsg(m) {
  switch (m.t) {
    case 'auth_ok': {
      me.user = m.user; me.name = m.name; me.token = m.token; me.vapidPub = m.vapidPub;
      me.friends = m.friends || []; me.requests = m.requests || [];
      localStorage.setItem('gg_wzq_token', m.token);
      renderUser(); renderFriends();
      applyPendingInvites();
      break;
    }
    case 'auth_fail': {
      localStorage.removeItem('gg_wzq_token');
      me.token = null; renderUser();
      setErr('⚠ 账号或密码错误');
      break;
    }
    case 'friends': me.friends = m.friends || []; me.requests = m.requests || []; renderFriends(); break;
    case 'info': setErr('✅ ' + m.msg); break;
    case 'error': setErr('⚠ ' + m.msg); break;
    case 'welcome': onWelcome(m); break;
    case 'state': onState(m); break;
    case 'myrooms': renderTabs(m.rooms); break;
    case 'chat': addChat(m.from, m.msg); break;
    case 'invite': {
      const ok = confirm(`${m.fromName} 邀请你加入房间 ${m.code}, 是否加入?`);
      if (ok) oSend({ t: 'accept_invite', code: m.code });
      break;
    }
    case 'bye': {
      rooms.delete(m.code);
      if (activeRoom === m.code) activeRoom = [...rooms.keys()][0] || null;
      renderTabs(null);
      if (activeRoom) renderActive();
      else { mode = 'lobby'; show(lobbyEl); renderUser(); updateResumeBtn(); }
      break;
    }
    case 'resume_fail': {
      const sids = JSON.parse(localStorage.getItem('gg_wzq_sids') || '{}');
      for (const k of Object.keys(sids)) if (sids[k] === m.sid) delete sids[k];
      localStorage.setItem('gg_wzq_sids', JSON.stringify(sids));
      break;
    }
    case 'logged_out': me.user = null; me.name = null; me.token = null; renderUser(); break;
  }
}

function onWelcome(m) {
  rooms.set(m.code, { state: m, seat: m.seat, size: m.size });
  activeRoom = m.code;
  const sids = JSON.parse(localStorage.getItem('gg_wzq_sids') || '{}');
  sids[m.code] = m.sid;
  localStorage.setItem('gg_wzq_sids', JSON.stringify(sids));
  mode = 'game';
  ensurePush('game');
  show(gameEl);
  updateGameButtons();
  chatLog.innerHTML = '';
  if (!m.resumed) addChat(null, `房间号 ${m.code}, 把它告诉朋友吧`);
  renderTabs(null);
  renderActive();
}

function onState(m) {
  const r = rooms.get(m.code);
  if (!r) return;
  r.state = m; r.seat = m.seat; r.size = m.size;
  if (m.code === activeRoom) renderActive();
}

// ---------- 渲染 ----------
function renderUser() {
  const loginBtn = $('showLoginBtn'), menu = $('userMenu'), drop = $('userDrop');
  const fCard = $('friendsCard'), nRow = $('notifyRow'), lobbyLogin = $('lobbyLoginBtn');
  drop.classList.add('hidden');
  if (me.user) {
    $('userBtn').textContent = '👤 ' + me.name;
    loginBtn.classList.add('hidden');
    menu.classList.remove('hidden');
    loginBox.classList.add('hidden');
    lobbyLogin.classList.add('hidden');
    fCard.classList.remove('hidden');
    $('recordBtn').classList.remove('hidden');
    nRow.classList.toggle('hidden', !('Notification' in window));
    $('notifyChk').checked = localStorage.getItem('gg_wzq_notify') === '1';
  } else {
    menu.classList.add('hidden');
    loginBtn.classList.remove('hidden');
    // 未登录: 登录卡默认收起, 只显示小"登录"按钮, 点击才展开
    loginBox.classList.add('hidden');
    lobbyLogin.classList.remove('hidden');
    $('recordBtn').classList.add('hidden');
    fCard.classList.add('hidden');
    nRow.classList.add('hidden');
  }
}

// 点击昵称弹出菜单, 点其他区域收起
$('userBtn').addEventListener('click', e => { e.stopPropagation(); $('userDrop').classList.toggle('hidden'); });
document.addEventListener('click', e => {
  if (!$('userMenu').contains(e.target)) $('userDrop').classList.add('hidden');
});

// ---------- 我的战绩 (按钮 + 弹层, 读 /api/history 按昵称过滤) ----------
function renderRecord() {
  if (!me.user) return;
  // 相对路径 → /gmk/api/history (nginx 按路径前缀反代)
  fetch('api/history').then(r => r.json()).then(d => {
    const mine = (d.recent || []).filter(h => Array.isArray(h.players) && h.players.includes(me.name));
    const wins = mine.filter(h => h.winner === me.name).length;
    const draws = mine.filter(h => h.winner === '平局').length;
    const losses = mine.length - wins - draws;
    $('recordSummary').textContent = `共 ${mine.length} 局 · 胜 ${wins} · 负 ${losses} · 平 ${draws}`;
    const list = $('recordList');
    list.innerHTML = '';
    mine.slice(0, 20).forEach(h => {
      const div = document.createElement('div');
      const isWin = h.winner === me.name, isDraw = h.winner === '平局';
      div.className = 'record-item ' + (isWin ? 'rec-win' : isDraw ? 'rec-draw' : 'rec-lose');
      const opponent = (h.players || []).filter(p => p !== me.name).join(', ') || '—';
      const time = new Date(h.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      div.innerHTML = `<span class="res">${isWin ? '胜' : isDraw ? '平' : '负'}</span>` +
        ` vs ${opponent} · ${h.moves || '?'} 手` +
        ` <span class="time">${time}</span>`;
      list.appendChild(div);
    });
    if (!mine.length) list.innerHTML = '<p class="record-empty">还没有战绩, 快去下一局吧!</p>';
  }).catch(() => { $('recordSummary').textContent = '战绩加载失败, 请稍后再试'; });
}
$('recordBtn').addEventListener('click', () => { renderRecord(); $('recordModal').classList.remove('hidden'); });
$('recordClose').addEventListener('click', () => $('recordModal').classList.add('hidden'));
$('recordModal').addEventListener('click', e => { if (e.target === $('recordModal')) $('recordModal').classList.add('hidden'); });

function renderFriends() {
  const reqEl = $('friendReq'), listEl = $('friendList');
  reqEl.innerHTML = '';
  (me.requests || []).forEach(r => {
    const div = document.createElement('div');
    div.className = 'friend-item';
    div.innerHTML = `<span class="name">🙋 ${r.name} 请求加你为好友</span>`;
    const ok = document.createElement('button'); ok.textContent = '同意'; ok.className = 'primary';
    ok.onclick = () => oSend({ t: 'accept_friend', user: r.user });
    const no = document.createElement('button'); no.textContent = '拒绝';
    no.onclick = () => oSend({ t: 'decline_friend', user: r.user });
    div.appendChild(ok); div.appendChild(no);
    reqEl.appendChild(div);
  });
  listEl.innerHTML = '';
  (me.friends || []).forEach(f => {
    const div = document.createElement('div');
    div.className = 'friend-item';
    div.innerHTML = `<span class="dot ${f.online ? 'on' : ''}"></span><span class="name">${f.name}${f.online ? '' : ' (离线)'}</span>`;
    if (f.room) {
      const join = document.createElement('button'); join.textContent = `进房 ${f.room}`;
      join.onclick = () => oSend({ t: 'join', code: f.room, name: me.name || '玩家' });
      div.appendChild(join);
    } else {
      const inv = document.createElement('button'); inv.textContent = '邀请';
      inv.disabled = !activeRoom;
      inv.title = activeRoom ? '' : '先进房间再邀请';
      inv.onclick = () => oSend({ t: 'invite', user: f.user, code: activeRoom });
      div.appendChild(inv);
    }
    listEl.appendChild(div);
  });
}

function renderTabs(myrooms) {
  // 以本地 rooms 为准; myrooms 提供 myTurn 徽标数据
  const turnBy = {};
  if (myrooms) myrooms.forEach(r => { turnBy[r.code] = r.myTurn; });
  else {
    for (const [code, r] of rooms) {
      const s = r.state;
      turnBy[code] = s && !s.winner && !s.draw && s.turn === r.seat + 1 && (s.players || []).length === 2;
    }
  }
  tabsEl.innerHTML = '';
  for (const code of rooms.keys()) {
    const tab = document.createElement('button');
    tab.className = 'tab' + (code === activeRoom ? ' active' : '');
    tab.innerHTML = `#${code} ${turnBy[code] ? '<span class="badge">!</span>' : ''}`;
    tab.onclick = () => { activeRoom = code; renderTabs(null); renderActive(); };
    tabsEl.appendChild(tab);
  }
  updateResumeBtn();
}

// 大厅里的"回到对局"按钮: 退出对局视图(返回键/返回大厅)后, 对局仍在服务端继续, 由此随时回去
function updateResumeBtn() {
  const btn = $('resumeRoomsBtn');
  const showIt = mode === 'lobby' && rooms.size > 0;
  btn.classList.toggle('hidden', !showIt);
  if (showIt) {
    const code = activeRoom && rooms.has(activeRoom) ? activeRoom : [...rooms.keys()][0];
    btn.textContent = `▶ 回到对局 #${code}`;
  }
}

$('resumeRoomsBtn').addEventListener('click', () => {
  if (!rooms.size) return;
  if (!activeRoom || !rooms.has(activeRoom)) activeRoom = [...rooms.keys()][0];
  mode = 'game'; updateGameButtons(); ensurePush('game');
  show(gameEl); renderTabs(null); renderActive();
});

function updateGameButtons() {
  const online = mode === 'game';
  $('exitBtn').classList.toggle('hidden', !online);
  // 本地和在线都有"返回大厅"; 仅大厅里隐藏
  $('homeBtn').classList.toggle('hidden', mode === 'lobby');
  $('inviteBtn').classList.toggle('hidden', !(online && me.user));
  $('resetBtn').classList.toggle('hidden', false);
  chatLog.classList.toggle('hidden', !online);
  chatForm.classList.toggle('hidden', !online);
}

function renderActive() {
  const r = rooms.get(activeRoom);
  if (!r) { show(lobbyEl); return; }
  const s = r.state;
  const players = s.players || [];
  const myColor = r.seat === 0 ? BLACK : WHITE;
  let text;
  if (s.winner != null) {
    const iWin = s.winner === r.seat + 1;
    text = `胜者：${s.winnerName}（${stoneName(s.winner)}）${players.length === 2 && !players[1].bot ? (iWin ? ' 🎉 你赢了!' : ' 再接再厉!') : (iWin ? ' 🎉 你赢了!' : ' 输给 AI 了, 再来一局?')}`;
  } else if (s.draw) text = '平局';
  else if (players.length < 2) text = `房间 ${s.code} · 等待对手加入… (把房间号告诉朋友)`;
  else {
    const myTurn = s.turn === r.seat + 1;
    text = myTurn ? `轮到你了（${stoneName(myColor)}）` : `等待 ${players[s.turn - 1] ? players[s.turn - 1].name : '对手'} 落子…（${stoneName(s.turn)}）`;
  }
  setStatus(text);
  const locked = s.turn !== r.seat + 1 && !s.winner && !s.draw;
  renderBoard(s, locked);
  renderTabs(null);
}

function renderBoard(s, locked) {
  boardEl.innerHTML = '';
  const size = s ? s.size : local.board.length;
  boardEl.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
  const b = s ? s.board : local.board;
  const line = new Set(s && s.winLine ? s.winLine.map(x => `${x.row},${x.col}`) : []);
  const lm = s ? s.lastMove : local.last;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (line.has(`${r},${c}`)) cell.classList.add('win');
      const v = b ? b[r][c] : EMPTY;
      if (v !== EMPTY) {
        const stone = document.createElement('span');
        stone.className = `stone ${v === BLACK ? 'black' : 'white'}`;
        cell.appendChild(stone);
      }
      if (lm && lm.row === r && lm.col === c) cell.classList.add('last');
      cell.addEventListener('click', () => {
        if (s) { // 在线: 服务端权威判定
          if (!locked) oSend({ t: 'move', code: activeRoom, row: r, col: c });
        } else localMove(r, c);
      });
      boardEl.appendChild(cell);
    }
  }
}

function addChat(from, msg) {
  const p = document.createElement('p');
  if (!from) p.className = 'sys';
  p.textContent = from ? `${from}: ${msg}` : msg;
  chatLog.appendChild(p);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---------- 邀请 URL (?room=1234) ----------
let pendingRoom = null;
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) pendingRoom = urlRoom;

function applyPendingInvites() {
  if (pendingRoom && me.user) {
    const code = pendingRoom; pendingRoom = null;
    oSend({ t: 'join', code, name: me.name });
  }
}

// ================== 事件绑定 ==================
$('localBtn').addEventListener('click', () => {
  localStorage.setItem('gg_wzq_local_size', $('localSizeSel').value);
  mode = 'local';
  updateGameButtons();
  ensurePush('game');
  show(gameEl);
  localReset(true); // 有未结束的本地战局则继续
});

$('onlineBtn').addEventListener('click', () => { mode = 'online'; ensurePush('online'); show(onlineEl); });
$('backBtn').addEventListener('click', () => {
  if (history.state && history.state.view) history.back(); // 回退到上一视图(通常是玩法大厅)
  else applyView('lobby');
});

function createRoom(bot) {
  mode = 'game';
  updateGameButtons();
  ensurePush('game');
  show(gameEl);
  setStatus('正在创建房间…');
  oSend({ t: 'join', name: me.name || localStorage.getItem('gg_wzq_nick') || '玩家', size: Number($('sizeSel').value), bot });
}

$('createRoomBtn').addEventListener('click', () => createRoom(null));
$('botEasy').addEventListener('click', () => createRoom('easy'));
$('botMed').addEventListener('click', () => createRoom('medium'));
$('botHard').addEventListener('click', () => createRoom('hard'));

$('joinRoomBtn').addEventListener('click', () => {
  const code = $('codeInput').value.trim();
  if (!/^\d{4}$/.test(code)) { setErr('请输入 4 位房间号'); return; }
  mode = 'game';
  updateGameButtons();
  ensurePush('game');
  show(gameEl);
  setStatus('正在加入房间…');
  oSend({ t: 'join', code, name: me.name || localStorage.getItem('gg_wzq_nick') || '玩家' });
});

$('loginBtn').addEventListener('click', () => {
  const user = $('loginUser').value.trim(), pass = $('loginPass').value;
  if (!user || !pass) { setErr('请输入账号和密码'); return; }
  oSend({ t: 'login', user, pass });
});
$('regBtn').addEventListener('click', () => {
  const btn = $('regBtn');
  if ($('regName').classList.contains('hidden')) { // 第一次点: 展开昵称栏
    $('regName').classList.remove('hidden');
    btn.textContent = '确认注册';
    return;
  }
  const user = $('loginUser').value.trim(), pass = $('loginPass').value;
  const name = $('regName').value.trim();
  if (!user || !pass) { setErr('请输入账号和密码'); return; }
  oSend({ t: 'register', user, pass, name });
});
$('skipBtn').addEventListener('click', () => { $('loginBox').classList.add('hidden'); }); // 收起登录卡
function expandLoginBox() {
  $('lobbyLoginBtn').classList.add('hidden');
  $('loginBox').classList.remove('hidden');
  $('loginUser').focus();
}
$('showLoginBtn').addEventListener('click', expandLoginBox);
$('lobbyLoginBtn').addEventListener('click', expandLoginBox);
$('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('gg_wzq_token');
  localStorage.removeItem('gg_wzq_sids');
  localStorage.removeItem('gg_wzq_notify');
  localStorage.removeItem('gg_wzq_skip');
  me.user = null; me.name = null; me.token = null; me.friends = []; me.requests = [];
  renderUser();
  oSend({ t: 'logout' });
});

$('addFriendBtn').addEventListener('click', () => {
  const u = $('addFriendInput').value.trim();
  if (!u) return;
  oSend({ t: 'add_friend', user: u });
  $('addFriendInput').value = '';
});

$('notifyChk').addEventListener('change', async e => {
  const on = e.target.checked;
  localStorage.setItem('gg_wzq_notify', on ? '1' : '0');
  if (!on) return;
  if (!('Notification' in window) || !me.vapidPub) return;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const reg = await navigator.serviceWorker.register('sw.js');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: me.vapidPub });
    oSend({ t: 'push_sub', sub: sub.toJSON() });
    setErr('✅ 通知已开启');
  } catch (err) { setErr('⚠ 开启通知失败: ' + err.message); }
});

// 判断当前是否处于未结束的对局中 (退出前用于弹确认)
function inOngoingGame() {
  if (mode === 'local') return !local.over && local.board && local.board.some(row => row.some(v => v !== EMPTY));
  if (mode === 'game' && activeRoom) {
    const s = (rooms.get(activeRoom) || {}).state;
    return s && !s.winner && !s.draw && (s.players || []).length === 2;
  }
  return false;
}

$('resetBtn').addEventListener('click', () => {
  if (mode === 'online') { if (activeRoom) oSend({ t: 'reset', code: activeRoom }); }
  else if (confirm('确定重新开始吗? 当前本地战局将清空')) localReset(false);
});

$('exitBtn').addEventListener('click', () => {
  if (activeRoom) oSend({ t: 'leave', code: activeRoom });
});

$('homeBtn').addEventListener('click', () => {
  if (inOngoingGame() && !confirm('对局还未结束, 确定要退出吗?')) return;
  // 对局仍留在服务端, 只是视图回大厅; 用历史回退保持返回键行为一致
  if (history.state && history.state.view && history.state.view !== 'lobby') history.back();
  else { history.replaceState({ view: 'lobby' }, ''); applyView('lobby'); }
});

$('inviteBtn').addEventListener('click', () => {
  if (!activeRoom) return;
  const u = prompt('邀请哪位好友? 输入对方账号');
  if (u) oSend({ t: 'invite', user: u.trim(), code: activeRoom });
});

chatForm.addEventListener('submit', e => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !activeRoom) return;
  oSend({ t: 'chat', code: activeRoom, msg: text });
  chatInput.value = '';
});

// 手机浏览器从快照恢复(bfcache)时 DOM/连接可能已过期, 强制刷新重建
window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });

// ================== 启动 ==================
(function boot() {
  me.token = localStorage.getItem('gg_wzq_token');
  renderUser(); // 初始化顶栏与大厅 (未登录: 登录卡收起, 只显示小"登录"按钮)
  oConnect();
  // 建立历史基点: 返回键先在页面内逐级回退, 退无可退才离开本页
  history.replaceState({ view: 'lobby' }, '');
  // 首次进入: 有房号参数则直接进对局 (再按返回回到大厅, 可用"回到对局"按钮回去)
  if (pendingRoom) { show(gameEl), (mode = 'game'), updateGameButtons(); history.pushState({ view: 'game' }, ''); }
})();

renderBoard(null);
