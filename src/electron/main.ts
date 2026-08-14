import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DesktopLogger } from './logger'
import { resolveRuntimeDirectory, RuntimeManager } from './runtime-manager'
import type { RuntimeSnapshot } from './types'

let mainWindow: BrowserWindow | undefined
let manager: RuntimeManager
let landingFileUrl: string

const RUNTIME_TITLEBAR_CSS = `
  body {
    box-sizing: border-box !important;
    padding-top: 38px !important;
  }
`


void app.whenReady().then(async () => {
  const logger = new DesktopLogger(join(app.getPath('userData'), 'logs'))
  manager = new RuntimeManager(resolveRuntimeDirectory(process.resourcesPath), logger)
  landingFileUrl = pathToFileURL(join(app.getAppPath(), 'dist', 'renderer', 'index.html')).toString()

  registerIpcHandlers()
  createMainWindow()
  await showLanding('starting')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (!manager) return
  event.preventDefault()
  void manager.stop().finally(() => app.exit())
})

function createMainWindow(): void {
  const titleBarOptions = process.platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset' as const }
    : {
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: { color: '#f0f1f1', symbolColor: '#363b45', height: 38 },
      }
  const appearanceOptions = process.platform === 'darwin'
    ? {
        backgroundColor: '#00000000',
        transparent: true,
        vibrancy: 'under-window' as const,
        visualEffectState: 'active' as const,
      }
    : { backgroundColor: '#f0f1f1' }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 580,
    title: 'DeepSeek Harness Desktop',
    show: false,
    ...appearanceOptions,
    ...titleBarOptions,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(app.getAppPath(), 'dist', 'electron', 'preload.js'),
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (isTrustedRuntimeUrl(mainWindow?.webContents.getURL())) {
      void mainWindow?.webContents.insertCSS(RUNTIME_TITLEBAR_CSS)
    }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })
  mainWindow.webContents.on('render-process-gone', () => {
    void showLanding('renderer-error')
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:get-runtime-status', (): RuntimeSnapshot => manager.snapshot())
  ipcMain.handle('desktop:start-runtime', async (): Promise<RuntimeSnapshot> => {
    const snapshot = await manager.start()
    if (snapshot.status === 'ready' && snapshot.url) await loadRuntime(snapshot.url)
    return snapshot
  })
  ipcMain.handle('desktop:copy-diagnostics', (): void => {
    clipboard.writeText(manager.diagnostics())
  })
}

async function showLanding(mode: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  await mainWindow.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'index.html'), { query: { mode } })
}

async function loadRuntime(url: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (url !== manager.getTrustedUrl()) {
    await showLanding('untrusted-runtime')
    return
  }
  try {
    await mainWindow.loadURL(url)
  }
  catch {
    await showLanding('runtime-load-failed')
  }
}

function isAllowedNavigation(url: string): boolean {
  if (url === landingFileUrl || url.startsWith(`${landingFileUrl}?`)) return true
  return isTrustedRuntimeUrl(url)
}

function isTrustedRuntimeUrl(url: string | undefined): boolean {
  const trustedUrl = manager?.getTrustedUrl()
  if (!url || !trustedUrl) return false
  try {
    return new URL(url).origin === new URL(trustedUrl).origin
  }
  catch {
    return false
  }
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  }
  catch {
    return false
  }
}
