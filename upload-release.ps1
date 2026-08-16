# 从 git 凭据管理器获取 GitHub token，用于创建 Release 并上传安装包
$ErrorActionPreference = 'Stop'
$repo = 'six123xx/sky-music-player'

# 通过 git credential fill 获取凭据（用 cmd echo 避免 PowerShell 管道编码问题）
$inputStr = "protocol=https`r`nhost=github.com`r`n`r`n"
$output = cmd /c "echo protocol=https& echo host=github.com& echo.& git credential fill"
$token = ''
foreach ($line in $output) {
  if ($line -match '^password=(.+)$') { $token = $matches[1] }
}
if (-not $token) {
  Write-Error '无法从 git 凭据管理器获取 GitHub token'
  exit 1
}

$headers = @{ Authorization = "token $token"; 'User-Agent' = 'sky-music-player-release' }
$apiBase = "https://api.github.com/repos/$repo"

$releaseBody = @'
## 光遇乐谱播放器 v1.0.0

### 本次更新
- 曲库新增分类功能，支持自定义分类命名/重命名/删除
- 支持拖入文件夹，自动识别文件夹内所有乐谱文件
- 支持多文件批量导入
- 音色优化与爆音修复（5 种乐器 + 限幅压缩器）
- 跟弹悬浮窗、截图对齐等优化

### 文件说明
- **SkyMusicPlayer-Setup-1.0.0.exe**：安装版（NSIS 安装向导，可自定义安装目录）
- **SkyMusicPlayer-Portable-1.0.0.exe**：便携版（免安装，直接运行）
'@

$payload = @{ tag_name = 'v1.0.0'; name = 'v1.0.0'; body = $releaseBody; draft = $false; prerelease = $false } | ConvertTo-Json

# 检查是否已存在同 tag 的 release
$existing = $null
try {
  $existing = Invoke-RestMethod -Uri "$apiBase/releases/tags/v1.0.0" -Headers $headers -Method Get -ErrorAction Stop
} catch { $existing = $null }

if ($existing) {
  $release = $existing
  Write-Output "Release v1.0.0 已存在，复用 id=$($release.id)"
} else {
  $release = Invoke-RestMethod -Uri "$apiBase/releases" -Headers $headers -Method Post -Body $payload -ContentType 'application/json'
  Write-Output "Release 创建成功 id=$($release.id)"
}

# 上传资产
$files = @('SkyMusicPlayer-Setup-1.0.0.exe', 'SkyMusicPlayer-Portable-1.0.0.exe')
$dir = 'C:\Users\10145\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6a80592452cebd48d9c1c84c\release'
foreach ($f in $files) {
  $path = Join-Path $dir $f
  if (-not (Test-Path $path)) { Write-Output "跳过（不存在）: $f"; continue }
  $assetUrl = "$apiBase/releases/$($release.id)/assets?name=$f"
  try {
    $result = Invoke-RestMethod -Uri $assetUrl -Headers $headers -Method Post -InFile $path -ContentType 'application/octet-stream'
    Write-Output "已上传: $f ($([math]::Round($result.size/1MB,1)) MB)"
  } catch {
    Write-Output "上传失败: $f -> $($_.Exception.Message)"
  }
}

Write-Output "Release 页面: https://github.com/$repo/releases/tag/v1.0.0"
