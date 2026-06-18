param(
  [string]$OutputDir = "backups"
)

$ErrorActionPreference = "Stop"

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$targets = @(
  @{ Name = "mandala_sekuritas"; Host = "localhost"; Port = "5432"; User = "postgres"; Password = "postgres"; Database = "mandala_sekuritas"; Container = "mandala-sekuritas-postgres" },
  @{ Name = "mandala_mats"; Host = "localhost"; Port = "5434"; User = "mandala_mats"; Password = "mandala_mats"; Database = "mandala_mats"; Container = "mandala-mats-postgres" },
  @{ Name = "mandala_bei"; Host = "localhost"; Port = "5441"; User = "mandala_bei"; Password = "mandala_bei"; Database = "mandala_bei"; Container = "mandala-bei-postgres" }
)

$failures = @()
$hasLocalPgDump = [bool](Get-Command pg_dump -ErrorAction SilentlyContinue)
$hasDocker = [bool](Get-Command docker -ErrorAction SilentlyContinue)

foreach ($target in $targets) {
  $file = Join-Path $OutputDir "$($target.Name)_$timestamp.sql"
  Write-Host "Backing up $($target.Database) to $file"
  try {
    if ($hasLocalPgDump) {
      $oldPassword = $env:PGPASSWORD
      $env:PGPASSWORD = $target.Password
      try {
        pg_dump -h $target.Host -p $target.Port -U $target.User -d $target.Database -f $file
      } finally {
        $env:PGPASSWORD = $oldPassword
      }
      if ($LASTEXITCODE -ne 0) {
        throw "pg_dump exited with code $LASTEXITCODE"
      }
    } elseif ($hasDocker) {
      docker exec -e "PGPASSWORD=$($target.Password)" $target.Container pg_dump -U $target.User -d $target.Database | Out-File -FilePath $file -Encoding utf8
      if ($LASTEXITCODE -ne 0) {
        throw "docker exec pg_dump exited with code $LASTEXITCODE"
      }
    } else {
      throw "pg_dump dan docker tidak ditemukan di PATH."
    }
    Write-Host "  OK: $($target.Database)" -ForegroundColor Green
  } catch {
    Write-Host "  GAGAL: $($target.Database) - $_" -ForegroundColor Red
    $failures += $target.Database
  }
}

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host "Backup selesai dengan $($failures.Count) kegagalan:" -ForegroundColor Yellow
  foreach ($db in $failures) {
    Write-Host "  - $db" -ForegroundColor Red
  }
} else {
  Write-Host "Backup selesai. Semua database berhasil di-backup." -ForegroundColor Green
}
Write-Host "Simpan salinan file backup di external drive atau cloud pribadi."
