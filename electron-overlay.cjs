const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

let overlayWindow;

function overlayUrl() {
    return process.env.ELECTRON_OVERLAY_URL
        || process.env.VITE_DEV_SERVER_URL
        || 'http://127.0.0.1:5173';
}

app.commandLine.appendSwitch('enable-transparent-visuals');
app.disableHardwareAcceleration();

app.on('ready', () => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { x, y, width, height } = primaryDisplay.bounds;

    overlayWindow = new BrowserWindow({
        x,
        y,
        width,
        height,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        resizable: false,
        focusable: false,       // Prevent the overlay from stealing focus
        webPreferences: {
            // The renderer only displays the Vite surface; it must never have
            // Node access. A compromised web page here would otherwise own the machine.
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            backgroundThrottling: false
        }
    });

    // Pass-through by default — clicks go to the real OS apps beneath
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.setAlwaysOnTop(true, 'screen-saver'); // highest level
    overlayWindow.setVisibleOnAllWorkspaces(true);

    // Load the existing Vite dev server (no re-build needed!)
    overlayWindow.loadURL(overlayUrl());

    // Signal to React that it is living inside the Electron overlay
    overlayWindow.webContents.on('did-finish-load', () => {
        overlayWindow.webContents.executeJavaScript(`
            window.__IS_OVERLAY__ = true;
            document.documentElement.classList.add('overlay-mode');
        `);
    });

    // Send REAL OS cursor X,Y to the React overlay at 60fps
    setInterval(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            const point = screen.getCursorScreenPoint();
            overlayWindow.webContents.send('os-cursor-update', { x: point.x - x, y: point.y - y });
        }
    }, 16);
});

// When an intervention fires, React sends this so the companion becomes clickable
ipcMain.on('claim-focus', () => {
    overlayWindow.setIgnoreMouseEvents(false);
    overlayWindow.setFocusable(true);
    overlayWindow.focus();
});

// When dismissed, go back to click-through pass-through mode
ipcMain.on('release-focus', () => {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.setFocusable(false);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

