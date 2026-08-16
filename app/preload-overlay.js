// 跟弹悬浮窗 preload:与主进程通信的桥接层
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  // 通知主进程:鼠标是否处于可交互区域(用于控制点击穿透)
  setInteractive: (flag) => ipcRenderer.send('overlay:set-interactive', !!flag),
  // 调整模式:true=整个窗口可交互(拖动边缘调整大小), false=恢复穿透
  setAdjustMode: (flag) => ipcRenderer.send('overlay:set-adjust-mode', !!flag),
  // 关闭悬浮窗
  close: () => ipcRenderer.send('overlay:close'),
  // 接收乐谱数据
  onData: (cb) => ipcRenderer.on('overlay:data', (_e, payload) => cb(payload)),
  // 接收全局按键事件(琴键索引 0-14)
  onKey: (cb) => ipcRenderer.on('overlay:key', (_e, idx) => cb(idx)),
  // 接收调整模式状态同步(主进程主动切换时)
  onAdjustMode: (cb) => ipcRenderer.on('overlay:adjust-mode', (_e, flag) => cb(flag)),
});
