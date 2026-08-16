// electron-builder afterPack hook:在 win-unpacked 生成后、安装包构建前
// 用 rcedit 注入应用图标与版本信息(规避 winCodeSign 符号链接解压问题)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findRcedit(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = findRcedit(p);
      if (sub) return sub;
    } else if (e.name.toLowerCase() === 'rcedit-x64.exe') {
      return p;
    }
  }
  return null;
}

exports.default = async function (context) {
  const { appOutDir, packager } = context;
  const projectDir = packager.projectDir;
  const cacheDir = path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder',
    'Cache',
    'winCodeSign'
  );
  const rcedit = findRcedit(cacheDir);
  if (!rcedit) {
    console.log('[afterPack] rcedit not found in', cacheDir, '- skip icon injection');
    return;
  }

  const exePath = path.join(appOutDir, '光遇乐谱播放器.exe');
  if (!fs.existsSync(exePath)) {
    console.log('[afterPack] target exe not found:', exePath);
    return;
  }

  const iconIco = path.join(projectDir, 'app', 'icon.ico');
  if (!fs.existsSync(iconIco)) {
    console.log('[afterPack] icon.ico not found, skip');
    return;
  }

  const args = [
    exePath,
    '--set-icon', iconIco,
    '--set-version-string', 'ProductName', 'Sky Music Player',
    '--set-version-string', 'FileDescription', 'Sky Music Player Desktop',
    '--set-version-string', 'CompanyName', 'SkyMusicPlayer',
    '--set-version-string', 'LegalCopyright', 'MIT License',
    '--set-file-version', '1.0.0',
    '--set-product-version', '1.0.0'
  ];
  execFileSync(rcedit, args, { stdio: 'inherit' });
  console.log('[afterPack] icon & version injected ->', exePath);
};
