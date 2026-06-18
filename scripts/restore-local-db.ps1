param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("sekuritas", "mats", "bei")]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [string]$BackupFile
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $BackupFile)) {
  throw "Backup file tidak ditemukan: $BackupFile"
}

$config = switch ($Target) {
  "sekuritas" { @{ Host = "localhost"; Port = "5432"; User = "postgres"; Password = "postgres"; Database = "mandala_sekuritas"; Container = "mandala-sekuritas-postgres" } }
  "mats" { @{ Host = "localhost"; Port = "5434"; User = "mandala_mats"; Password = "mandala_mats"; Database = "mandala_mats"; Container = "mandala-mats-postgres" } }
  "bei" { @{ Host = "localhost"; Port = "5441"; User = "mandala_bei"; Password = "mandala_bei"; Database = "mandala_bei"; Container = "mandala-bei-postgres" } }
}

$confirm = Read-Host "Restore akan menimpa data di $($config.Database). Lanjutkan? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
  Write-Host "Restore dibatalkan."
  exit 0
}

Write-Host "Restoring $($config.Database) from $BackupFile"
if (Get-Command psql -ErrorAction SilentlyContinue) {
  $oldPassword = $env:PGPASSWORD
  $env:PGPASSWORD = $config.Password
  try {
    psql -h $config.Host -p $config.Port -U $config.User -d $config.Database -1 -f $BackupFile
  } finally {
    $env:PGPASSWORD = $oldPassword
  }
} elseif (Get-Command docker -ErrorAction SilentlyContinue) {
  Get-Content -LiteralPath $BackupFile -Raw | docker exec -i -e "PGPASSWORD=$($config.Password)" $config.Container psql -U $config.User -d $config.Database -1
} else {
  throw "psql dan docker tidak ditemukan di PATH."
}
Write-Host "Restore selesai."
