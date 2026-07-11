Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName System.Windows.Forms

$window = New-Object Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.Width = 34
$window.Height = 34
$window.Left = 100
$window.Top = 100

$root = New-Object Windows.Controls.Canvas
$root.Width = 34
$root.Height = 34
$root.IsHitTestVisible = $false

$shadow = New-Object Windows.Shapes.Polygon
$shadow.Points = [Windows.Media.PointCollection]::Parse('4,3 29,14 19,18 14,31')
$shadow.Fill = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromArgb(90, 0, 0, 0))
$shadow.RenderTransform = New-Object Windows.Media.TranslateTransform(2, 2)

$arrow = New-Object Windows.Shapes.Polygon
$arrow.Points = [Windows.Media.PointCollection]::Parse('4,3 29,14 19,18 14,31')
$arrow.Fill = [Windows.Media.Brushes]::Black
$arrow.Stroke = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(79, 240, 184))
$arrow.StrokeThickness = 1.35

$pulse = New-Object Windows.Shapes.Ellipse
$pulse.Width = 5
$pulse.Height = 5
$pulse.Fill = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(79, 240, 184))
[Windows.Controls.Canvas]::SetLeft($pulse, 16)
[Windows.Controls.Canvas]::SetTop($pulse, 15)

$root.Children.Add($shadow) | Out-Null
$root.Children.Add($arrow) | Out-Null
$root.Children.Add($pulse) | Out-Null
$window.Content = $root

$sourceInitialized = {
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
    $hwnd = $helper.Handle
    $GWL_EXSTYLE = -20
    $WS_EX_TRANSPARENT = 0x20
    $WS_EX_TOOLWINDOW = 0x80
    $WS_EX_NOACTIVATE = 0x08000000
    $current = [Native]::GetWindowLong($hwnd, $GWL_EXSTYLE)
    [Native]::SetWindowLong($hwnd, $GWL_EXSTYLE, $current -bor $WS_EX_TRANSPARENT -bor $WS_EX_TOOLWINDOW -bor $WS_EX_NOACTIVATE) | Out-Null
}

$nativeCode = @'
using System;
using System.Runtime.InteropServices;
public static class Native {
    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
'@
Add-Type $nativeCode
$window.Add_SourceInitialized($sourceInitialized)

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(24)
$timer.Add_Tick({
    $cursor = [System.Windows.Forms.Cursor]::Position
    $window.Left = [Math]::Min($cursor.X + 12, [System.Windows.SystemParameters]::VirtualScreenWidth - $window.Width)
    $window.Top = [Math]::Min($cursor.Y + 12, [System.Windows.SystemParameters]::VirtualScreenHeight - $window.Height)
})
$timer.Start()

$window.ShowDialog() | Out-Null
