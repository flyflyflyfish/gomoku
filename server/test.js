// 果果五子棋 · 自动化对局测试 (模拟两名玩家)
'use strict';
const WebSocket = require('ws');

const URL = 'ws://127.0.0.1:3000/ws';
let failures = 0;
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name);
  if (!cond) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.waiters = [];
    this.ready = new Promise(r => { this.ws = new WebSocket(URL); this.ws.on('open', r); });
    this.ws.on('message', d => {
      const m = JSON.parse(d);
      const w = this.waiters.findIndex(x => x.pred(m));
      if (w >= 0) { this.waiters.splice(w, 1); }
      this.msgs.push(m);
    });
    this.send = o => this.ws.readyState === 1 && this.ws.send(JSON.stringify(o));
  }
  wait(pred, ms = 3000) {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`等待消息超时: ${this.name}`)), ms);
      this.waiters.push({ pred: m => { if (!pred(m)) return false; clearTimeout(to); resolve(m); return true; } });
    });
  }
}

(async () => {
  await sleep(500);

  // 1. A 创建房间
  const A = new Client('小明');
  await A.ready;
  A.send({ t: 'join', name: '小明', code: '' });
  const wA = await A.wait(m => m.t === 'welcome');
  check('A 创建房间成功, 房间号=' + wA.code, /^\d{4}$/.test(wA.code));
  check('A 是黑棋(座位0)', wA.seat === 0 && wA.turn === 1);

  // 2. B 加入错误房间号 → 报错
  const B = new Client('小红');
  await B.ready;
  B.send({ t: 'join', name: '小红', code: '9999' });
  const errB = await B.wait(m => m.t === 'error');
  check('B 加入不存在房间被拒绝', /不存在/.test(errB.msg));

  // 3. B 加入正确房间 → 自动开局
  B.send({ t: 'join', name: '小红', code: wA.code });
  const wB = await B.wait(m => m.t === 'welcome');
  check('B 加入成功, 座位1', wB.seat === 1);
  const stA = await A.wait(m => m.t === 'state' && m.players.length === 2);
  check('双方收到开局状态', stA.turn === 1 && stA.board[7][7] === 0);

  // 4. B 乱走 → 被服务端拒绝 (不是 B 的回合)
  B.send({ t: 'move', row: 0, col: 0 });
  const eB = await B.wait(m => m.t === 'error' && /还没轮到/.test(m.msg));
  check('非当前回合落子被拒绝', !!eB);

  // 5. A 连下五子 (7,3)~(7,7) 横向获胜
  for (let c = 3; c <= 7; c++) {
    A.send({ t: 'move', row: 7, col: c });
    await sleep(80);
    if (c !== 7) { B.send({ t: 'move', row: 8, col: c }); await sleep(80); }
  }
  const fin = await A.wait(m => m.t === 'state' && m.winner != null);
  check('A 横向五连获胜', fin.winner === 1 && fin.winnerName === '小明');
  check('胜利连线高亮 5 格', Array.isArray(fin.winLine) && fin.winLine.length === 5);

  // 6. 聊天
  B.send({ t: 'chat', msg: '打得漂亮!' });
  const chatA = await A.wait(m => m.t === 'chat');
  check('聊天广播', chatA.from === '小红' && chatA.msg === '打得漂亮!');

  // 7. A 重开 → B 收到新局
  A.send({ t: 'reset' });
  const reB = await B.wait(m => m.t === 'state' && m.winner == null && m.moves === 0 && m.players.length === 2);
  check('重开后双方进入新局', reB.turn === 1);

  // 8. 断线重连: B 断开, A 收到离线状态; B 用 sid 重连
  B.ws.close();
  const offA = await A.wait(m => m.t === 'state' && m.players.some(p => p.name === '小红' && !p.online));
  check('A 收到 B 离线状态', !!offA);
  const B2 = new Client('小红');
  await B2.ready;
  B2.send({ t: 'resume', sid: wB.sid });
  const rw = await B2.wait(m => m.t === 'welcome');
  check('B 断线重连成功(同座位)', rw.resumed === true && rw.seat === 1);

  // 9. 错误 sid 重连被拒
  const C = new Client('路人');
  await C.ready;
  C.send({ t: 'resume', sid: 'deadbeef' });
  const rf = await C.wait(m => m.t === 'resume_fail');
  check('无效 sid 重连被拒绝', rf.t === 'resume_fail');

  // 10. B 离开房间
  B2.send({ t: 'leave' });
  await sleep(300);

  console.log(failures === 0 ? '\n全部测试通过 🎉' : `\n有 ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
