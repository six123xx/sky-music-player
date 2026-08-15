# 光遇乐谱播放器 | Sky Music Player

面向《光·遇》(Sky: Children of the Light) 玩家的乐谱工具，支持乐谱播放、制谱、跟弹练习、云端分享。

## 功能

- 支持 Sky Studio JSON 格式和 ABC1/5 TXT 格式乐谱导入
- 15 键光遇乐器布局，播放时实时高亮琴键
- 点阵谱面可视化，滚动显示音符流动轨迹
- 制谱器：逐拍编辑，支持从曲库改编另存，导出 JSON
- 跟弹练习模式：小球引导，支持调速和片段循环
- 6 档播放速度调节（0.5x ~ 2.0x）
- 自定义键盘映射
- 6 套界面主题配色
- 简谱数字标注模式（1-7 + 高音点）
- 乐谱云存储与社区分享

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务器（同时提供前端和后端）
npm start
```

浏览器访问 http://localhost:3000 即可使用。

也可以直接用浏览器打开 `sky-music-player.html` 使用前端功能（云端功能需启动后端）。

## 技术栈

- 前端：纯 HTML/CSS/JavaScript，Web Audio API
- 后端：Node.js + Express + better-sqlite3
- 数据库：SQLite（单文件，零配置）

## 免责声明

本项目为非营利性粉丝作品，与 Thatgamecompany 及《光·遇》游戏官方无任何关联。游戏名称、素材版权归原作者所有，本项目仅用于个人学习和娱乐目的。
