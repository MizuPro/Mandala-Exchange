param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

function New-Secret {
  $bytes = New-Object byte[] 48
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Set-EnvValue {
  param(
    [string]$Path,
    [string]$Name,
    [string]$Value
  )
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $rootResolved = [System.IO.Path]::GetFullPath($Root)
  if (-not $resolved.StartsWith($rootResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to edit an environment file outside the project"
  }
  $lines = [System.Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $resolved) {
    foreach ($line in [System.IO.File]::ReadAllLines($resolved)) {
      $lines.Add($line)
    }
  }
  $replacement = "$Name=$Value"
  $found = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index].StartsWith("$Name=")) {
      $lines[$index] = $replacement
      $found = $true
      break
    }
  }
  if (-not $found) {
    $lines.Add($replacement)
  }
  [System.IO.File]::WriteAllLines($resolved, $lines, [System.Text.UTF8Encoding]::new($false))
}

$adminToken = New-Secret
$matsToBeiToken = New-Secret
$sekuritasToBeiToken = New-Secret
$readonlyToken = New-Secret
$botToBeiToken = New-Secret
$beiToSekuritasToken = New-Secret
$bankWebhookSecret = New-Secret

$identities = @(
  @{ name = "admin"; token = $adminToken; scopes = @("admin:*") },
  @{ name = "mats"; token = $matsToBeiToken; scopes = @("market:read", "rules:read", "broker:read", "trade:capture", "market-summary:write", "session:write") },
  @{ name = "sekuritas"; token = $sekuritasToBeiToken; scopes = @("market:read", "rules:read", "broker:read", "settlement:read", "custody:read", "custody:write", "corporate-action:read", "ipo:read", "ipo:write", "report:read") },
  @{ name = "readonly"; token = $readonlyToken; scopes = @("market:read", "rules:read", "broker:read", "corporate-action:read", "report:read") },
  @{ name = "bot"; token = $botToBeiToken; scopes = @("market:read", "rules:read", "corporate-action:read", "ipo:read") }
)
$identityJson = $identities | ConvertTo-Json -Compress -Depth 5

Set-EnvValue -Path (Join-Path $Root "BEI/.env.production") -Name "BEI_SERVICE_TOKENS" -Value "'$identityJson'"
Set-EnvValue -Path (Join-Path $Root "BEI/.env.production") -Name "BEI_TO_SEKURITAS_TOKEN" -Value $beiToSekuritasToken
Set-EnvValue -Path (Join-Path $Root "MATS/.env.production") -Name "BEI_SERVICE_TOKEN" -Value $matsToBeiToken
Set-EnvValue -Path (Join-Path $Root "SEKURITAS/backend/.env.production") -Name "BEI_SERVICE_TOKEN" -Value $sekuritasToBeiToken
Set-EnvValue -Path (Join-Path $Root "SEKURITAS/backend/.env.production") -Name "BEI_TO_SEKURITAS_TOKEN" -Value $beiToSekuritasToken
Set-EnvValue -Path (Join-Path $Root "SEKURITAS/backend/.env.production") -Name "WEBHOOK_SECRET" -Value $bankWebhookSecret
Set-EnvValue -Path (Join-Path $Root "BOT/.env.production") -Name "BEI_SERVICE_TOKEN" -Value $botToBeiToken

Write-Output "Production internal service tokens rotated and synchronized."
