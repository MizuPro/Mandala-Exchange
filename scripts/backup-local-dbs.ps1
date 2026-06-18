param(
  [string]$OutputDir = "backups"
)

$ErrorActionPreference = "Stop"

# Untuk non-interactive use, set environment variable PGPASSWORD sebelum menjalankan script,
# atau konfigurasi file .pgpass (Linux/macOS) / pgpass.conf (Windows).
# Contoh: $env:PGPASSWORD = "your_password"

if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
  throw "pg_dump tidak ditemukan di PATH. Tambahkan PostgreSQL bin directory ke PATH atau jalankan dari shell PostgreSQL."
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$targets = @(
  @{ Name = "mandala_sekuritas"; Host = "localhost"; Port = "5432"; User = "postgres"; Database = "mandala_sekuritas" },
  @{ Name = "mandala_mats"; Host = "localhost"; Port = "5434"; User = "mandala_mats"; Database = "mandala_mats" },
  @{ Name = "mandala_bei"; Host = "localhost"; Port = "5441"; User = "mandala_bei"; Database = "mandala_bei" }
)

$failures = @()

foreach ($target in $targets) {
  $file = Join-Path $OutputDir "$($target.Name)_$timestamp.sql"
  Write-Host "Backing up $($target.Database) to $file"
  try {
    pg_dump -h $target.Host -p $target.Port -U $target.User -d $target.Database -f $file
    if ($LASTEXITCODE -ne 0) {
      throw "pg_dump exited with code $LASTEXITCODE"
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
