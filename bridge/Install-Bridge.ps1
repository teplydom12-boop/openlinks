[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [string]$Folder = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'OpenLinks-Claude'),
  [string]$PythonPath = '',
  [string]$ClaudePath = '',
  [switch]$AutoStart,
  [switch]$NoStart
)
$ErrorActionPreference='Stop'
$app=Join-Path $env:LOCALAPPDATA 'OpenLinksClaude'
$code=Join-Path $app 'bridge'
$configPath=Join-Path $app 'config.json'
$utf8=New-Object System.Text.UTF8Encoding($false)
function Write-Utf8([string]$Path,[string]$Content){[IO.File]::WriteAllText($Path,$Content,$utf8)}
function Assert-Plain([string]$Path){
  $item=Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
  if($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Refusing linked path: $Path"}
}
if(-not [IO.Path]::IsPathRooted($Folder)){throw 'Folder must be an absolute path'}
foreach($path in @($app,$code,$Folder)){Assert-Plain $path}
foreach($name in @('common.py','native_host.py','worker.py')){
  if(-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)){throw "Missing bridge source: $name"}
}
if(-not $PythonPath){
  $python=Get-Command python.exe -ErrorAction SilentlyContinue
  if(-not $python){throw 'Install Python 3.12 or newer, then run this installer again'}
  $PythonPath=(& $python.Source -c 'import sys; print(sys.executable)').Trim()
}
if(-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)){throw 'Python executable not found'}
& $PythonPath -c "import sys; assert sys.version_info >= (3,12), 'Python 3.12+ required'"
if($LASTEXITCODE -ne 0){throw 'Python readiness check failed'}
$pythonw=Join-Path (Split-Path $PythonPath -Parent) 'pythonw.exe'
if(-not (Test-Path -LiteralPath $pythonw -PathType Leaf)){throw 'pythonw.exe is required for the background worker'}
if(-not $ClaudePath){
  $bundled=Join-Path $app 'claude\claude.exe'
  if(Test-Path -LiteralPath $bundled -PathType Leaf){$ClaudePath=$bundled}
  else{$claude=Get-Command claude.exe -ErrorAction SilentlyContinue;if($claude){$ClaudePath=$claude.Source}}
}
if($ClaudePath -and (-not [IO.Path]::IsPathRooted($ClaudePath) -or -not (Test-Path -LiteralPath $ClaudePath -PathType Leaf))){throw 'ClaudePath must point to the Claude Code executable'}
New-Item -ItemType Directory -Path $app,$code,$Folder -Force | Out-Null
$settings=[ordered]@{version=1;folder=$Folder;extensionId=$ExtensionId;claudePath=$ClaudePath;model='sonnet';enabled=$false;timeoutSeconds=180;pollSeconds=3}
if(Test-Path -LiteralPath $configPath){
  Assert-Plain $configPath
  $existing=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if($existing.version -ne 1 -or $existing.extensionId -ne $ExtensionId -or $existing.folder -ne $Folder){throw 'An existing bridge has another extension or folder. Preserve its queue and review config.json before reinstalling'}
  $settings.model=$existing.model
  if(-not $ClaudePath){$settings.claudePath=$existing.claudePath}
}
Write-Utf8 $configPath ($settings | ConvertTo-Json -Depth 5)
$workerPath=Join-Path $code 'worker.py'
$runtimePath=Join-Path $Folder 'state\worker.json'
if(Test-Path -LiteralPath $runtimePath){
  $runtime=Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $workerPid=0
  if([int]::TryParse([string]$runtime.pid,[ref]$workerPid) -and $workerPid -gt 0){
    $running=Get-CimInstance Win32_Process -Filter ('ProcessId='+$workerPid) -ErrorAction SilentlyContinue
    if($running -and $running.CommandLine -match [regex]::Escape($workerPath)){
      # Let the worker stop its own Claude child before terminating Python.
      $deadline=(Get-Date).AddSeconds(20)
      do {
        $runtime=Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if($runtime.status -eq 'disabled' -and -not $runtime.jobId){break}
        if(-not (Get-Process -Id $workerPid -ErrorAction SilentlyContinue)){break}
        if((Get-Date) -ge $deadline){throw 'Worker has not stopped its active job. Processing is disabled; retry installation after it stops'}
        Start-Sleep -Milliseconds 200
      } while($true)
      Stop-Process -Id $workerPid -ErrorAction SilentlyContinue
      $process=Get-Process -Id $workerPid -ErrorAction SilentlyContinue
      if($process -and -not $process.WaitForExit(10000)){throw 'Previous worker did not stop; source files were not replaced'}
    }
  }
}
foreach($name in @('common.py','native_host.py','worker.py')){
  $source=Join-Path $PSScriptRoot $name
  if(-not (Test-Path -LiteralPath $source -PathType Leaf)){throw "Missing bridge source: $name"}
  $dest=Join-Path $code $name;Assert-Plain $dest
  if([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($dest)){Copy-Item -LiteralPath $source -Destination $dest -Force}
}
$hostPath=Join-Path $app 'native-host.cmd'
Write-Utf8 $hostPath ('@echo off'+"`r`n"+'"'+$PythonPath+'" -X utf8 "'+(Join-Path $code 'native_host.py')+'" --config "'+$configPath+'" %*'+"`r`n")
$manifestPath=Join-Path $app 'com.openlinks.claude_folder.json'
$manifest=[ordered]@{name='com.openlinks.claude_folder';description='OpenLinks local Claude Code folder bridge';path=$hostPath;type='stdio';allowed_origins=@('chrome-extension://'+$ExtensionId+'/')}
Write-Utf8 $manifestPath ($manifest | ConvertTo-Json -Depth 5)
$registry='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.openlinks.claude_folder'
New-Item -Path $registry -Force | Out-Null
Set-Item -Path $registry -Value $manifestPath
$ws=New-Object -ComObject WScript.Shell
function Worker-Shortcut([string]$Path){
  $shortcut=$ws.CreateShortcut($Path);$shortcut.TargetPath=$pythonw;$shortcut.Arguments='-X utf8 "'+$workerPath+'" --config "'+$configPath+'" --loop';$shortcut.WorkingDirectory=$code;$shortcut.Description='OpenLinks Claude folder worker';$shortcut.Save()
}
Worker-Shortcut (Join-Path $Folder 'Start worker.lnk')
if($AutoStart){Worker-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'OpenLinks Claude worker.lnk')}
$login='@echo off'+"`r`n"+'set ANTHROPIC_API_KEY='+"`r`n"+'set ANTHROPIC_AUTH_TOKEN='+"`r`n"+'set CLAUDE_CODE_OAUTH_TOKEN='+"`r`n"
if($settings.claudePath){$login+='"'+$settings.claudePath+'" auth login --claudeai'+"`r`n"+'"'+$settings.claudePath+'" auth status --text'+"`r`n"}
else{$login+='echo Install Claude Code, then rerun Install-Bridge.ps1 with -ClaudePath.'+"`r`n"+'echo Official installation: winget install Anthropic.ClaudeCode'+"`r`n"}
$login+='pause'+"`r`n";Write-Utf8 (Join-Path $Folder 'Login Claude.cmd') $login
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'README.md')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $Folder 'README.md') -Force}
if(-not $NoStart){Start-Process -FilePath $pythonw -ArgumentList @('-X','utf8',('"'+$workerPath+'"'),'--config',('"'+$configPath+'"'),'--loop') -WorkingDirectory $code | Out-Null}
[ordered]@{installed=$true;folder=$Folder;nativeHost=$manifestPath;claudeAvailable=[bool]$settings.claudePath;processingEnabled=$false;autoStart=[bool]$AutoStart}|ConvertTo-Json -Compress
