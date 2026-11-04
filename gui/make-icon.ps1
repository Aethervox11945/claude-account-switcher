# Draws gui/AccountSwitcher/app.ico: two arrows trading places on a rounded tile.
# Only needed to change the icon; the result is checked in.

Add-Type -AssemblyName System.Drawing

function New-Frame([int] $Size) {
  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = 'AntiAlias'
  $s = $Size / 256.0

  $r = 56 * $s
  $edge = $Size - 1
  $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tile.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
  $tile.AddArc($edge - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
  $tile.AddArc($edge - 2 * $r, $edge - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $tile.AddArc(0, $edge - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $tile.CloseFigure()
  $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point $Size, $Size),
    [System.Drawing.Color]::FromArgb(255, 47, 111, 237), [System.Drawing.Color]::FromArgb(255, 20, 164, 160))
  $g.FillPath($fill, $tile)

  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (22 * $s)
  $pen.StartCap = 'Round'
  $pen.EndCap = 'Round'
  $pen.LineJoin = 'Round'
  # Top arrow to the right, bottom arrow to the left.
  $g.DrawLine($pen, 58 * $s, 96 * $s, 192 * $s, 96 * $s)
  $g.DrawLines($pen, [System.Drawing.PointF[]] @(
      (New-Object System.Drawing.PointF (150 * $s), (54 * $s)),
      (New-Object System.Drawing.PointF (192 * $s), (96 * $s)),
      (New-Object System.Drawing.PointF (150 * $s), (138 * $s))))
  $g.DrawLine($pen, 198 * $s, 160 * $s, 64 * $s, 160 * $s)
  $g.DrawLines($pen, [System.Drawing.PointF[]] @(
      (New-Object System.Drawing.PointF (106 * $s), (118 * $s)),
      (New-Object System.Drawing.PointF (64 * $s), (160 * $s)),
      (New-Object System.Drawing.PointF (106 * $s), (202 * $s))))
  $g.Dispose()

  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  , $stream.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$frames = @($sizes | ForEach-Object { , (New-Frame $_) })

$out = Join-Path $PSScriptRoot 'AccountSwitcher\app.ico'
$file = [System.IO.File]::Create($out)
$w = New-Object System.IO.BinaryWriter $file
$w.Write([uint16] 0); $w.Write([uint16] 1); $w.Write([uint16] $sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $side = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([byte] $side); $w.Write([byte] $side); $w.Write([byte] 0); $w.Write([byte] 0)
  $w.Write([uint16] 1); $w.Write([uint16] 32)
  $w.Write([uint32] $frames[$i].Length); $w.Write([uint32] $offset)
  $offset += $frames[$i].Length
}
foreach ($frame in $frames) { $w.Write([byte[]] $frame) }
$w.Close()
"wrote $out"
