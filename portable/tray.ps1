# Telemax portable — значок возле часов. Запускается из Telemax.cmd.
# Запускает программу (app\dist\launcher.mjs — она держит мост и страницу настроек), следит, чтобы
# она работала, и показывает цветом значка, есть ли связь: зелёный — всё работает, жёлтый — что-то
# подключается или ждёт вас, красный — связи нет дольше минуты.
# Только штатные средства Windows (PowerShell 5.1, Windows Forms). Файл сохраняется в UTF-8 с BOM
# (это делает scripts/build-portable.mjs) — без BOM PowerShell 5.1 испортит русские строки.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$app = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $app
$node = Join-Path $app 'node.exe'
$entry = Join-Path $app 'dist\launcher.mjs'
$dataDir = Join-Path $root '.data'
$portFile = Join-Path $dataDir 'panel-port'
$logFile = Join-Path $dataDir 'logs\telemax.log'
$trayLog = Join-Path $dataDir 'logs\tray.log'

function Write-TrayLog([string]$text) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $trayLog) | Out-Null
    Add-Content -Path $trayLog -Value ("[{0}] {1}" -f (Get-Date -Format 's'), $text) -Encoding UTF8
  } catch { }
}

function Open-Page {
  if ($script:port) { Start-Process ("http://127.0.0.1:{0}/" -f $script:port) }
}

# --- один значок на папку ---------------------------------------------------------------------------
$sha = New-Object Security.Cryptography.SHA1Managed
$folderId = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
$createdNew = $false
$mutex = New-Object Threading.Mutex($true, "TelemaxPortable-$folderId", [ref]$createdNew)
if (-not $createdNew) {
  # Уже запущен из этой папки: второй запуск просто открывает страницу.
  if (Test-Path $portFile) { $script:port = (Get-Content $portFile -Raw).Trim(); Open-Page }
  exit 0
}

if (-not (Test-Path $node) -or -not (Test-Path $entry)) {
  [Windows.Forms.MessageBox]::Show("Не найдены файлы программы в папке app. Распакуйте архив целиком и запустите Telemax.cmd из него.", 'Telemax', 'OK', 'Error') | Out-Null
  exit 1
}

# --- программа (launcher) -----------------------------------------------------------------------------
$script:port = $null
$script:launcher = $null
$script:launcherStartedAt = Get-Date
$script:exiting = $false

function Start-Launcher {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = '"' + $entry + '"'
  $psi.WorkingDirectory = $root
  # Без оболочки: так файл, помеченный Windows как «скачанный из интернета», запускается без вопроса.
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $script:launcher = [Diagnostics.Process]::Start($psi)
  $script:launcherStartedAt = Get-Date
  Write-TrayLog ("launcher started, pid {0}" -f $script:launcher.Id)
}

function Invoke-Api([string]$path, [bool]$post) {
  $req = [Net.HttpWebRequest]::Create(("http://127.0.0.1:{0}{1}" -f $script:port, $path))
  $req.Timeout = 2500
  $req.ReadWriteTimeout = 2500
  $req.Proxy = $null
  if ($post) {
    $req.Method = 'POST'
    $req.ContentType = 'application/json'
    $req.Headers.Add('x-telemax', '1')
    $bytes = [Text.Encoding]::UTF8.GetBytes('{}')
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
  }
  $resp = $req.GetResponse()
  try {
    $reader = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
    $text = $reader.ReadToEnd()
    $reader.Close()
  } finally { $resp.Close() }
  return ($text | ConvertFrom-Json)
}

