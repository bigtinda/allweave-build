param([string]$InputPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
$extension = [IO.Path]::GetExtension($InputPath).ToLowerInvariant()
$kind = if ($extension -in '.doc','.docx') { 'word' } elseif ($extension -in '.xls','.xlsx') { 'excel' } else { 'ppt' }
$ids = switch ($kind) { word { @('KWPS.Application','Word.Application') } excel { @('KET.Application','Excel.Application') } ppt { @('KWPP.Application','PowerPoint.Application') } }
$comApp = $null
$document = $null
try {
    foreach ($id in $ids) { try { $comApp = New-Object -ComObject $id; break } catch {} }
    if (!$comApp) { throw 'Office automation unavailable' }
    try { $comApp.AutomationSecurity = 3 } catch {}
    if ($kind -eq 'word') {
        $comApp.Visible = $false
        $comApp.DisplayAlerts = 0
        $document = $comApp.Documents.Open($InputPath, $false, $true)
        $document.ExportAsFixedFormat($OutputPath, 17)
    } elseif ($kind -eq 'excel') {
        $comApp.Visible = $false
        $comApp.DisplayAlerts = $false
        $document = $comApp.Workbooks.Open($InputPath, 0, $true)
        $document.ExportAsFixedFormat(0, $OutputPath)
    } else {
        $document = $comApp.Presentations.Open($InputPath, $true, $false, $false)
        $document.SaveAs($OutputPath, 32)
    }
} finally {
    if ($document) { try { if ($kind -eq 'word') { $document.Close(0) } else { $document.Close() } } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
    if ($comApp) { try { $comApp.Quit() } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($comApp) }
}
