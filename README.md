# 光遇乐谱播放器 | Sky Music Player

面向《光·遇》(Sky: Children of the Light) 玩家的桌面乐谱工具，支持乐谱播放、制谱、跟弹练习、**游戏中跟弹透明悬浮窗**与云端分享。

## 功能

- 支持 Sky Studio JSON 格式和 ABC1/5 TXT 格式乐谱导入
- 15 键光遇乐器布局，播放时实时高亮琴键
- 点阵谱面可视化，滚动显示音符流动轨迹
- 制谱器：逐拍编辑，支持从曲库改编另存，导出 JSON
- 跟弹练习模式：小球引导，支持调速和片段循环
- **跟弹透明悬浮窗**：游戏中实时跟弹，透明置顶、鼠标穿透，按对变绿 / 按错闪红
- 6 档播放速度调节（0.5x ~ 2.0x）
- 自定义键盘映射
- 6 套界面主题配色
- 简谱数字标注模式（1-7 + 高音点）
- 乐谱云存储与社区分享

## 快速开始

```bash
# 安装依赖
npm install

# 启动桌面应用（Electron）
npm start
```

也可以仅启动内置服务器（浏览器访问 http://localhost:3000）：

```bash
npm run server
```

## 游戏内跟弹（悬浮窗）

1. 打开应用 → 加载乐谱 → 跟弹页点击「跟弹悬浮窗」
2. 游戏建议设置为**窗口化 / 无边框全屏**（独占全屏会盖住悬浮窗）
3. 悬浮窗点击「开始」，跟随发光小球提示在游戏里弹奏

技术实现：主进程通过 koffi 轮询 `user32.GetAsyncKeyState` 读取全局琴键状态——**不拦截按键**，游戏照常收到按键，琴声不受影响；悬浮窗为透明置顶无边框窗口（不抢焦点、默认鼠标穿透）。

## 打包

```bash
# 打包 Windows 安装版 + 便携版（输出到 release/）
npm run dist

# 仅生成未打包目录（release/win-unpacked/）
npm run pack
```

## 技术栈

- 桌面框架：Electron
- 前端：纯 HTML/CSS/JavaScript，Web Audio API
- 后端：Node.js + Express
- 全局键监听：koffi（FFI 调用 Windows 原生 API）
- 数据库：SQLite（单文件，零配置）

## 项目结构

```
├── app/                  # Electron 应用主体
│   ├── main.js           # 主进程：窗口管理、悬浮窗、全局键监听
│   ├── server.js         # 内置 HTTP 服务器（前端 + 后端 API）
│   ├── sky-music-player.html  # 主界面
│   ├── overlay.html      # 跟弹透明悬浮窗页面
│   ├── preload.js        # 主窗口 IPC 桥接
│   └── preload-overlay.js     # 悬浮窗 IPC 桥接
├── scripts/
│   └── after-pack.js     # 打包后置钩子（注入图标与版本信息）
└── package.json
```

## 免责声明

本项目为非营利性粉丝作品，与 Thatgamecompany 及《光·遇》游戏官方无任何关联。游戏名称、素材版权归原作者所有，本项目仅用于个人学习和娱乐目的。
