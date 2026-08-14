/** The lifecycle phases exposed to the desktop renderer. */
export type RuntimeStatus = 'idle' | 'starting' | 'ready' | 'failed' | 'crashed' | 'stopping'

/** A safe, non-sensitive view of the managed Harness runtime. */
export interface RuntimeSnapshot {
  status: RuntimeStatus
  url?: string
  detail?: string
  updatedAt: string
}

/** The small API exposed by Electron's preload script. */
export interface DesktopBridge {
  getRuntimeStatus(): Promise<RuntimeSnapshot>
  startRuntime(): Promise<RuntimeSnapshot>
  copyDiagnostics(): Promise<void>
}

declare global {
  interface Window {
    desktop: DesktopBridge
  }
}
