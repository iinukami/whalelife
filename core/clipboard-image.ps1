# Reads the Windows clipboard bitmap and prints it as base64 PNG.
# Used by /api/clipboard-image when the browser cannot decode a pasted image
# (WeChat screenshots often reach Chromium as a bare DIB that fails to decode).
# Must run in an STA apartment: -STA is required for Clipboard::GetImage().
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
} catch {
  [Console]::Out.Write("ERROR:" + $_.Exception.Message)
  exit 4
}
if ($null -eq $img) {
  [Console]::Out.Write("NOIMAGE")
  exit 3
}
$stream = New-Object System.IO.MemoryStream
$img.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
$stream.Dispose()
$img.Dispose()
