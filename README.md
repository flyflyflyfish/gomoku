<<<<<<< HEAD
# 五子棋

一个纯前端的双人本地五子棋小游戏：

- 15x15 棋盘
- 黑白轮流落子
- 自动判断五连胜
- 支持重新开始
=======
# 果果五子棋 🍈

15×15 棋盘五子棋，架构参考「果果麻将」（family-mahjong）：Express + ws、房间制联机、sid 断线重连、JSON 战绩持久化。

## 功能

- **本地对战**：纯前端双人轮流落子（原版保留）
- **在线对战**：创建房间（4 位房间号）、好友加入房间、WebSocket 实时对弈
- **断线重连**：刷新/切后台 2 小时内回来自动续局
- **服务端权威判定**：落子校验、胜负判定全在服务端，客户端只渲染
- **房间聊天**：房内简单文字聊天
- **战绩**：`/api/history` 返回最近对局记录

## 目录结构

```
public/          前端 (index.html / script.js / style.css)
server/index.js  服务端 (HTTP + WebSocket, 房间/对局管理)
server/game.js   棋盘核心逻辑 (纯函数)
server/history.json  战绩持久化 (运行时生成)
```

## 本地运行

```bash
npm install
npm start          # 默认 3000 端口, ws 路径 /ws 与 /gmk-ws 均可
```

## 部署约定（与果果麻将一致）

- 源码目录：`/opt/gomoku`
- Docker：`node:20-alpine`，挂载 `/opt/gomoku:/app`，绑定 `127.0.0.1:3001`，内存限制 200MB
- nginx：`https://flyflyflyfish.cn/gmk/` 反代到容器，WebSocket 走 `/gmk-ws`（需要 upgrade 头）
>>>>>>> 431d193 (v2.0: 果果五子棋 - 新增在线对战后端 (参考果果麻将架构: 房间制+sid重连+服务端权威判定+战绩持久化))
