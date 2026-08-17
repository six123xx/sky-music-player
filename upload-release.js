const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = 'six123xx/sky-music-player';

// 通过 git credential fill 获取 token
let token = '';
try {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('password=')) token = line.slice('password='.length);
  }
} catch (e) {
  console.error('git credential fill 失败:', e.message);
  process.exit(1);
}
if (!token) {
  console.error('未获取到 GitHub token');
  process.exit(1);
}

const apiBase = `https://api.github.com/repos/${repo}`;

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${token}`,
      'User-Agent': 'sky-music-player-release',
      Accept: 'application/vnd.github+json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok && res.status !== 404) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res;
}

(async () => {
  // 检查是否已有 v1.0.0 release
  let release = null;
  try {
    const res = await api(`${apiBase}/releases/tags/v1.0.0`);
    if (res.ok) release = await res.json();
  } catch (e) {
    console.log('查询已有 release 失败(忽略):', e.message);
  }

  if (!release) {
    const body = `## 光遇乐谱播放器 v1.0.0

### 本次更新
- 曲库新增分类功能，支持自定义分类命名/重命名/删除
- 支持拖入文件夹，自动识别文件夹内所有乐谱文件
- 支持多文件批量导入
- 音色优化与爆音修复（5 种乐器 + 限幅压缩器）
- 跟弹悬浮窗、截图对齐等优化

### 文件说明
- **SkyMusicPlayer-Setup-1.0.0.exe**：安装版（NSIS 安装向导，可自定义安装目录）
- **SkyMusicPlayer-Portable-1.0.0.exe**：便携版（免安装，直接运行）`;
    const payload = JSON.stringify({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      body,
      draft: false,
      prerelease: false,
    });
    const res = await api(`${apiBase}/releases`, { method: 'POST', body: payload });
    release = await res.json();
    console.log('Release 创建成功 id=' + release.id);
  } else {
    console.log('Release v1.0.0 已存在，复用 id=' + release.id);
  }

  // 上传资产(优先读取最新构建目录 release2,避免与旧 release 目录混淆)
  const dir = path.join(__dirname, 'release2');
  const files = ['SkyMusicPlayer-Setup-1.0.0.exe', 'SkyMusicPlayer-Portable-1.0.0.exe'];
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) { console.log('跳过（不存在）: ' + f); continue; }
    const stat = fs.statSync(p);
    const data = fs.readFileSync(p);
    // asset 上传必须走 uploads.github.com 主机;api.github.com 会 301 重定向且跨主机丢 Authorization 头导致 404
    const url = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(f)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          'User-Agent': 'sky-music-player-release',
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.length),
        },
        body: data,
      });
      if (!res.ok) {
        const txt = await res.text();
        console.log(`上传失败: ${f} -> HTTP ${res.status}: ${txt.slice(0, 200)}`);
      } else {
        const j = await res.json();
        console.log(`已上传: ${f} (${(j.size / 1048576).toFixed(1)} MB)`);
      }
    } catch (e) {
      console.log(`上传失败: ${f} -> ${e.message}`);
    }
  }

  console.log(`Release 页面: https://github.com/${repo}/releases/tag/v1.0.0`);
})();
