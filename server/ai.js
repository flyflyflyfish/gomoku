'use strict';
// 果果五子棋 · AI 机器人 (启发式棋力引擎, 三档难度对应果果麻将的三个机器人人格)
// 蓝色大肥鱼=容易 / 豆包=中等 / Z=困难
const G = require('./game.js');

// 候选点: 已有棋子周围 2 格内的空位 (空盘落天元)
function candidates(board) {
  const size = board.length;
  let hasStone = false;
  const cand = new Set();
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === G.EMPTY) continue;
      hasStone = true;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === G.EMPTY) {
            cand.add(nr * size + nc);
          }
        }
      }
    }
  }
  if (!hasStone) {
    const m = (size >> 1) * size + (size >> 1);
    return [{ row: size >> 1, col: size >> 1 }];
  }
  return [...cand].map(v => ({ row: Math.floor(v / size), col: v % size }));
}

// 在 (r,c) 假想落子后, 评估四个方向的棋型, 返回总分
function shapeScore(board, r, c, player) {
  const size = board.length;
  let total = 0;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let count = 1, openEnds = 0;
    for (const s of [1, -1]) {
      let rr = r + dr * s, cc = c + dc * s;
      while (rr >= 0 && rr < size && cc >= 0 && cc < size && board[rr][cc] === player) {
        count++; rr += dr * s; cc += dc * s;
      }
      if (rr >= 0 && rr < size && cc >= 0 && cc < size && board[rr][cc] === G.EMPTY) openEnds++;
    }
    // 棋型打分: 成五 > 活四 > 冲四 > 活三 > 眠三 > 活二
    if (count >= 5) total += 10000000;
    else if (count === 4 && openEnds >= 1) total += openEnds === 2 ? 1000000 : 120000;
    else if (count === 3) total += openEnds === 2 ? 50000 : (openEnds === 1 ? 8000 : 0);
    else if (count === 2) total += openEnds === 2 ? 4000 : (openEnds === 1 ? 600 : 0);
    else if (count === 1) total += openEnds === 2 ? 120 : 0;
  }
  return total;
}

// 难度配置: defense权重 / 攻防兼顾 / 候选池随机度
const DIFFS = {
  easy:   { defW: 0.45, topK: 8,  jitter: 0.35 },
  medium: { defW: 0.9,  topK: 3,  jitter: 0.12 },
  hard:   { defW: 1.0,  topK: 1,  jitter: 0 },
};

function bestMove(board, me, diff) {
  const cfg = DIFFS[diff] || DIFFS.medium;
  const opp = G.other(me);
  const moves = candidates(board);
  if (!moves.length) return null;
  const scored = moves.map(m => {
    const atk = shapeScore(board, m.row, m.col, me);
    const def = shapeScore(board, m.row, m.col, opp);
    const s = atk + def * cfg.defW + Math.random() * cfg.jitter * 60000;
    return { ...m, s, atk };
  }).sort((a, b) => b.s - a.s);
  // 已经能成五直接赢; 对手下一手能成五必须堵
  if (scored[0].atk >= 10000000) return { row: scored[0].row, col: scored[0].col };
  for (const m of scored) {
    if (m.s - m.atk >= 10000000) return { row: m.row, col: m.col };
  }
  const pick = scored[Math.floor(Math.random() * Math.min(cfg.topK, scored.length))];
  return { row: pick.row, col: pick.col };
}

module.exports = { bestMove, DIFFS };
