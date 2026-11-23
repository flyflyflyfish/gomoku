'use strict';
// 果果五子棋 v3 · 服务端
// 架构参考「果果麻将」: express 静态托管 + ws 房间制 + sid 断线重连 + 战绩持久化
// 账号系统复用果果麻将 (只读挂载 accounts.json / secrets.json, 零风险):
//   - 登录/自动登录: 本地校验 (同样的 sha256(salt:pass) 与 token 机制)
//   - 注册/加好友/推送订阅 (需要写账号库): 通过 WS 中继到麻将服务端执行, 麻将永远是唯一写入方
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const G = require('./game.js');
const AI = require('./ai.js');

const PORT = process.env.PORT || 3000;
const NAME = '果果五子棋';
const MJ_WS_URL = process.env.MJ_WS_URL || 'ws://127.0.0.1:3000/mj-ws';

// ================= 果果麻将账号库 (只读) =================
// 每次读最新 (文件小、调用频率低); 麻将容器是唯一写入方
const ACC_PATH = path.join(__dirname, 'accounts.json');
function accounts() {
  try {
    const acc = JSON.parse(fs.readFileSync(ACC_PATH, 'utf8'));
    if (!acc.users) acc.users = {};
    return acc;
  } catch (e) {
    return { users: {} }; // 本地开发/测试无账号文件
  }
}
function hashPass(salt, pass) { return crypto.createHash('sha256').update(salt + ':' + pass).digest('hex'); }

// ================= 果果麻将 secrets (只读, VAPID 推送密钥) =================
const SECRETS_PATH = path.join(__dirname, 'secrets.json');
let SECRETS = {};
try { SECRETS = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')); } catch (e) {}
let webpush = null, VAPID = null;
try {
  webpush = require('web-push');
  if (SECRETS.vapid && SECRETS.vapid.pub && SECRETS.vapid.priv) {
    VAPID = SECRETS.vapid;
    webpush.setVapidDetails('mailto:gomoku@local', VAPID.pub, VAPID.priv);
  }
} catch (e) { console.error('[push] web-push 不可用', e.message); }

// 给离线用户推系统通知 (订阅来自果果麻将账号库, 与麻将共用一套推送)
function pushUser(user, title, body) {
  if (!webpush || !VAPID) return;
  const a = accounts().users[user];
  if (!a || !Array.isArray(a.pushSubs) || !a.pushSubs.length) return;
  const payload = JSON.stringify({ title, body });
  a.pushSubs.forEach(s => {
    webpush.sendNotification(s, payload).catch(() => {});
  });
}

// ================= 战绩持久化 =================
const HIST_PATH = path.join(__dirname, 'history.json');
let history = [];
try { history = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); if (!Array.isArray(history)) history = []; } catch (e) {}
function saveHist() {
  try { fs.writeFileSync(HIST_PATH, JSON.stringify(history.slice(-2000))); }
  catch (e) { console.error('保存战绩失败', e.message); }
}
function addHistory(rec) {
  history.push(Object.assign({ ts: Date.now() }, rec));
  saveHist();
}

// ================= 果果麻将 WS 中继 (注册/好友/推送订阅等需要写账号库的操作) =================
// 每次操作: 开临时 WS → (有 token 则先 auto_login) → 发操作 → 收结果 → 关闭
// 结果判定: auth_ok(注册成功路径) / info(操作回执) / friends(accept_friend 无 info 回执)
function relayMj(token, ops, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let ws, timer, settled = false, opSent = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} resolve(r); } };
    timer = setTimeout(() => done({ ok: false, msg: '果果麻将服务无响应, 请稍后再试' }), timeoutMs);
    try { ws = new WebSocket(MJ_WS_URL); } catch (e) { return done({ ok: false, msg: '无法连接果果麻将服务' }); }
    ws.on('error', () => done({ ok: false, msg: '无法连接果果麻将服务' }));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.t === 'auth_ok') {
        if (!opSent && ops.length) { ops.forEach(o => ws.send(JSON.stringify(o))); opSent = true; }
        else if (opSent) done({ ok: true, msg: '成功' }); // 注册流程: 麻将注册成功后直接回 auth_ok
        else done({ ok: true, msg: '登录成功' });
        return;
      }
      if (m.t === 'error') return done({ ok: false, msg: m.msg });
      if (m.t === 'info') return done({ ok: true, msg: m.msg });
      if (m.t === 'friends' && opSent) return done({ ok: true, msg: '成功' });
    });
    ws.on('open', () => {
      if (token) ws.send(JSON.stringify({ t: 'auto_login', token }));
      else { ops.forEach(o => ws.send(JSON.stringify(o))); opSent = true; }
    });
  });
}

