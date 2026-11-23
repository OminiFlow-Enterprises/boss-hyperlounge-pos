$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$image = [System.Drawing.Image]::FromFile($env:POS_SLIP_IMAGE)
$job = [System.Drawing.Printing.PrintDocument]::new()
$attributes = [System.Drawing.Imaging.ImageAttributes]::new()
$sharpBill = $env:POS_SLIP_SHARP_BILL -eq '1'
try {
    if ($sharpBill) { $attributes.SetThreshold(0.8) }
    $job.DocumentName = 'BOSS POS Slip'
    $queue = $env:POS_SLIP_QUEUE
    if (-not $queue) {
        $preferred = $env:POS_SLIP_PREFERRED_QUEUE
        if ($preferred -and [System.Drawing.Printing.PrinterSettings]::InstalledPrinters -contains $preferred) {
            $queue = $preferred
        }
        if (-not $queue) {
            $directPrinters = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction SilentlyContinue | Where-Object {
                $_.Local -and $_.PortName -match '^(USB|DOT4|ESDPRT)\d+$'
            })
            $defaultDirect = $directPrinters | Where-Object Default | Select-Object -First 1
            if ($defaultDirect) {
                $queue = $defaultDirect.Name
            } elseif ($directPrinters.Count -eq 1) {
                $queue = $directPrinters[0].Name
            }
        }
        if (-not $queue -and $job.PrinterSettings.IsValid) {
            $default = $job.PrinterSettings.PrinterName
            if ($default -and $default -notmatch 'PDF|XPS|OneNote|Fax') {
                $queue = $default
            }
        }
        if (-not $queue) {
            throw 'Set the intended receipt printer as the Windows default printer, then reprint the KOT.'
        }
    }
    $job.PrinterSettings.PrinterName = $queue
    if (-not $job.PrinterSettings.IsValid) {
        throw "Printer queue unavailable: $queue"
    }

    # PrintDocument uses hundredths of an inch. CSS layout uses 96 pixels per inch.
    $imageWidth = [int]$env:POS_SLIP_WIDTH_PX * 100 / 96
    $imageHeight = [int]$env:POS_SLIP_HEIGHT_PX * 100 / 96
    $page = $job.DefaultPageSettings
    $page.Landscape = $false
    $roll80 = [int][Math]::Round(80 * 100 / 25.4)
    $width = [Math]::Min($roll80, $page.PaperSize.Width)
    $printableWidth = $page.PrintableArea.Width
    if ($printableWidth -le 0) { throw 'The printer did not report a printable width' }
    $availableWidth = [Math]::Min([double]$width, [double]$printableWidth) - 2
    if ($availableWidth -le 0) { throw 'The printer reported an empty printable area' }
    $scale = [Math]::Min([double]1, $availableWidth / $imageWidth)
    $height = [int][Math]::Ceiling($imageHeight * $scale + $page.HardMarginY + 8)
    $page.PaperSize = [System.Drawing.Printing.PaperSize]::new('POS Slip Roll', $width, $height)
    $page.Margins = [System.Drawing.Printing.Margins]::new(0, 0, 0, 0)
    $job.OriginAtMargins = $false
    $job.PrintController = [System.Drawing.Printing.StandardPrintController]::new()
    $job.add_PrintPage({
        param($sender, $eventArgs)
        $eventArgs.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Display
        $eventArgs.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $area = $eventArgs.PageSettings.PrintableArea
        $drawAreaWidth = [Math]::Min([double]$width, [double]$area.Width)
        $drawScale = [Math]::Min($scale, [Math]::Min(($drawAreaWidth - 2) / $imageWidth, ($area.Height - 1) / $imageHeight))
        if ($drawScale -le 0) { throw 'The printer reported an empty printable area' }
        $drawWidth = $imageWidth * $drawScale
        $left = ($drawAreaWidth - $drawWidth) / 2
        if ($sharpBill) {
            $eventArgs.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
            $destination = [System.Drawing.Rectangle]::new(
                [int][Math]::Round($left), 0, [int][Math]::Round($drawWidth), [int][Math]::Round($imageHeight * $drawScale)
            )
            $eventArgs.Graphics.DrawImage($image, $destination, 0, 0, $image.Width, $image.Height,
                [System.Drawing.GraphicsUnit]::Pixel, $attributes)
        } else {
            $eventArgs.Graphics.DrawImage($image, [System.Drawing.RectangleF]::new(
                $left, 0, $drawWidth, $imageHeight * $drawScale
            ))
        }
        $eventArgs.HasMorePages = $false
    })
    $job.Print()
} finally {
    $attributes.Dispose()
    $job.Dispose()
    $image.Dispose()
}
