[CmdletBinding()]param()
$ErrorActionPreference='Stop'
$app=Join-Path $env:LOCALAPPDATA 'OpenLinksClaude'
$configPath=Join-Path $app 'config.json'
if(Test-Path -LiteralPath $configPath){
  $config=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $config.enabled=$false
  [IO.File]::WriteAllText($configPath,($config|ConvertTo-Json -Depth 5),(New-Object System.Text.UTF8Encoding($false)))
  $runtimePath=Join-Path $config.folder 'state\worker.json'
  if(Test-Path -LiteralPath $runtimePath){
    $runtime=Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $workerPid=0
    if([int]::TryParse([string]$runtime.pid,[ref]$workerPid) -and $workerPid -gt 0){
      $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$workerPid) -ErrorAction SilentlyContinue
      if($process -and $process.CommandLine -match [regex]::Escape((Join-Path $app 'bridge\worker.py'))){
        $deadline=(Get-Date).AddSeconds(20)
        do {
          $runtime=Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
          if($runtime.status -eq 'disabled' -and -not $runtime.jobId){break}
          if(-not (Get-Process -Id $workerPid -ErrorAction SilentlyContinue)){break}
          if((Get-Date) -ge $deadline){throw 'Worker has not stopped its active job. Processing is disabled; retry uninstall after it stops'}
          Start-Sleep -Milliseconds 200
        } while($true)
        Stop-Process -Id $workerPid -ErrorAction SilentlyContinue
      }
    }
  }
}
$shortcut=Join-Path ([Environment]::GetFolderPath('Startup')) 'OpenLinks Claude worker.lnk'
if(Test-Path -LiteralPath $shortcut){Remove-Item -LiteralPath $shortcut}
$registry='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.openlinks.claude_folder'
if(Test-Path -LiteralPath $registry){Remove-Item -LiteralPath $registry}
Write-Output 'Bridge disconnected. Queue, reports, Claude authorization and source files were preserved.'
