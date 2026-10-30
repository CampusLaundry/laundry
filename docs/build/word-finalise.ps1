# Opens the report in Microsoft Word, fills in the table of contents and page numbers,
# saves it, and exports a PDF copy next to it.
# Usage: powershell -File docs/build/word-finalise.ps1
param([string]$Docx = "$PSScriptRoot\..\Laundry-Report.docx")

$Docx = (Resolve-Path $Docx).Path
$Pdf = [IO.Path]::ChangeExtension($Docx, '.pdf')
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($Docx)
    foreach ($toc in $doc.TablesOfContents) { $toc.Update() }
    $doc.Fields.Update() | Out-Null
    $doc.Save()
    $doc.ExportAsFixedFormat($Pdf, 17)   # 17 = PDF
    "Pages: $($doc.ComputeStatistics(2))"
    $doc.Close()
    "Saved $Docx and $Pdf"
} finally {
    $word.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}

