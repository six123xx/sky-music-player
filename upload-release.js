const { execFileSync, spawnSync } = require('child_process');
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

  // 幂等:列出已有资产,同名先删除(含 starter 残留),再重新上传
  const assetsRes = await api(`${apiBase}/releases/${release.id}/assets`);
  const existing = assetsRes.ok ? await assetsRes.json() : [];
  for (const f of files) {
    const hit = existing.find((a) => a.name === f);
    if (hit) {
      const dr = await api(`${apiBase}/releases/assets/${hit.id}`, { method: 'DELETE' });
      console.log(`删除旧资产: ${f} (id=${hit.id}, state=${hit.state}, HTTP ${dr.status})`);
    }
  }

  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) { console.log('跳过（不存在）: ' + f); continue; }
    // asset 上传必须走 uploads.github.com 主机;api.github.com 会 301 重定向且跨主机丢 Authorization 头导致 404
    const url = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(f)}`;
    // 用 curl.exe 上传(Windows 自带),避免 Node fetch 上传大文件时的连接中断问题
    const tmp = path.join(__dirname, '.upload-body.json');
    const res = spawnSync('curl.exe', [
      '-sS',
      '-o', tmp,
      '-w', '%{http_code}',
      '-X', 'POST',
      '-H', `Authorization: token ${token}`,
      '-H', 'Content-Type: application/octet-stream',
      '--data-binary', `@${p}`,
      url,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 0 });
    if (res.error) {
      console.log(`上传失败: ${f} -> ${res.error.message}`);
      continue;
    }
    const code = (res.stdout || '').trim();
    let body = '';
    try { body = fs.readFileSync(tmp, 'utf8'); } catch (e) {}
    try { fs.unlinkSync(tmp); } catch (e) {}
    if (code === '201' || code === '200') {
      let size = '';
      try { size = ` (${(JSON.parse(body).size / 1048576).toFixed(1)} MB)`; } catch (e) {}
      console.log(`已上传: ${f}${size}`);
    } else {
      console.log(`上传失败: ${f} -> HTTP ${code}: ${body.slice(0, 200)}`);
    }
  }

  console.log(`Release 页面: https://github.com/${repo}/releases/tag/v1.0.0`);
})();
