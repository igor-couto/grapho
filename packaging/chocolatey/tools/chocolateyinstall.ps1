$ErrorActionPreference = 'Stop'

$version = '0.1.1'
$baseUrl = "https://github.com/igor-couto/grapho/releases/download/v$version"

# Windows reports ARM64 natively, or in PROCESSOR_ARCHITEW6432 when this
# process runs under emulation. Chocolatey ships no 32-bit build.
$isArm64 = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'

if ($isArm64) {
    $url = "$baseUrl/grapho-$version-windows-aarch64.zip"
    $checksum = '2F1F58F164D213D657288AA641A192091111CFD1B2D018A3B0310C828D06640F'
    $folder = "grapho-$version-windows-aarch64"
} else {
    $url = "$baseUrl/grapho-$version-windows-x86_64.zip"
    $checksum = 'B7F37895C1F5D07621742229E2E98C34B21CB57EDFAFDCA1FB514C0E5994024A'
    $folder = "grapho-$version-windows-x86_64"
}

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

$packageArgs = @{
    packageName    = 'grapho'
    unzipLocation  = $toolsDir
    fileType       = 'zip'
    url64bit       = $url
    checksum64     = $checksum
    checksumType64 = 'sha256'
}

Install-ChocolateyZipPackage @packageArgs

# The zip keeps its top-level folder, so point the shim at the binary inside it
# instead of relying on shim discovery.
Install-BinFile -Name 'grapho' -Path (Join-Path $toolsDir "$folder\grapho.exe")
