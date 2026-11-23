'use strict';
// 果果五子棋 · 棋盘核心逻辑 (纯函数, 服务端权威判定, 支持 15/19 路)
const SIZES = [15, 19];
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

function newBoard(size) {
  return Array.from({ length: size }, () => Array(size).fill(EMPTY));
}

function other(p) { return p === BLACK ? WHITE : BLACK; }

// 落子 + 胜负判定: 胜利时返回连成五子的坐标数组 (用于前端高亮), 否则返回 null
function checkWin(board, row, col, player) {
  const size = board.length;
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const line = [{ row, col }];
    for (const s of [1, -1]) {
      let r = row + dr * s, c = col + dc * s;
      while (r >= 0 && r < size && c >= 0 && c < size && board[r][c] === player) {
        line.push({ row: r, col: c });
        r += dr * s; c += dc * s;
      }
    }
    if (line.length >= 5) {
      line.sort((a, b) => (a.row - b.row) * dr + (a.col - b.col) * dc);
      return line.slice(0, 5);
    }
  }
  return null;
}

function isFull(board) {
  return board.every(r => r.every(c => c !== EMPTY));
}

module.exports = { SIZES, EMPTY, BLACK, WHITE, newBoard, other, checkWin, isFull };
