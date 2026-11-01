# Draws the Pulsar logo (three rounded bars) and writes a multi-size .ico
# with PNG frames. Usage: powershell -File make-icon.ps1 -Out ..\launcher\pulsar.ico
param([string]$Out = "pulsar.ico")
Add-Type -AssemblyName System.Drawing

function RoundRect($g, $brush, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Min($r * 2, [Math]::Min($w, $h))
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  $g.FillPath($brush, $p)
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$frames = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $s / 32.0
  RoundRect $g (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 11, 13, 18))) 0 0 $s $s (8 * $k)
  RoundRect $g (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 211, 238))) (6.5 * $k) (10 * $k) (4.5 * $k) (12 * $k) (2.25 * $k)
  RoundRect $g (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)) (13.75 * $k) (5 * $k) (4.5 * $k) (22 * $k) (2.25 * $k)
  RoundRect $g (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 159, 28))) (21 * $k) (12 * $k) (4.5 * $k) (8 * $k) (2.25 * $k)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames += ,@($s, $ms.ToArray())
  $bmp.Dispose()
}

$fs = [System.IO.File]::Create($Out)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($f in $frames) {
  $s = $f[0]; $data = $f[1]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$data.Length); $w.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($f in $frames) { $w.Write([byte[]]$f[1]) }
$w.Close()
"Icon geschrieben: $Out"
