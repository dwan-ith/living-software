Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName System.Windows.Forms

$window = New-Object Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.Width = 260
$window.Height = 92
$window.Left = 100
$window.Top = 100

$root = New-Object Windows.Controls.Grid
$root.IsHitTestVisible = $false

$panel = New-Object Windows.Controls.Border
$panel.Width = 230
$panel.Height = 54
$panel.CornerRadius = 7
$panel.Background = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromArgb(218, 15, 21, 27))
$panel.BorderBrush = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromArgb(58, 255, 255, 255))
$panel.BorderThickness = 1
$panel.Margin = '24,18,0,0'

$stack = New-Object Windows.Controls.StackPanel
$stack.Orientation = 'Horizontal'
$stack.Margin = '8,8,10,8'

$orb = New-Object Windows.Shapes.Ellipse
$orb.Width = 20
$orb.Height = 20
$orb.Fill = [Windows.Media.Brushes]::Black
$orb.Stroke = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(79, 240, 184))
$orb.StrokeThickness = 2
$orb.Margin = '0,7,9,0'

$copy = New-Object Windows.Controls.StackPanel
$title = New-Object Windows.Controls.TextBlock
$title.Text = 'Living companion'
$title.Foreground = [Windows.Media.Brushes]::White
$title.FontSize = 11
$title.FontWeight = 'Bold'
$body = New-Object Windows.Controls.TextBlock
$body.Text = 'Watching desktop context'
$body.Foreground = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromArgb(150, 255, 255, 255))
$body.FontSize = 10
$body.Margin = '0,4,0,0'
$copy.Children.Add($title) | Out-Null
$copy.Children.Add($body) | Out-Null

$stack.Children.Add($orb) | Out-Null
$stack.Children.Add($copy) | Out-Null
$panel.Child = $stack
$root.Children.Add($panel) | Out-Null
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
$timer.Interval = [TimeSpan]::FromMilliseconds(28)
$timer.Add_Tick({
    $cursor = [System.Windows.Forms.Cursor]::Position
    $window.Left = [Math]::Min($cursor.X + 18, [System.Windows.SystemParameters]::VirtualScreenWidth - $window.Width)
    $window.Top = [Math]::Min($cursor.Y + 18, [System.Windows.SystemParameters]::VirtualScreenHeight - $window.Height)
})
$timer.Start()

$window.ShowDialog() | Out-Null
