// 果果五子棋 · 前端
// 两种模式: 本地对战(纯前端, 原版保留) / 在线对战(WebSocket, 服务端权威判定)
'use strict';

const SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

// ================== DOM ==================
const $ = id => document.getElementById(id);
const lobbyEl = $('lobby'), onlineEl = $('onlinePanel'), gameEl = $('gameArea');
const boardEl = $('board'), statusEl = $('status');
const resetBtn = $('resetBtn'), exitBtn = $('exitBtn');
const chatLog = $('chatLog'), chatForm = $('chatForm'), chatInput = $('chatInput');

function show(el) { [lobbyEl, onlineEl, gameEl].forEach(x => x.classList.add('hidden')); el.classList.remove('hidden'); }

// ================== 模式一: 本地对战 (原版逻辑) ==================
const local = { board: null, current: BLACK, over: false, mode: 'lobby', winLine: null, last: null };

function localReset() {
  local.board = Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
  local.current = BLACK;
  local.over = false;
  local.winLine = null;
  local.last = null;
  setStatus(`当前回合：黑棋 ●`);
  render();
}

function localCount(r, c, dr, dc, p) {
  let n = 0;
  r += dr; c += dc;
  while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && local.board[r][c] === p) { n++; r += dr; c += dc; }
  return n;
}

function localWin(r, c, p) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    if (1 + localCount(r, c, dr, dc, p) + localCount(r, c, -dr, -dc, p) >= 5) return true;
  }
  return false;
}

function localMove(r, c) {
  if (local.over || local.board[r][c] !== EMPTY) return;
  local.board[r][c] = local.current;
  local.last = { row: r, col: c };
  if (localWin(r, c, local.current)) {
    local.over = true;
    setStatus(`胜者：${local.current === BLACK ? '黑棋 ●' : '白棋 ○'} 🎉`);
  } else if (local.board.every(row => row.every(v => v !== EMPTY))) {
    local.over = true;
    setStatus('平局');
  } else {
    local.current = local.current === BLACK ? WHITE : BLACK;
    setStatus(`当前回合：${local.current === BLACK ? '黑棋 ●' : '白棋 ○'}`);
  }
  render();
}

// ================== 模式二: 在线对战 ==================
const online = { ws: null, sid: null, code: null, seat: -1, state: null, name: '', connected: false, reconnectTimer: null, wantResume: false };

function wsUrl() {
  // 支持反代路径: 页面在 /gmk/ 下 → ws 走同源 /gmk-ws; 本地直跑 → /ws
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return `${proto}${location.host}/gmk-ws`;
}

function oConnect() {
  try { online.ws = new WebSocket(wsUrl()); } catch (e) { return; }
  online.ws.onopen = () => {
    online.connected = true;
    if (online.wantResume && online.sid) {
      online.ws.send(JSON.stringify({ t: 'resume', sid: online.sid }));
    } else {
      online.ws.send(JSON.stringify({ t: 'join', name: online.name, code: online.code || '' }));
    }
  };
  online.ws.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    handleOnlineMsg(m);
  };
  online.ws.onclose = () => {
    online.connected = false;
    if (online.mode === 'online') {
      setStatus('⚠ 连接断开, 正在重连…');
      // 参考麻将: 房间保留 2 小时, 期间自动重连续局
      clearTimeout(online.reconnectTimer);
      online.reconnectTimer = setTimeout(oConnect, 2000);
    }
  };
}