# --- значок ---------------------------------------------------------------------------------------
function New-DotIcon([Drawing.Color]$color) {
  $bmp = New-Object Drawing.Bitmap 32, 32
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([Drawing.Color]::Transparent)
  $brush = New-Object Drawing.SolidBrush $color
  $g.FillEllipse($brush, 1, 1, 30, 30)
  $font = New-Object Drawing.Font('Segoe UI', 20, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $g.DrawString('T', $font, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF 0, 1, 32, 32), $fmt)
  $g.Dispose()
  return [Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$icons = @{
  ok   = New-DotIcon ([Drawing.Color]::FromArgb(31, 157, 85))
  warn = New-DotIcon ([Drawing.Color]::FromArgb(208, 138, 0))
  bad  = New-DotIcon ([Drawing.Color]::FromArgb(214, 69, 69))
  wait = New-DotIcon ([Drawing.Color]::FromArgb(120, 128, 140))
}

$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = $icons.wait
$tray.Text = 'Telemax: запускается…'
$tray.Visible = $true

$menu = New-Object Windows.Forms.ContextMenuStrip
$itemState = $menu.Items.Add('Telemax: запускается…')
$itemState.Enabled = $false
[void]$menu.Items.Add('-')
$itemOpen = $menu.Items.Add('Открыть панель')
$itemRestart = $menu.Items.Add('Перезапустить мост')
$itemLog = $menu.Items.Add('Журнал')
$itemAuto = New-Object Windows.Forms.ToolStripMenuItem 'Запускать при входе в Windows'
$itemAuto.CheckOnClick = $true
[void]$menu.Items.Add($itemAuto)
[void]$menu.Items.Add('-')
$itemExit = $menu.Items.Add('Выход')
$tray.ContextMenuStrip = $menu

# --- автозапуск: ярлык в папке «Автозагрузка» текущего пользователя -------------------------------------------
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) ("Telemax-{0}.lnk" -f $folderId)
$itemAuto.Checked = Test-Path $startupLink
$itemAuto.Add_Click({
  try {
    if ($itemAuto.Checked) {
      $shell = New-Object -ComObject WScript.Shell
      $link = $shell.CreateShortcut($startupLink)
      $link.TargetPath = Join-Path $root 'Telemax.cmd'
      $link.WorkingDirectory = $root
      $link.WindowStyle = 7
      $link.Description = 'Telemax — мост MAX ↔ Telegram'
      $link.Save()
    } else {
      Remove-Item $startupLink -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Write-TrayLog ("autostart: {0}" -f $_.Exception.Message)
    $itemAuto.Checked = Test-Path $startupLink
  }
})

# --- состояние ----------------------------------------------------------------------------------------
$script:level = 'wait'
$script:pendingLevel = 'wait'
$script:pendingTicks = 0
$script:notifiedBad = $false
$script:pageOffered = $false
$script:launcherRestarts = 0

function Set-State([string]$level, [string]$summary) {
  $tray.Icon = $icons[$level]
  # Подсказка значка в Windows — не длиннее 63 знаков.
  if ($summary.Length -gt 63) { $tray.Text = $summary.Substring(0, 62) + '…' } else { $tray.Text = $summary }
  $itemState.Text = $summary
  # Сообщение — только о том, что держится два опроса подряд: минутные обрывы мост чинит сам.
  if ($level -eq $script:pendingLevel) { $script:pendingTicks++ } else { $script:pendingLevel = $level; $script:pendingTicks = 1 }
  if ($script:pendingTicks -eq 2) {
    if ($level -eq 'bad' -and -not $script:notifiedBad) {
      $script:notifiedBad = $true
      $tray.ShowBalloonTip(8000, 'Telemax', $summary, [Windows.Forms.ToolTipIcon]::Warning)
    } elseif ($level -eq 'ok' -and $script:notifiedBad) {
      $script:notifiedBad = $false
      $tray.ShowBalloonTip(5000, 'Telemax', 'Связь восстановлена — всё работает.', [Windows.Forms.ToolTipIcon]::Info)
    }
  }
  $script:level = $level
}

# Отвечает ли программа. Номер порта она пишет в файл при каждом запуске — читаем его заново,
# пока ответа нет: порт мог смениться.
function Get-Status {
  if (Test-Path $portFile) { $script:port = (Get-Content $portFile -Raw).Trim() }
  if (-not $script:port) { return $null }
  try { return (Invoke-Api '/api/status' $false) } catch { return $null }
}

function Update-State {
  if ($script:exiting) { return }
  $s = Get-Status
  if ($s -eq $null) {
    $sinceStart = ((Get-Date) - $script:launcherStartedAt).TotalSeconds
    $dead = ($script:launcher -eq $null -or $script:launcher.HasExited)
    if ($dead -and $sinceStart -ge 5) {
      # Программа закрылась сама — запускаем снова (но не чаще раза в 5 секунд).
      $script:launcherRestarts++
      Write-TrayLog 'launcher is not running — starting it again'
      Start-Launcher
    } elseif (-not $dead -and $sinceStart -ge 60) {
      # Процесс есть, а ответа нет уже минуту — завис. Снимаем; следующий опрос запустит заново.
      Write-TrayLog 'launcher does not answer — killing it'
      try { $script:launcher.Kill() } catch { }
    }
    if ($sinceStart -lt 20) { Set-State 'wait' 'Telemax: запускается…' } else { Set-State 'bad' 'Telemax: программа не отвечает' }
    return
  }
  Set-State ([string]$s.health.level) ([string]$s.health.summary)
  $itemRestart.Enabled = [bool]$s.configured
  # Первый запуск: настроек ещё нет — сразу открываем страницу, один раз.
  if (-not $s.configured -and -not $script:pageOffered) { $script:pageOffered = $true; Open-Page }
}

$itemOpen.Add_Click({ Open-Page })
$tray.Add_MouseDoubleClick({ Open-Page })
$itemRestart.Add_Click({
  try { Invoke-Api '/api/restart' $true | Out-Null } catch { Write-TrayLog ("restart: {0}" -f $_.Exception.Message) }
})
$itemLog.Add_Click({
  if (Test-Path $logFile) { Start-Process notepad.exe -ArgumentList ('"' + $logFile + '"') }
})
$itemExit.Add_Click({
  $script:exiting = $true
  $timer.Stop()
  $tray.Text = 'Telemax: останавливается…'
  try { Invoke-Api '/api/shutdown' $true | Out-Null } catch { }
  # Мосту нужно несколько секунд, чтобы закрыть соединения и дописать файлы.
  if ($script:launcher -ne $null -and -not $script:launcher.HasExited) {
    if (-not $script:launcher.WaitForExit(12000)) { try { $script:launcher.Kill() } catch { } }
  } else {
    # Программу запускал не этот значок (см. ниже) — ждём, пока она перестанет отвечать.
    for ($i = 0; $i -lt 24 -and (Get-Status) -ne $null; $i++) { Start-Sleep -Milliseconds 500 }
  }
  $tray.Visible = $false
  $tray.Dispose()
  [Windows.Forms.Application]::Exit()
})

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  try { Update-State } catch { Write-TrayLog ("tick: {0}" -f $_.Exception.Message) }
})

try {
  # Программа могла остаться от прошлого значка (его закрыли через диспетчер задач): тогда она уже
  # отвечает, и вторую запускать нельзя — два моста на одном боте мешают друг другу.
  if ((Get-Status) -eq $null) { Start-Launcher } else { Write-TrayLog 'found a running launcher — using it' }
  $timer.Start()
  $tray.ShowBalloonTip(4000, 'Telemax запущен', 'Значок возле часов показывает связь. Двойной щелчок — панель.', [Windows.Forms.ToolTipIcon]::Info)
  [Windows.Forms.Application]::Run()
} catch {
  Write-TrayLog ("fatal: {0}" -f $_.Exception.Message)
  [Windows.Forms.MessageBox]::Show(("Telemax не запустился: {0}" -f $_.Exception.Message), 'Telemax', 'OK', 'Error') | Out-Null
} finally {
  $tray.Visible = $false
  $mutex.ReleaseMutex()
}
