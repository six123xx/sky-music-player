// 跟弹悬浮窗 preload:与主进程通信的桥接层
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  // 通知主进程:鼠标是否处于可交互区域(用于控制点击穿透)
  setInteractive: (flag) => ipcRenderer.send('overlay:set-interactive', !!flag),
  // 调整模式:true=整个窗口可交互(拖动边缘调整大小), false=恢复穿透
  setAdjustMode: (flag) => ipcRenderer.send('overlay:set-adjust-mode', !!flag),
  // 关闭悬浮窗
  close: () => ipcRenderer.send('overlay:close'),
  // 开始截图对齐
  capture: () => ipcRenderer.send('overlay:capture'),
  // 隐藏悬浮窗(与 F10 快捷键同义)
  hide: () => ipcRenderer.send('overlay:hide'),
  // 获取可更换的歌曲列表
  listSongs: () => ipcRenderer.invoke('overlay:list-songs'),
  // 切换歌曲(主进程会同步数据到悬浮窗与主窗口)
  selectSong: (id) => ipcRenderer.invoke('overlay:select-song', id),
  // 设置跟弹倍速(同步主窗口播放器速度档)
  setSpeed: (v) => ipcRenderer.send('overlay:set-speed', v),
  // 自动弹奏:模拟敲击琴键索引 0-14(注入全局按键)
  simKey: (idx) => ipcRenderer.send('overlay:sim-key', idx),
  // 自动弹奏:清空主进程待模拟按键队列
  clearSim: () => ipcRenderer.send('overlay:sim-clear'),
  // 接收乐谱数据
  onData: (cb) => ipcRenderer.on('overlay:data', (_e, payload) => cb(payload)),
  // 接收全局按键事件(琴键索引 0-14)
  onKey: (cb) => ipcRenderer.on('overlay:key', (_e, idx) => cb(idx)),
  // 接收调整模式状态同步(主进程主动切换时)
  onAdjustMode: (cb) => ipcRenderer.on('overlay:adjust-mode', (_e, flag) => cb(flag)),
  // 接收截图对齐的琴键位置(相对窗口)
  onAlignKeys: (cb) => ipcRenderer.on('overlay:align-keys', (_e, payload) => cb(payload)),
  // 接收快捷键命令: 'toggle-play' | 'stop'
  onCommand: (cb) => ipcRenderer.on('overlay:command', (_e, cmd) => cb(cmd)),
});
