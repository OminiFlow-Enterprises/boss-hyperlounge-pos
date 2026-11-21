$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ticket = [System.Drawing.Image]::FromFile($env:POS_KOT_IMAGE)
$job = [System.Drawing.Printing.PrintDocument]::new()
try {
    $job.DocumentName = 'Restaurant KOT'
    $job.PrinterSettings.PrinterName = $env:POS_KOT_QUEUE
    if (-not $job.PrinterSettings.IsValid) {
        throw "Printer queue unavailable: $env:POS_KOT_QUEUE"
    }

    # PrintDocument sizes use hundredths of an inch. These settings apply to this job.
    $ticketHeight = [int]::Parse($env:POS_KOT_HEIGHT_PX) * 100 / 96
    $paperWidth = [int][Math]::Ceiling(80 * 100 / 25.4)
    $paperHeight = [int][Math]::Ceiling($ticketHeight)
    $job.DefaultPageSettings.PaperSize = [System.Drawing.Printing.PaperSize]::new(
        'KOT Roll', $paperWidth, $paperHeight
    )
    $job.DefaultPageSettings.Landscape = $false
    $job.DefaultPageSettings.Margins = [System.Drawing.Printing.Margins]::new(0, 0, 0, 0)
    $job.OriginAtMargins = $false
    $job.PrintController = [System.Drawing.Printing.StandardPrintController]::new()
    $job.add_PrintPage({
        param($sender, $page)
        $ticketWidth = 72 * 100 / 25.4
        $left = [Math]::Max(0, (4 * 100 / 25.4) - $page.PageSettings.HardMarginX)
        # With OriginAtMargins disabled, y=0 is the first printable row.
        $page.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Display
        $page.Graphics.DrawImage($ticket, [System.Drawing.RectangleF]::new(
            $left, 0, $ticketWidth, $ticketHeight
        ))
        $page.HasMorePages = $false
    })
    $job.Print()
} finally {
    $job.Dispose()
    $ticket.Dispose()
}