// ================= 在线状态 / 好友视图 =================
const onlineUsers = new Map(); // user -> Set<ws> (gomoku 内在线)
const pendingInvites = new Map(); // user -> [{from, fromName, code, ts}] (内存, 10分钟有效)

function touchOnline(user, ws, add) {
  let set = onlineUsers.get(user);
  if (add) {
    if (!set) { set = new Set(); onlineUsers.set(user, set); }
    set.add(ws);
  } else if (set) {
    set.delete(ws);
    if (!set.size) onlineUsers.delete(user);
  }
  pushFriendsAll();
}

function userRoomsOf(user) {
  const out = [];
  for (const room of rooms.values()) {
    if (room.players.some(p => p.user === user && p.online)) out.push(room.code);
  }
  return out;
}

function friendsView(user) {
  const meAcc = accounts().users[user];
  if (!meAcc) return { friends: [], requests: [] };
  const view = list => (list || []).map(u => {
    const a = accounts().users[u];
    return a ? { user: u, name: a.name, online: onlineUsers.has(u), room: userRoomsOf(u)[0] || null } : null;
  }).filter(Boolean);
  return { friends: view(meAcc.friends), requests: view(meAcc.requests) };
}

// 推好友列表给所有在线连接 (登录/好友变动/上下线时)
function pushFriendsAll() {
  for (const [u, set] of onlineUsers) {
    const fv = friendsView(u);
    for (const ws of set) if (ws.readyState === 1) send(ws, { t: 'friends', ...fv });
  }
}

// ================= 房间 =================
const rooms = new Map();       // code -> room
const sidIndex = new Map();    // sid -> { code, seat }

const BOT_NAMES = { easy: '蓝色大肥鱼', medium: '豆包', hard: 'Z' };

function newCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function broadcast(room, obj) {
  for (const p of room.players) if (p.ws) send(p.ws, obj);
}

function roomView(room) {
  return {
    t: 'state',
    code: room.code,
    size: room.size,
    players: room.players.map(p => ({ name: p.name, online: !!p.ws, bot: !!p.bot, diff: p.diff || null })),
    turn: room.game ? room.game.turn : G.BLACK,
    board: room.game ? room.game.board : null,
    lastMove: room.game ? room.game.lastMove : null,
    winLine: room.game && room.game.winLine ? room.game.winLine : null,
    winner: room.game ? room.game.winner : null,
    winnerName: room.game && room.game.winnerName != null ? room.game.winnerName : null,
    draw: room.game ? !!room.game.draw : false,
    moves: room.game ? room.game.moves.length : 0,
  };
}

function syncRoom(room) {
  const view = roomView(room);
  room.players.forEach((p, seat) => { if (p.ws) send(p.ws, { ...view, seat }); });
  scheduleAI(room);
}

function myRoomsView(ws) {
  const list = [];
  for (const [code, ref] of ws._rooms) {
    const room = rooms.get(code);
    if (!room) { ws._rooms.delete(code); continue; }
    list.push({
      code, seat: ref.seat, size: room.size,
      players: room.players.map(p => p.name + (p.bot ? '(机器人)' : '')),
      moves: room.game ? room.game.moves.length : 0,
      myTurn: room.game && !room.game.winner && !room.game.draw && room.game.turn === ref.seat + 1,
    });
  }
  return list;
}

function pushMyRooms(ws) {
  if (ws.readyState === 1) send(ws, { t: 'myrooms', rooms: myRoomsView(ws) });
}

function createRoom(ws, name, size, bot) {
  const code = newCode();
  const room = { code, size: size || 15, players: [], game: null, timers: {} };
  rooms.set(code, room);
  joinRoom(room, ws, name);
  if (bot && DIFF_OK.has(bot)) {
    room.players.push({ name: BOT_NAMES[bot], bot: true, diff: bot, sid: null, ws: null, online: true, user: null });
    startGame(room);
    pushMyRooms(ws);
  }
  return room;
}

// 全员真人离线后房间保留 2 小时再清理
const ROOM_TTL = 2 * 60 * 60 * 1000;
function scheduleRoomCleanup(room) {
  clearTimeout(room.timers.cleanup);
  room.timers.cleanup = setTimeout(() => {
    if (!room.players.some(x => x.ws)) {
      rooms.delete(room.code);
      room.players.forEach(x => x.sid && sidIndex.delete(x.sid));
      console.log(`房间 ${room.code} 全员离线超过2小时, 已清理`);
    }
  }, ROOM_TTL);
}

