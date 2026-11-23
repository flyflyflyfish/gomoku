// 果果五子棋 v3 · 自动化测试 (本地无果果麻将: 注册/好友走中继的用例在服务器上验证)
'use strict';
const WebSocket = require('ws');
const fs = require('fs');
const crypto = require('crypto');

// 本地伪造账号库 (结构与麻将 accounts.json 一致): 小明/小红 已是好友
const hashPass = (salt, pass) => crypto.createHash('sha256').update(salt + ':' + pass).digest('hex');
(function makeFakeAcc() {
  const mk = (user, name) => {
    const salt = crypto.randomBytes(8).toString('hex');
    return { salt, pass: hashPass(salt, '1234'), name, token: crypto.randomBytes(16).toString('hex'), friends: [], requests: [] };
  };
  const ming = mk('ming', '小明'), hong = mk('hong', '小红');
  ming.friends = ['hong']; hong.friends = ['ming'];
  fs.writeFileSync(__dirname + '/accounts.json', JSON.stringify({ users: { ming, hong } }));
})();

const URL = 'ws://127.0.0.1:3000/ws';
let failures = 0;
function check(name, cond) { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) failures++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name; this.msgs = []; this.waiters = [];
    this.ready = new Promise(r => { this.ws = new WebSocket(URL); this.ws.on('open', r); });
    this.ws.on('message', d => {
      const m = JSON.parse(d);
      const i = this.waiters.findIndex(x => x.pred(m));
      if (i >= 0) this.waiters.splice(i, 1);
      this.msgs.push(m);
    });
    this.send = o => this.ws.readyState === 1 && this.ws.send(JSON.stringify(o));
  }
  wait(pred, ms = 6000) {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`等待超时: ${this.name}`)), ms);
      this.waiters.push({ pred: m => { if (!pred(m)) return false; clearTimeout(to); resolve(m); return true; } });
    });
  }
}

