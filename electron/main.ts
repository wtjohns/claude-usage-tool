import { app, BrowserWindow, ipcMain, Tray, nativeImage, Menu, screen, dialog } from 'electron';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { scrapeClaudeUsage, scrapeBillingInfo, openLoginWindow, openPlatformLoginWindow, isAuthenticated } from './scraper';

// Disable default error dialogs in production
if (app.isPackaged) {
  dialog.showErrorBox = () => {};
}

// Handle uncaught exceptions to prevent crashes from EPIPE errors
process.on('uncaughtException', (error) => {
  // Ignore EPIPE errors which occur when writing to closed pipes
  if (error.message?.includes('EPIPE')) {
    return;
  }
  // In dev mode, log to console; in prod, silently ignore non-critical errors
  if (!app.isPackaged) {
    console.error('Uncaught exception:', error);
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message?.includes('EPIPE')) {
    return;
  }
  if (!app.isPackaged) {
    console.error('Unhandled rejection:', reason);
  }
});

// Load environment variables - try multiple paths
const envPaths = [
  path.join(__dirname, '..', '.env.local'),
  path.join(app.getAppPath(), '.env.local'),
  path.join(process.cwd(), '.env.local'),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    console.log('Loading .env.local from:', envPath);
    dotenv.config({ path: envPath });
    break;
  }
}

console.log('Admin key configured:', !!process.env.ANTHROPIC_ADMIN_KEY);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let refreshInterval: NodeJS.Timeout | null = null;

const isDev = !app.isPackaged;

// Activity log system - keep last 20 entries
interface LogEntry {
  timestamp: string;
  message: string;
}
const activityLogs: LogEntry[] = [];
const MAX_LOGS = 20;

function addLog(message: string) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    message
  };
  activityLogs.push(entry);
  if (activityLogs.length > MAX_LOGS) {
    activityLogs.shift();
  }
  console.log(`[${entry.timestamp}] ${message}`);
}

function getRecentLogs(count: number = 6): LogEntry[] {
  return activityLogs.slice(-count);
}

async function getFiveHourUtilization(): Promise<string> {
  try {
    const keychainOutput = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: 'utf8' }
    ).trim();

    const credentials = JSON.parse(keychainOutput);
    const token = credentials?.claudeAiOauth?.accessToken;
    if (!token) return '–';

    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.0.32',
      },
    });

    if (!response.ok) return '–';

    const data = await response.json() as { five_hour?: { utilization?: number } };
    const utilization = data?.five_hour?.utilization;
    if (utilization === undefined || utilization === null) return '–';

    return `${Math.round(utilization * 100)}%`;
  } catch {
    return '–';
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 320,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // In production, __dirname is inside app.asar/dist-electron
    // So we need to go up one level to get to dist/index.html
    const htmlPath = path.join(__dirname, '..', 'dist', 'index.html');
    console.log('Loading HTML from:', htmlPath);
    mainWindow.loadFile(htmlPath);
  }

  mainWindow.on('blur', () => {
    mainWindow?.hide();
  });
}