function joinRoom(room, ws, name, resumedSid) {
  if (room.players.length >= 2 && !resumedSid) { send(ws, { t: 'error', msg: '房间已满(2人)' }); return false; }
  let sid, seat;
  if (resumedSid) {
    const idx = room.players.findIndex(p => p.sid === resumedSid);
    if (idx < 0 || room.players[idx].bot) { send(ws, { t: 'resume_fail', sid: resumedSid }); return false; }
    seat = idx; sid = resumedSid;
    room.players[seat].ws = ws;
    room.players[seat].online = true;
    clearTimeout(room.timers.cleanup);
  } else {
    sid = crypto.randomBytes(8).toString('hex');
    seat = room.players.length;
    room.players.push({ ws, name, sid, seat, online: true, user: ws._user || null, bot: false });
  }
  ws._rooms.set(room.code, { sid, seat });
  sidIndex.set(sid, { code: room.code, seat });
  send(ws, Object.assign(roomView(room), { t: 'welcome', code: room.code, sid, seat, size: room.size, resumed: !!resumedSid }));
  if (resumedSid) send(ws, { t: 'info', msg: '已重新连接, 对局继续' });
  if (!room.game && room.players.length === 2 && !resumedSid) startGame(room);
  else syncRoom(room);
  pushMyRooms(ws);
  return true;
}

function leaveSeat(room, seat, ws) {
  const p = room.players[seat];
  if (!p || p.ws !== ws) return;
  p.ws = null; p.online = false;
  send(ws, { t: 'bye', code: room.code });
  if (ws._rooms.get(room.code) && ws._rooms.get(room.code).sid === p.sid) ws._rooms.delete(room.code);
  sidIndex.delete(p.sid);
  p.sid = null;
  if (!room.players.some(x => x.ws)) scheduleRoomCleanup(room);
  syncRoom(room);
  pushMyRooms(ws);
}

// ================= 对局 =================
function startGame(room) {
  clearTimeout(room.timers.ai);
  room.game = {
    board: G.newBoard(room.size),
    turn: G.BLACK,
    moves: [],
    lastMove: null,
    winLine: null,
    winner: null,
    winnerName: null,
    draw: false,
  };
  syncRoom(room);
}

function doMove(room, seat, row, col) {
  const g = room.game;
  if (!g || g.winner != null || g.draw) return;
  if (g.turn !== seat + 1) return;
  if (row < 0 || row >= room.size || col < 0 || col >= room.size || g.board[row][col] !== G.EMPTY) return;

  const player = seat + 1;
  g.board[row][col] = player;
  g.moves.push({ row, col, player });
  g.lastMove = { row, col };

  const line = G.checkWin(g.board, row, col, player);
  if (line) {
    g.winLine = line;
    g.winner = player;
    g.winnerName = room.players[seat] ? room.players[seat].name : (player === G.BLACK ? '黑棋' : '白棋');
    addHistory({
      code: room.code,
      players: room.players.map(p => (p ? p.name + (p.bot ? '(AI)' : '') : '—')),
      winner: g.winnerName,
      moves: g.moves.length,
    });
    console.log(`房间 ${room.code}: ${g.winnerName} 胜 (${g.moves.length}手)`);
  } else if (G.isFull(g.board)) {
    g.draw = true;
    addHistory({ code: room.code, players: room.players.map(p => (p ? p.name : '—')), winner: '平局', moves: g.moves.length });
  } else {
    g.turn = G.other(player);
  }
  syncRoom(room);
}

// AI 走棋调度: 轮到机器人且对局进行中 → 延迟 0.8~1.6s 模拟思考
function scheduleAI(room) {
  const g = room.game;
  clearTimeout(room.timers.ai);
  if (!g || g.winner != null || g.draw) return;
  const p = room.players[g.turn - 1];
  if (!p || !p.bot) return;
  room.timers.ai = setTimeout(() => {
    const gg = room.game;
    if (!gg || gg.winner != null || gg.draw) return;
    if (gg.turn !== room.players.indexOf(p) + 1) return;
    const mv = AI.bestMove(gg.board, gg.turn, p.diff);
    if (mv) doMove(room, room.players.indexOf(p), mv.row, mv.col);
  }, 800 + Math.floor(Math.random() * 800));
}

// ================= HTTP =================
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size, online: onlineUsers.size }));
app.get('/api/history', (req, res) => {
  res.json({ name: NAME, total: history.length, recent: history.slice(-100).reverse() });
});
// 果果大厅用: token → 用户信息
app.post('/api/me', (req, res) => {
  const token = String((req.body && req.body.token) || '');
  const user = token && Object.keys(accounts().users).find(k => accounts().users[k].token === token);
  if (!user) return res.status(401).json({ error: '未登录' });
  res.json({ user, name: accounts().users[user].name });
});