function handleOnlineMsg(m) {
  switch (m.t) {
    case 'welcome': {
      online.sid = m.sid;
      online.code = m.code;
      online.seat = m.seat;
      online.wantResume = true;
      localStorage.setItem('gg_wzq_sid', m.sid);
      localStorage.setItem('gg_wzq_code', m.code);
      localStorage.setItem('gg_wzq_name', online.name);
      show(gameEl);
      $('backBtn').classList.add('hidden');
      exitBtn.classList.remove('hidden');
      chatLog.classList.remove('hidden');
      chatForm.classList.remove('hidden');
      chatLog.innerHTML = '';
      addChat(null, `房间号 ${m.code}, 把它告诉朋友吧${m.resumed ? '(已重连)' : ''}`);
      setStatus('等待对手加入…');
      renderOnline(m);
      break;
    }
    case 'state': {
      online.state = m;
      online.seat = m.seat;
      renderOnline(m);
      break;
    }
    case 'chat': addChat(m.from, m.msg); break;
    case 'resume_fail': {
      online.wantResume = false;
      online.sid = null;
      localStorage.removeItem('gg_wzq_sid');
      localStorage.removeItem('gg_wzq_code');
      show(onlineEl);
      break;
    }
    case 'error': {
      if (online.sid == null && !online.wantResume) alert(m.msg);
      else setStatus(`⚠ ${m.msg}`);
      break;
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

function stoneName(p) { return p === BLACK ? '黑棋 ●' : '白棋 ○'; }

function renderOnline(s) {
  const board = s.board || Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
  const players = s.players || [];
  const myColor = online.seat === 0 ? BLACK : WHITE;
  let text;
  if (s.winner != null) {
    const iWin = s.winner === online.seat + 1;
    text = `胜者：${s.winnerName}（${stoneName(s.winner)}）${players.length === 2 ? (iWin ? ' 🎉 你赢了!' : ' 再接再厉!') : ''}`;
  } else if (s.draw) {
    text = '平局';
  } else if (players.length < 2) {
    text = `房间 ${s.code} · 等待对手加入… (把房间号告诉朋友)`;
  } else {
    const myTurn = s.turn === online.seat + 1;
    const opp = players[1 - online.seat];
    text = myTurn ? `轮到你了（${stoneName(myColor)}）` : `等待对手 ${opp ? opp.name : ''} 落子…（${stoneName(s.turn)}）`;
  }
  setStatus(text);
  render(board, s.lastMove, s.winLine, s.turn !== online.seat + 1 && !s.winner && !s.draw && players.length === 2);
}

// ================== 统一渲染 ==================
function setStatus(text) { statusEl.textContent = text; }

function render(board, last, winLine, locked) {
  boardEl.innerHTML = '';
  const b = board || local.board;
  const line = new Set(winLine ? winLine.map(x => `${x.row},${x.col}`) : []);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (line.has(`${r},${c}`)) cell.classList.add('win');
      const v = b[r][c];
      if (v !== EMPTY) {
        const stone = document.createElement('span');
        stone.className = `stone ${v === BLACK ? 'black' : 'white'}`;
        cell.appendChild(stone);
      }
      const lm = board ? last : local.last;
      if (lm && lm.row === r && lm.col === c) cell.classList.add('last');
      cell.addEventListener('click', () => {
        if (board) { // 在线模式: 发给服务端, 由服务端判定
          if (!locked && online.ws && online.ws.readyState === 1)
            online.ws.send(JSON.stringify({ t: 'move', row: r, col: c }));
        } else {
          localMove(r, c);
        }
      });
      boardEl.appendChild(cell);
    }
  }
}

// ================== 事件绑定 ==================
$('localBtn').addEventListener('click', () => {
  online.mode = 'local';
  local.mode = 'local';
  resetBtn.classList.remove('hidden');
  exitBtn.classList.add('hidden');
  chatLog.classList.add('hidden');
  chatForm.classList.add('hidden');
  show(gameEl);
  localReset();
});

$('onlineBtn').addEventListener('click', () => {
  online.mode = 'online';
  local.mode = 'lobby';
  $('nameInput').value = localStorage.getItem('gg_wzq_name') || '';
  show(onlineEl);
});

$('backBtn').addEventListener('click', () => show(lobbyEl));

$('createRoomBtn').addEventListener('click', () => {
  online.name = $('nameInput').value.trim();
  online.code = '';
  online.wantResume = false;
  localStorage.setItem('gg_wzq_name', online.name);
  oConnect();
});

$('joinRoomBtn').addEventListener('click', () => {
  const code = $('codeInput').value.trim();
  if (!/^\d{4}$/.test(code)) { alert('请输入 4 位房间号'); return; }
  online.name = $('nameInput').value.trim();
  online.code = code;
  online.wantResume = false;
  localStorage.setItem('gg_wzq_name', online.name);
  oConnect();
});

resetBtn.addEventListener('click', () => {
  if (online.mode === 'online') {
    if (online.ws && online.ws.readyState === 1) online.ws.send(JSON.stringify({ t: 'reset' }));
  } else {
    localReset();
  }
});

exitBtn.addEventListener('click', () => {
  if (online.ws) { try { online.ws.send(JSON.stringify({ t: 'leave' })); online.ws.close(); } catch (e) {} }
  online.mode = 'lobby';
  online.wantResume = false;
  online.sid = null;
  localStorage.removeItem('gg_wzq_sid');
  localStorage.removeItem('gg_wzq_code');
  show(lobbyEl);
});

chatForm.addEventListener('submit', e => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  if (online.ws && online.ws.readyState === 1) online.ws.send(JSON.stringify({ t: 'chat', msg: text }));
  chatInput.value = '';
});

// 页面打开时自动重连上次房间 (刷新/切后台回来续局)
(function autoResume() {
  const sid = localStorage.getItem('gg_wzq_sid');
  const name = localStorage.getItem('gg_wzq_name') || '';
  if (sid && name) {
    online.sid = sid;
    online.code = localStorage.getItem('gg_wzq_code');
    online.name = name;
    online.wantResume = true;
    online.mode = 'online';
    oConnect();
  }
})();

render();