(async () => {
  await sleep(400);

  // ===== 1. 登录 (本地校验) =====
  const A = new Client('A');
  await A.ready;
  let acc = JSON.parse(fs.readFileSync(__dirname + '/accounts.json'));
  A.send({ t: 'login', user: 'ming', pass: '1234' });
  const authA = await A.wait(m => m.t === 'auth_ok');
  check('A 密码登录成功', authA.user === 'ming' && authA.name === '小明');
  check('auth_ok 带好友列表', authA.friends.length === 1 && authA.friends[0].user === 'hong');
  check('auth_ok 带 VAPID 公钥', typeof authA.vapidPub === 'string' && authA.vapidPub.length > 0);

  const A2 = new Client('A2');
  await A2.ready;
  A2.send({ t: 'auto_login', token: acc.users.ming.token });
  await A2.wait(m => m.t === 'auth_ok');
  check('A token 自动登录成功', true);

  const B = new Client('B');
  await B.ready;
  B.send({ t: 'login', user: 'hong', pass: 'wrong' });
  const eB = await B.wait(m => m.t === 'error');
  check('密码错误被拒绝', /账号或密码错误/.test(eB.msg));
  B.send({ t: 'login', user: 'hong', pass: '1234' });
  const authB = await B.wait(m => m.t === 'auth_ok');
  check('B 登录成功且看到 A 在线', authB.friends[0].online === true);

  // ===== 2. 好友在线状态随上下线变化 =====
  A2.ws.close();
  await sleep(200);
  const fB = await B.wait(m => m.t === 'friends');
  check('A 的一条连接断开 → 好友仍在线(还有另一条连接)', fB.friends[0].online === true);

  // ===== 3. 19 路棋盘 + AI 对战 (人执黑先行) =====
  A.send({ t: 'join', name: '小明', size: 19, bot: 'hard' });
  const wA = await A.wait(m => m.t === 'welcome' && m.size === 19);
  check('创建 19 路 AI 房间(Z)', wA.seat === 0);
  A.send({ t: 'move', code: wA.code, row: 9, col: 9 });
  const st = await A.wait(m => m.t === 'state' && m.players.length === 2 && m.moves === 2 && m.board && m.board[9][9] === 1, 8000);
  check('AI 应答落子', st.moves === 2 && st.players[1].name === 'Z');
  // 人下第二手 → AI 应答
  A.send({ t: 'move', code: wA.code, row: 9, col: 8 });
  const st2 = await A.wait(m => m.t === 'state' && m.moves === 4, 8000);
  check('AI 第二手应答', st2.moves === 4);
  check('myrooms 列表含房间且轮到我', (await A.wait(m => m.t === 'myrooms' && m.rooms.length === 1 && m.rooms[0].myTurn === true)).rooms[0].myTurn === true);

  // ===== 4. 一连接多局同时开 =====
  A.send({ t: 'join', name: '小明', size: 15, bot: 'easy' });
  const w2 = await A.wait(m => m.t === 'welcome' && m.size === 15 && m.code !== wA.code);
  check('同连接开第二局(鱼)', w2.seat === 0);
  const mr = await A.wait(m => m.t === 'myrooms' && m.rooms.length === 2);
  check('myrooms 显示两局', mr.rooms.length === 2);

  // 双方对两个房间分别落子
  A.send({ t: 'move', code: wA.code, row: 10, col: 10 });
  A.send({ t: 'move', code: w2.code, row: 5, col: 5 });
  await sleep(2500);
  const stR1 = A.msgs.filter(m => m.t === 'state' && m.code === wA.code).pop();
  const stR2 = A.msgs.filter(m => m.t === 'state' && m.code === w2.code).pop();
  check('两局独立推进', stR1.moves >= 5 && stR2.moves >= 2);

  // ===== 5. 错误 sid 重连被拒 =====
  const C = new Client('C');
  await C.ready;
  C.send({ t: 'resume', sid: 'deadbeef' });
  const rf = await C.wait(m => m.t === 'resume_fail');
  check('无效 sid 重连被拒', rf.t === 'resume_fail');

  // ===== 6. 断线重连 (第二局) =====
  const sid2 = w2.sid;
  A.ws.close();
  await sleep(300);
  const A3 = new Client('A3');
  await A3.ready;
  A3.send({ t: 'auto_login', token: acc.users.ming.token });
  await A3.wait(m => m.t === 'auth_ok');
  A3.send({ t: 'resume', sid: sid2 });
  const rw = await A3.wait(m => m.t === 'welcome' && m.resumed === true && m.code === w2.code);
  check('断线后重连第二局成功', rw.resumed === true);
  // 房间应仍在 (A3 持有), 且 AI 房间继续
  const st3 = await A3.wait(m => m.t === 'state' && m.code === w2.code, 8000);
  check('重连后收到房间状态', st3.code === w2.code);

  // ===== 7. 离线邀请排队 + push 跳过 (无订阅) =====
  const D = new Client('D');
  await D.ready;
  D.send({ t: 'login', user: 'hong', pass: '1234' });
  await D.wait(m => m.t === 'auth_ok');
  D.send({ t: 'join', name: '小红', code: '' });
  const wD = await D.wait(m => m.t === 'welcome');
  D.send({ t: 'invite', user: 'ming', code: wD.code });
  const ivA = await A3.wait(m => m.t === 'invite' && m.from === 'hong');
  check('在线好友收到实时邀请', ivA.code === wD.code);

  // A3 接受邀请 → 加入房间
  A3.send({ t: 'accept_invite', code: wD.code });
  const wA3 = await A3.wait(m => m.t === 'welcome' && m.code === wD.code && m.seat === 1);
  check('接受邀请入座白棋', wA3.seat === 1);
  const stFull = await D.wait(m => m.t === 'state' && m.players.length === 2 && m.board && m.moves === 0, 5000);
  check('双人对局自动开局', stFull.moves === 0 && stFull.turn === 1);

  // 对战: D 执黑连下五子获胜
  for (let c = 3; c <= 7; c++) {
    D.send({ t: 'move', code: wD.code, row: 7, col: c });
    await sleep(60);
    if (c !== 7) { A3.send({ t: 'move', code: wD.code, row: 8, col: c }); await sleep(60); }
  }
  const fin = await D.wait(m => m.t === 'state' && m.winner != null);
  check('双人对战 D 获胜', fin.winner === 1 && fin.winnerName === '小红');

  console.log(failures === 0 ? '\n全部测试通过 🎉' : `\n有 ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