const server = http.createServer(app);

// ================= WebSocket =================
const WS_PATHS = new Set(['/gmk-ws', '/ws']);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (!WS_PATHS.has(u.pathname)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

const DIFF_OK = new Set(['easy', 'medium', 'hard']);

function doAuthOk(ws, user) {
  const acc = accounts().users[user];
  if (!acc) return;
  ws._user = user;
  ws._token = acc.token;
  touchOnline(user, ws, true);
  send(ws, { t: 'auth_ok', user, name: acc.name, token: acc.token, vapidPub: VAPID ? VAPID.pub : null, ...friendsView(user) });
  // 送达排队中的对局邀请 (10分钟内有效)
  const now = Date.now();
  const pending = (pendingInvites.get(user) || []).filter(iv => now - iv.ts < 10 * 60 * 1000 && rooms.has(iv.code));
  pendingInvites.set(user, []);
  pending.forEach(iv => send(ws, { t: 'invite', from: iv.from, fromName: iv.fromName, code: iv.code }));
}

function handle(ws, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  switch (msg.t) {
    // ---- 登录 (本地校验, 只读账号库) ----
    case 'login': {
      const user = String(msg.user || '').trim();
      const a = accounts().users[user];
      if (!a || a.pass !== hashPass(a.salt, String(msg.pass || ''))) return send(ws, { t: 'error', msg: '账号或密码错误' });
      doAuthOk(ws, user);
      break;
    }
    case 'auto_login': {
      const user = Object.keys(accounts().users).find(k => accounts().users[k].token === msg.token);
      if (user) doAuthOk(ws, user);
      else send(ws, { t: 'auth_fail' });
      break;
    }
    case 'logout': {
      if (ws._user) touchOnline(ws._user, ws, false);
      ws._user = null;
      send(ws, { t: 'logged_out' });
      break;
    }
    // ---- 注册 (写入账号库 → 中继到果果麻将执行) ----
    case 'register': {
      const user = String(msg.user || '').trim();
      const pass = String(msg.pass || '');
      const name = (String(msg.name || '').trim() || user).slice(0, 8);
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(user)) return send(ws, { t: 'error', msg: '账号需 2-16 位(中文/字母/数字/下划线)' });
      if (pass.length < 4) return send(ws, { t: 'error', msg: '密码至少 4 位' });
      relayMj(null, [{ t: 'register', user, pass, name }]).then(r => {
        if (!r.ok) return send(ws, { t: 'error', msg: r.msg });
        doAuthOk(ws, user);
      });
      break;
    }
    // ---- 好友操作 (写账号库 → 中继) ----
    case 'add_friend':
    case 'accept_friend':
    case 'decline_friend': {
      if (!ws._user || !ws._token) return send(ws, { t: 'error', msg: '请先登录' });
      const op = { t: msg.t, user: String(msg.user || '') };
      relayMj(ws._token, [op]).then(r => {
        if (!r.ok) return send(ws, { t: 'error', msg: r.msg });
        send(ws, { t: 'info', msg: r.msg && r.msg !== '成功' ? r.msg : '操作成功' });
        pushFriendsAll();
      });
      break;
    }
    // ---- 浏览器推送订阅 (写账号库 → 中继, 与麻将共用一套推送) ----
    case 'push_sub': {
      if (!ws._user || !ws._token) return;
      const sub = msg.sub;
      if (!sub || !sub.endpoint) return;
      relayMj(ws._token, [{ t: 'push_sub', sub }]).catch(() => {});
      break;
    }
    // ---- 进房/重连 ----
    case 'join': {
      if (typeof msg.name !== 'string' || !msg.name.trim()) return send(ws, { t: 'error', msg: '请输入昵称' });
      const name = ws._user ? accounts().users[ws._user].name : msg.name.trim().slice(0, 12);
      const size = G.SIZES.includes(Number(msg.size)) ? Number(msg.size) : 15;
      const code = String(msg.code || '').trim();
      if (code) {
        const room = rooms.get(code);
        if (!room) return send(ws, { t: 'error', msg: `房间 ${code} 不存在或已过期` });
        joinRoom(room, ws, name);
      } else {
        createRoom(ws, name, size, msg.bot);
      }
      break;
    }
    case 'resume': {
      const sid = String(msg.sid || '');
      if ([...ws._rooms.values()].some(r => r.sid === sid)) return;
      const ref = sid && sidIndex.get(sid);
      if (!ref) return send(ws, { t: 'resume_fail', sid: msg.sid });
      const room = rooms.get(ref.code);
      if (!room) { sidIndex.delete(String(msg.sid)); return send(ws, { t: 'resume_fail', sid: msg.sid }); }
      joinRoom(room, ws, null, String(msg.sid));
      break;
    }
    // ---- 房间内操作 (带 code, 支持一连接多房) ----
    case 'move': {
      const code = String(msg.code);
      const ref = ws._rooms.get(code);
      if (!ref) return;
      const room = rooms.get(code);
      if (!room) return;
      const row = Number(msg.row), col = Number(msg.col);
      if (!Number.isInteger(row) || !Number.isInteger(col)) return;
      doMove(room, ref.seat, row, col);
      break;
    }
    case 'reset': {
      const code = String(msg.code);
      if (!ws._rooms.has(code)) return;
      const room = rooms.get(code);
      if (room && room.game) startGame(room);
      break;
    }
    case 'leave': {
      const code = String(msg.code);
      const ref = ws._rooms.get(code);
      if (!ref) return;
      const room = rooms.get(code);
      if (room) leaveSeat(room, ref.seat, ws);
      break;
    }
    case 'chat': {
      const code = String(msg.code);
      const ref = ws._rooms.get(code);
      if (!ref) return;
      const room = rooms.get(code);
      if (!room) return;
      const text = String(msg.msg || '').trim().slice(0, 100);
      if (!text) return;
      const p = room.players[ref.seat];
      broadcast(room, { t: 'chat', from: p ? p.name : '玩家', msg: text });
      break;
    }
    // ---- 好友邀请 ----
    case 'invite': {
      if (!ws._user) return send(ws, { t: 'error', msg: '请先登录' });
      const target = String(msg.user || '');
      const myRef = [...ws._rooms.values()][0];
      const code = String(msg.code || (myRef && myRef.code) || '');
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', msg: '请先进一个房间再邀请' });
      const myAcc = accounts().users[ws._user];
      const targetAcc = accounts().users[target];
      if (!targetAcc) return send(ws, { t: 'error', msg: '没有这个账号' });
      const tset = onlineUsers.get(target);
      if (!tset || !tset.size) {
        // 不在线: 排队 10 分钟 + web 推送 (与麻将同一套推送通道)
        const list = (pendingInvites.get(target) || []).filter(iv => Date.now() - iv.ts < 10 * 60 * 1000);
        list.push({ from: ws._user, fromName: myAcc.name, code, ts: Date.now() });
        pendingInvites.set(target, list.slice(-5));
        pushUser(target, `${NAME} · 对局邀请`, `${myAcc.name} 邀请你加入房间 ${code}, 点此进入`);
        return send(ws, { t: 'info', msg: `${targetAcc.name} 暂时不在线, 邀请已保存, 上线会立即收到` });
      }
      for (const tws of tset) send(tws, { t: 'invite', from: ws._user, fromName: myAcc.name, code });
      send(ws, { t: 'info', msg: `已向 ${targetAcc.name} 发出邀请` });
      break;
    }
    case 'accept_invite': {
      const room = rooms.get(String(msg.code || ''));
      if (!room) return send(ws, { t: 'error', msg: '房间已过期' });
      const name = ws._user ? accounts().users[ws._user].name : '玩家';
      joinRoom(room, ws, name);
      break;
    }
    default:
      send(ws, { t: 'error', msg: '未知指令' });
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws._rooms = new Map(); // code -> {sid, seat}
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) { console.error(e); send(ws, { t: 'error', msg: '服务器内部错误' }); }
  });
  ws.on('close', () => {
    if (ws._user) touchOnline(ws._user, ws, false);
    const heldRooms = [...ws._rooms.keys()];
    ws._rooms = new Map();
    for (const code of heldRooms) {
      const room = rooms.get(code);
      if (!room) continue;
      const p = room.players.find(x => x && !x.bot && x.ws === ws);
      if (p) {
        p.ws = null; p.online = false;
        if (room.players.filter(x => x.ws).length === 0) scheduleRoomCleanup(room);
        syncRoom(room);
      }
    }
  });
});

// 心跳: 30s 清理僵尸连接
const HEARTBEAT = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping(() => {});
  }
}, 30000);
wss.on('close', () => clearInterval(HEARTBEAT));

server.listen(PORT, () => console.log(`${NAME} v3 服务已启动, 端口 ${PORT}, 麻将中继: ${MJ_WS_URL}`));
