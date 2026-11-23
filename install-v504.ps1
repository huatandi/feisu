param([string]$Target)
$ErrorActionPreference = 'Stop'
try {
    if (-not $Target) { $Target = Read-Host '输入发生冲突的仓库根目录完整路径' }
    $Target = (Resolve-Path -LiteralPath $Target.Trim('"')).Path
    if (-not (Test-Path -LiteralPath (Join-Path $Target '.git'))) { throw '目标目录不是 Git 仓库根目录，未复制任何文件。' }
    if ($Target -eq $PSScriptRoot) { throw '请把 v5.0.4 解压到仓库外的新文件夹，再运行此脚本。' }
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '升级清单-v5.0.4.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in $manifest.files) {
        $relative = [string]$entry.path
        if ($relative -match '(^|/)\.\.?(/|$)|^/|:|(^|/)\.git(/|$)') { throw '升级清单存在无效路径。' }
        $source = Join-Path $PSScriptRoot $relative
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw ('源文件校验失败: ' + $relative) }
    }
    $parent = Split-Path -Parent $Target
    $backup = Join-Path $parent ('FEISU-v5.0.4-Backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backup | Out-Null
    # Complete every backup before replacing any target file.
    foreach ($entry in $manifest.files) {
        $dest = Join-Path $Target $entry.path
        if (Test-Path -LiteralPath $dest -PathType Leaf) {
            $saved = Join-Path $backup $entry.path
            New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
            Copy-Item -LiteralPath $dest -Destination $saved -Force
        }
    }
    foreach ($entry in $manifest.files) {
        $dest = Join-Path $Target $entry.path
        New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $entry.path) -Destination $dest -Force
    }
    Write-Host ('已替换升级文件。原文件备份在: ' + $backup) -ForegroundColor Green
    Write-Host '尚未完成 Git 合并。请在 GitHub Desktop 复核五个冲突文件，标记解决，再 Continue merge。'
    Write-Host '本机若有独立修改，请从备份中比较保留。脚本未修改 Git 索引或盘点历史。'
} catch {
    Write-Host ('未完成: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '若发生复制错误，请根据上方备份目录恢复已复制的文件。'
    exit 1
}
