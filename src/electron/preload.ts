import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, RuntimeSnapshot } from './types'

/** Exposes only the fixed, non-sensitive desktop controls required by the landing page. */
const bridge: DesktopBridge = {
  getRuntimeStatus: (): Promise<RuntimeSnapshot> => ipcRenderer.invoke('desktop:get-runtime-status'),
  startRuntime: (): Promise<RuntimeSnapshot> => ipcRenderer.invoke('desktop:start-runtime'),
  copyDiagnostics: (): Promise<void> => ipcRenderer.invoke('desktop:copy-diagnostics'),
}

contextBridge.exposeInMainWorld('desktop', bridge)
