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

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
  throw "psql tidak ditemukan di PATH. Tambahkan PostgreSQL bin directory ke PATH atau jalankan dari shell PostgreSQL."
}

$config = switch ($Target) {
  "sekuritas" { @{ Host = "localhost"; Port = "5432"; User = "postgres"; Database = "mandala_sekuritas" } }
  "mats" { @{ Host = "localhost"; Port = "5434"; User = "mandala_mats"; Database = "mandala_mats" } }
  "bei" { @{ Host = "localhost"; Port = "5441"; User = "mandala_bei"; Database = "mandala_bei" } }
}

$confirm = Read-Host "Restore akan menimpa data di $($config.Database). Lanjutkan? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
  Write-Host "Restore dibatalkan."
  exit 0
}

Write-Host "Restoring $($config.Database) from $BackupFile"
psql -h $config.Host -p $config.Port -U $config.User -d $config.Database -1 -f $BackupFile
Write-Host "Restore selesai."
