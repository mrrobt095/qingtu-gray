$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
try {
  $runtime = Join-Path $appRoot 'runtime\node.exe'
  $server = Join-Path $appRoot 'server.cjs'
  if (!(Test-Path -LiteralPath $runtime) -or !(Test-Path -LiteralPath $server)) { throw 'Please extract the complete ZIP before starting.' }
  Start-Process -FilePath $runtime -ArgumentList ('"' + $server + '"') -WorkingDirectory $appRoot -WindowStyle Hidden
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Qingtu') | Out-Null
}