function createTray() {
  // Use a 1x1 fully-transparent image so only the tray title text is visible.
  const transparentIcon = nativeImage.createFromBuffer(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg==', 'base64')
  );

  tray = new Tray(transparentIcon);
  tray.setToolTip('Claude Usage Tool');
  tray.setTitle('–');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Refresh', click: () => refreshAllData() },
    { label: 'Login to Claude', click: () => openLoginWindow() },
    { type: 'separator' },
    {
      label: 'About',
      click: () => {
        const aboutWindow = new BrowserWindow({
          width: 300,
          height: 200,
          resizable: false,
          minimizable: false,
          maximizable: false,
          title: 'About Claude Usage Tool',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
        const iconBase64 = fs.existsSync(iconPath)
          ? 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64')
          : '';

        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
                background: #1a1a1a;
                color: #fff;
                text-align: center;
                -webkit-user-select: none;
              }
              img { width: 64px; height: 64px; margin-bottom: 12px; }
              h1 { font-size: 16px; margin: 0 0 4px 0; font-weight: 600; }
              .version { font-size: 12px; color: #888; margin-bottom: 8px; }
              .author { font-size: 12px; color: #aaa; }
              a { color: #d97706; text-decoration: none; }
              a:hover { text-decoration: underline; }
            </style>
          </head>
          <body>
            <img src="${iconBase64}" alt="icon" />
            <h1>Claude Usage Tool</h1>
            <div class="version">ver 0.10</div>
            <div class="author">by <a href="mailto:kingi@kingigilbert.com">Kingi Gilbert</a></div>
          </body>
          </html>
        `;

        aboutWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        aboutWindow.setMenu(null);
      }
    },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });

  tray.on('right-click', () => {
    tray?.popUpContextMenu(contextMenu);
  });
}

function showWindow() {
  if (!mainWindow || !tray) {
    console.log('showWindow: mainWindow or tray is null');
    return;
  }

  const trayBounds = tray.getBounds();
  const windowBounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });

  console.log('Tray bounds:', trayBounds);
  console.log('Window bounds:', windowBounds);
  console.log('Display bounds:', display.bounds);

  // Position window below tray icon (macOS style)
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
  let y = Math.round(trayBounds.y + trayBounds.height + 4);

  // Ensure window is within display bounds
  if (x + windowBounds.width > display.bounds.x + display.bounds.width) {
    x = display.bounds.x + display.bounds.width - windowBounds.width;
  }
  if (x < display.bounds.x) {
    x = display.bounds.x;
  }

  mainWindow.setPosition(x, y, false);
  mainWindow.show();
  mainWindow.focus();
}

async function refreshAllData() {
  if (!mainWindow) return;

  addLog('Refreshing data...');

  try {
    const [claudeUsage, billingInfo] = await Promise.all([
      scrapeClaudeUsage().then(result => {
        if (result) {
          if (result.isAuthenticated) {
            addLog(`Usage: ${result.bars?.length || 0} bars fetched`);
          } else {
            addLog('Usage: Not authenticated');
          }
        } else {
          addLog('Usage: Skipped (in progress)');
        }
        return result;
      }).catch(err => {
        addLog(`Usage error: ${err.message}`);
        return null;
      }),
      scrapeBillingInfo().then(result => {
        if (result) {
          if (result.creditBalance !== null) {
            addLog(`Billing: $${result.creditBalance.toFixed(2)}`);
          } else {
            addLog('Billing: No balance data');
          }
        } else {
          addLog('Billing: Skipped (in progress)');
        }
        return result;
      }).catch(err => {
        addLog(`Billing error: ${err.message}`);
        return null;
      }),
    ]);

    mainWindow.webContents.send('app:data-updated', {
      claudeUsage,
      billingInfo,
      timestamp: new Date().toISOString(),
      logs: getRecentLogs(6),
    });

    // Use scraped bars for the tray title (5-hour "Current session" preferred).
    // Fall back to OAuth API only if the scraper returned no usable bars.
    addLog(`Bars returned: ${claudeUsage?.bars?.map(b => b.label).join(', ') || 'none'}`);
    let utilizationText = '–';
    if (claudeUsage?.isAuthenticated && claudeUsage.bars && claudeUsage.bars.length > 0) {
      const currentSessionBar = claudeUsage.bars.find(
        b => b.label?.toLowerCase().includes('current session') || b.label?.toLowerCase().includes('session')
      ) ?? claudeUsage.bars[0];
      utilizationText = `${Math.round(currentSessionBar.percentage)}%`;
    } else {
      utilizationText = await getFiveHourUtilization();
    }
    tray?.setTitle(utilizationText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addLog(`Refresh failed: ${message}`);
  }
}


function startAutoRefresh() {
  // Refresh every 60 seconds
  refreshInterval = setInterval(refreshAllData, 60000);
  // Initial refresh
  refreshAllData();
}

// IPC Handlers
ipcMain.handle('claude-max:get-usage', async () => {
  try {
    return await scrapeClaudeUsage();
  } catch (error) {
    console.error('Failed to get Claude usage:', error);
    return null;
  }
});

ipcMain.handle('claude-max:is-authenticated', async () => {
  return isAuthenticated();
});

ipcMain.handle('claude-max:login', async () => {
  return openLoginWindow();
});

ipcMain.handle('platform:login', async () => {
  return openPlatformLoginWindow();
});

ipcMain.handle('app:refresh-all', async () => {
  await refreshAllData();
});

ipcMain.handle('app:get-admin-key-status', () => {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  return {
    configured: !!key && key.startsWith('sk-ant-admin'),
    hint: key ? `${key.substring(0, 15)}...` : null,
  };
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();
  startAutoRefresh();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});

// Hide dock icon on macOS (menu bar app)
if (process.platform === 'darwin') {
  app.dock?.hide();
}
