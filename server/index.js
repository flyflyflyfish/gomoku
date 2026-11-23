'use strict';
// 果果五子棋 · 服务端
// 架构参考「果果麻将」(family-mahjong): express 静态托管 + ws 房间制 + sid 断线重连 + JSON 文件持久化
// 权威判定: 落子一律由服务端校验, 客户端只渲染
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game.js');

const PORT = process.env.PORT || 3000;
const NAME = '果果五子棋';

// ================= 战绩持久化 =================
// 参考麻将 history.json: 只留最近 2000 局, 写失败不影响对局
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

// ================= 房间 =================
const rooms = new Map();          // code -> room
const sidIndex = new Map();       // sid -> { code, seat }

function newCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function broadcast(room, obj) {
  for (const p of room.players) send(p.ws, obj);
}

// 房间公开状态 (发给所有人的公共部分)
function roomView(room) {
  return {
    t: 'state',
    code: room.code,
    players: room.players.map(p => ({ name: p.name, online: !!p.ws })),
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
  room.players.forEach((p, seat) => send(p.ws, Object.assign({}, view, { seat })));
}

function createRoom(ws, name) {
  const code = newCode();
  const room = { code, players: [], game: null, timers: {} };
  rooms.set(code, room);
  joinRoom(room, ws, name);
  return room;
}

// 全员离线后房间保留 2 小时再清理 (参考麻将 ROOM_TTL)
const ROOM_TTL = 2 * 60 * 60 * 1000;
function scheduleRoomCleanup(room) {
  clearTimeout(room.timers.cleanup);
  room.timers.cleanup = setTimeout(() => {
    if (!room.players.some(x => x.ws)) {
      rooms.delete(room.code);
      room.players.forEach(x => sidIndex.delete(x.sid));
      console.log(`房间 ${room.code} 全员离线超过2小时, 已清理`);
    }
  }, ROOM_TTL);
}

function joinRoom(room, ws, name, resumedSid) {
  if (room.players.length >= 2 && !resumedSid) { send(ws, { t: 'error', msg: '房间已满(2人)' }); return; }
  let sid, seat;
  if (resumedSid) {
    // 断线重连: 找回原座位
    const idx = room.players.findIndex(p => p.sid === resumedSid);
    if (idx < 0) { send(ws, { t: 'error', msg: '会话已失效, 请重新加入房间' }); return; }
    seat = idx;
    sid = resumedSid;
    room.players[seat].ws = ws;
    room.players[seat].online = true;
    clearTimeout(room.timers.cleanup);
  } else {
    sid = crypto.randomBytes(8).toString('hex');
    seat = room.players.length;
    room.players.push({ ws, name, sid, seat, online: true });
  }
  ws._sid = sid;
  ws._code = room.code;
  sidIndex.set(sid, { code: room.code, seat });
  send(ws, Object.assign(roomView(room), { t: 'welcome', code: room.code, sid, seat, resumed: !!resumedSid }));
  if (resumedSid) send(ws, { t: 'info', msg: '已重新连接, 对局继续' });
  // 第二个人进房 → 自动开局
  if (!room.game && room.players.length === 2 && !resumedSid) startGame(room);
  else syncRoom(room);
}

function leaveSeat(room, seat, ws) {
  const p = room.players[seat];
  if (!p || p.ws !== ws) return;
  p.ws = null;
  p.online = false;
  send(ws, { t: 'bye' });
  ws._sid = null; ws._code = null;
  sidIndex.delete(p.sid);
  if (room.players.filter(x => x.ws).length === 0) scheduleRoomCleanup(room);
  syncRoom(room);
}

// ================= 对局 =================
function startGame(room) {
  room.game = {
    board: G.newBoard(),
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

// 服务端权威落子: 校验回合/位置, 非法直接拒绝
function doMove(room, seat, row, col) {
  const g = room.game;
  if (!g) return send(room.players[seat] && room.players[seat].ws, { t: 'error', msg: '对局未开始' });
  if (g.winner != null || g.draw) return;
  if (g.turn !== seat + 1) return send(room.players[seat] && room.players[seat].ws, { t: 'error', msg: '还没轮到你' });
  if (row < 0 || row >= G.SIZE || col < 0 || col >= G.SIZE || g.board[row][col] !== G.EMPTY)
    return send(room.players[seat] && room.players[seat].ws, { t: 'error', msg: '此处不能落子' });

  const player = seat + 1; // 座位0=黑, 座位1=白
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
      players: room.players.map(p => (p ? p.name : '—')),
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

function rematch(room) {
  if (!room.game) return;
  startGame(room);
}

// ================= HTTP =================
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// 战绩接口 (只读, 最近 100 条)
app.get('/api/history', (req, res) => {
  res.json({ name: NAME, total: history.length, recent: history.slice(-100).reverse() });
});
app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);

// ================= WebSocket =================
// 兼容反代路径: nginx 会把 /gmk-ws 原样转发过来, 直连时用 /ws
const WS_PATHS = new Set(['/gmk-ws', '/ws']);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (!WS_PATHS.has(u.pathname)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    // ---- 进房/重连 (未绑定 sid 时唯一可用指令) ----
    if (msg.t === 'join') {
      if (ws._sid) return send(ws, { t: 'error', msg: '你已在房间中' });
      const name = String(msg.name || '').trim().slice(0, 12) || '无名玩家';
      const code = String(msg.code || '').trim();
      if (code) {
        const room = rooms.get(code);
        if (!room) return send(ws, { t: 'error', msg: `房间 ${code} 不存在或已过期` });
        joinRoom(room, ws, name);
      } else {
        createRoom(ws, name);
      }
      return;
    }
    if (msg.t === 'resume') {
      if (ws._sid) return;
      const ref = msg.sid && sidIndex.get(String(msg.sid));
      if (!ref) return send(ws, { t: 'resume_fail' });
      const room = rooms.get(ref.code);
      if (!room) { sidIndex.delete(String(msg.sid)); return send(ws, { t: 'resume_fail' }); }
      joinRoom(room, ws, null, String(msg.sid));
      return;
    }

    // ---- 以下指令都要求已在房间 ----
    const ref = ws._sid ? sidIndex.get(ws._sid) : null;
    if (!ref) return send(ws, { t: 'error', msg: '请先加入房间' });
    const room = rooms.get(ref.code);
    if (!room) { sidIndex.delete(ws._sid); return send(ws, { t: 'error', msg: '房间已解散' }); }

    switch (msg.t) {
      case 'move': {
        const row = Number(msg.row), col = Number(msg.col);
        if (!Number.isInteger(row) || !Number.isInteger(col)) return;
        doMove(room, ref.seat, row, col);
        break;
      }
      case 'reset': {
        // 任意一方可发起重开 (开局前/结束后均有效)
        rematch(room);
        break;
      }
      case 'leave': {
        leaveSeat(room, ref.seat, ws);
        break;
      }
      case 'chat': {
        const text = String(msg.msg || '').trim().slice(0, 100);
        if (!text) return;
        const p = room.players[ref.seat];
        broadcast(room, { t: 'chat', from: p ? p.name : '玩家', msg: text });
        break;
      }
      default:
        send(ws, { t: 'error', msg: '未知指令' });
    }
  });

  ws.on('close', () => {
    const ref = ws._sid ? sidIndex.get(ws._sid) : null;
    if (!ref) return;
    const room = rooms.get(ref.code);
    if (!room) return;
    const p = room.players[ref.seat];
    if (p && p.ws === ws) {
      p.ws = null; p.online = false;
      // sid 保留在 sidIndex 中, 供断线重连 (离开房间或房间清理时才删除)
      ws._sid = null; ws._code = null;
      if (room.players.filter(x => x.ws).length === 0) scheduleRoomCleanup(room);
      syncRoom(room);
    }
  });
});

// 心跳: 30s 清一次死连接 (参考麻将, 保证在线状态准确)
const HEARTBEAT = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping(() => {});
  }
}, 30000);
wss.on('close', () => clearInterval(HEARTBEAT));

server.listen(PORT, () => console.log(`${NAME} 服务已启动, 端口 ${PORT}`));
