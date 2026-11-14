param([string]$Target)
$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
function Hash-Bytes([byte[]]$Bytes, [bool]$Normalize = $false) {
    if ($Normalize) { try { $s = $Utf8.GetString($Bytes).TrimStart([char]0xFEFF).Replace("`r`n", "`n"); $Bytes = $Utf8.GetBytes($s) } catch {} }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Quote-Arg([string]$Value) {
    return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}
function Run-Git([string[]]$GitArgs) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Git; $psi.WorkingDirectory = $Target; $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
    if ($psi.PSObject.Properties.Name -contains 'ArgumentList') { foreach ($a in $GitArgs) { [void]$psi.ArgumentList.Add($a) } }
    else { $psi.Arguments = (($GitArgs | ForEach-Object { Quote-Arg $_ }) -join ' ') }
    $process = New-Object System.Diagnostics.Process; $process.StartInfo = $psi
    [void]$process.Start(); $errorTask = $process.StandardError.ReadToEndAsync()
    $memory = New-Object System.IO.MemoryStream
    $process.StandardOutput.BaseStream.CopyTo($memory); $process.WaitForExit()
    $result = [pscustomobject]@{ Code = $process.ExitCode; Bytes = $memory.ToArray(); Error = $errorTask.Result }
    $process.Dispose(); $memory.Dispose(); return $result
}
function Git-Text([string[]]$GitArgs) { $r = Run-Git $GitArgs; if ($r.Code -ne 0) { throw $r.Error }; return $Utf8.GetString($r.Bytes) }
function Safe-Path([string]$Root, [string]$Relative) {
    if ($Relative -match '(^|/)\.\.?(/|$)|^/|:|\\|(^|/)\.git(/|$)') { throw ('不安全的相对路径: ' + $Relative) }
    $result = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    $parent = Split-Path -Parent $result
    while ($parent -and $parent.Length -gt $Root.Length) {
        if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ('目录包含链接，停止: ' + $Relative) }
        $parent = Split-Path -Parent $parent
    }
    if ((Test-Path -LiteralPath $result) -and ((Get-Item -LiteralPath $result -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ('文件包含链接，停止: ' + $Relative) }
    return $result
}
function Marker-Text([byte[]]$Bytes) {
    $text = $Utf8.GetString($Bytes).TrimStart([char]0xFEFF).Replace("`r`n", "`n")
    return [regex]::Replace($text, '(?m)^(<<<<<<<|=======|>>>>>>>|\|{7})(?: [^\n]*)?$', '$1')
}
function Write-Bytes([string]$Where, [byte[]]$Data) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Where)); [IO.File]::WriteAllBytes($Where, $Data)
}
try {
    if (-not $Target) { $Target = Read-Host '粘贴 GitHub Desktop 中 feisu 仓库的本地完整路径' }
    $Target = (Resolve-Path -LiteralPath $Target.Trim('"')).Path
    $cmd = Get-Command git -ErrorAction SilentlyContinue
    if ($cmd) { $Git = $cmd.Source }
    else {
        $desktopRoot = Join-Path $env:LOCALAPPDATA 'GitHubDesktop'
        $Git = Get-ChildItem -Path (Join-Path $desktopRoot 'app-*/resources/app/git/cmd/git.exe') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
        if (-not $Git) { throw '未找到 Git。请打开 GitHub Desktop 后重试，或安装 Git for Windows。' }
    }
    $top = (Git-Text @('rev-parse', '--show-toplevel')).Trim()
    if ([IO.Path]::GetFullPath($top) -ne [IO.Path]::GetFullPath($Target)) { throw '请输入仓库根目录，而不是子目录。' }
    if ((Run-Git @('rev-parse', '--verify', 'MERGE_HEAD')).Code -ne 0) { throw '当前不是正在进行的 merge；本工具不执行 pull、rebase 或新合并。' }
    $indexPath = (Git-Text @('rev-parse', '--git-path', 'index')).Trim()
    if (-not [IO.Path]::IsPathRooted($indexPath)) { $indexPath = Join-Path $Target $indexPath }
    if (Test-Path -LiteralPath ($indexPath + '.lock')) { throw 'Git 索引正在被其他进程占用；请等操作结束再试。' }
    $indexBefore = [IO.File]::ReadAllBytes($indexPath); $indexHash = Hash-Bytes $indexBefore
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'merge-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $out = Join-Path (Split-Path -Parent $Target) ('FEISU-Merge-Backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    [void][IO.Directory]::CreateDirectory($out)
    $reportDir = Join-Path $out 'report'; [void][IO.Directory]::CreateDirectory($reportDir)
    Write-Bytes (Join-Path $out 'index.before') $indexBefore
    $entries = @{}; $stages = @{}; $problems = New-Object System.Collections.Generic.List[string]
    foreach ($row in ((Git-Text @('ls-files', '--stage', '-z')) -split [char]0)) {
        if (-not $row) { continue }
        if ($row -notmatch '^([0-9]+) ([a-f0-9]+) ([0-3])\t(.+)$') { throw '无法解析 Git 索引记录。' }
        $rel = $Matches[4]; $stage = [int]$Matches[3]
        if (-not $stages.ContainsKey($rel)) { $stages[$rel] = @{} }
        $stages[$rel][$stage] = [pscustomobject]@{ Oid = $Matches[2]; Mode = $Matches[1] }
    }
    $conflicts = @($stages.Keys | Where-Object { $stages[$_].Keys -contains 1 -or $stages[$_].Keys -contains 2 -or $stages[$_].Keys -contains 3 } | Sort-Object)
    if ($conflicts.Count -eq 0) { throw 'Git 没有未解决条目。请回 GitHub Desktop 刷新后检查，而不是重复运行合并。' }
    foreach ($file in $manifest.files) { $entries[$file.path] = $file }
    $apply = @($manifest.upgradePaths + $conflicts | Sort-Object -Unique)
    foreach ($rel in $apply) {
        if (-not $entries.ContainsKey($rel)) { $problems.Add('包内没有最终版本，保留原状: ' + $rel); continue }
        $e = $entries[$rel]; $source = Safe-Path (Join-Path $PSScriptRoot 'payload') $rel
        if ((Hash-Bytes ([IO.File]::ReadAllBytes($source))) -ne $e.sha256) { throw ('工具包校验失败: ' + $rel) }
        $dest = Safe-Path $Target $rel; $data = @{}
        if ($stages.ContainsKey($rel)) {
            foreach ($stage in $stages[$rel].Keys) {
                $entry = $stages[$rel][$stage]
                if ($entry.Mode -notin @('100644', '100755')) { $problems.Add('不处理链接或特殊 Git 模式: ' + $rel); continue }
                $blob = Run-Git @('cat-file', 'blob', $entry.Oid); if ($blob.Code -ne 0) { throw $blob.Error }
                $data[$stage] = $blob.Bytes
                if ((Hash-Bytes $blob.Bytes $true) -notin $e.known) { Write-Bytes (Safe-Path (Join-Path $reportDir ('stage-' + $stage)) $rel) $blob.Bytes; $problems.Add('Git 第 ' + $stage + ' 阶段含未知版本改动: ' + $rel) }
                if ($stage -ne 0) { Write-Bytes (Safe-Path (Join-Path $reportDir ('stage-' + $stage)) $rel) $blob.Bytes }
            }
        }
        if (-not (Test-Path -LiteralPath $dest) -and $stages.ContainsKey($rel) -and $stages[$rel].ContainsKey(0) -and $conflicts -notcontains $rel) { $problems.Add('工作区删除了目标文件，未自动恢复: ' + $rel) }
        if (Test-Path -LiteralPath $dest -PathType Leaf) {
            $current = [IO.File]::ReadAllBytes($dest); Write-Bytes (Safe-Path (Join-Path $out 'working') $rel) $current
            if ((Hash-Bytes $current $true) -notin $e.known) {
                $matchesAuto = $false
                if ($conflicts -contains $rel) {
                    $tmp = Join-Path $out 'merge-input'; [void][IO.Directory]::CreateDirectory($tmp)
                    foreach ($stage in @(1,2,3)) { $bytes = [byte[]]@(); if ($data.ContainsKey($stage)) { $bytes = $data[$stage] }; Write-Bytes (Join-Path $tmp ([string]$stage)) $bytes }
                    foreach ($style in @('', '--diff3', '--zdiff3')) {
                        $a = @('merge-file', '-p'); if ($style) { $a += $style }; $a += @((Join-Path $tmp '2'), (Join-Path $tmp '1'), (Join-Path $tmp '3'))
                        $generated = Run-Git $a
                        if ($generated.Code -ge 0 -and $generated.Code -le 127) { try { if ((Marker-Text $current) -ceq (Marker-Text $generated.Bytes)) { $matchesAuto = $true; break } } catch {} }
                    }
                }
                if (-not $matchesAuto) { $problems.Add('工作区包含无法确认的修改，未覆盖: ' + $rel); Write-Bytes (Safe-Path (Join-Path $reportDir 'working-unknown') $rel) $current }
            }
        }
    }
    $summary = [pscustomobject]@{ conflicts = $conflicts; problems = @($problems.ToArray()); finalVersion = 'R8'; action = 'preflight'; backup = $out }
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $reportDir 'report.json') -Encoding UTF8
    if ($problems.Count -gt 0) {
        $zip = Join-Path $out 'merge-report.zip'; Compress-Archive -Path (Join-Path $reportDir '*') -DestinationPath $zip
        Write-Host '发现未提供的改动，未替换或暂存任何项目文件。' -ForegroundColor Yellow
        $problems | ForEach-Object { Write-Host $_ }
        Write-Host ('请把这份报告 ZIP 发来: ' + $zip); exit 2
    }
    if ((Hash-Bytes ([IO.File]::ReadAllBytes($indexPath))) -ne $indexHash) { throw '预检期间 Git 索引改变；未替换文件，请稍后重试。' }
    foreach ($rel in $apply) { Write-Bytes (Safe-Path $Target $rel) ([IO.File]::ReadAllBytes((Safe-Path (Join-Path $PSScriptRoot 'payload') $rel))) }
    if ((Hash-Bytes ([IO.File]::ReadAllBytes($indexPath))) -ne $indexHash) { throw ('复制期间 Git 索引改变。未暂存；原文件备份在: ' + $out) }
    $added = Run-Git (@('add', '--') + $apply); if ($added.Code -ne 0) { throw ($added.Error + ' 原文件和索引备份在: ' + $out) }
    $remaining = Git-Text @('diff', '--name-only', '--diff-filter=U')
    if ($remaining.Trim()) { throw ('还有未解决文件，未执行提交: ' + $remaining) }
    Write-Host ('已按 R8 处理并暂存 ' + $conflicts.Count + ' 个已知版本冲突文件，补齐 R8 升级文件。') -ForegroundColor Green
    Write-Host ('原文件、三方内容及原 Git 索引备份在: ' + $out)
    Write-Host '请回 GitHub Desktop，复核变更，然后 Continue merge。工具没有提交、推送或删除历史记录。'
} catch { Write-Host ('停止: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
