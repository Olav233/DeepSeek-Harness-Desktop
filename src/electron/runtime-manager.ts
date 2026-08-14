import { ChildProcess, spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DesktopLogger } from './logger'
import type { RuntimeSnapshot, RuntimeStatus } from './types'

const STARTUP_TIMEOUT_MS = 30_000
const HEALTH_TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 24_000
const LOOPBACK_URL = /dsh web:\s*(http:\/\/127\.0\.0\.1:(\d+)(?:\/[^\s]*)?)/i

/** Supervises the local `dsh web` process owned by the Electron application. */
export class RuntimeManager {
  private child?: ChildProcess
  private startup?: Promise<RuntimeSnapshot>
  private trustedUrl?: string
  private output = ''
  private status: RuntimeStatus = 'idle'
  private detail?: string
  private updatedAt = new Date().toISOString()

  /**
   * @param runtimeDirectory Source checkout during development, or the embedded runtime in a packaged app.
   * @param logger Desktop diagnostic logger.
   */
  constructor(
    private readonly runtimeDirectory: string,
    private readonly logger: DesktopLogger,
  ) {}

  /** Starts the runtime once and resolves only after its boot page is healthy. */
  async start(): Promise<RuntimeSnapshot> {
    if (this.status === 'ready') return this.snapshot()
    if (this.startup) return this.startup

    this.startup = this.startInternal().finally(() => {
      this.startup = undefined
    })
    return this.startup
  }

  /** Stops the entire runtime process group, retaining user-owned Harness data. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = undefined
      this.setStatus('idle')
      return
    }

    this.setStatus('stopping')
    this.logger.write(`Stopping managed runtime pid=${child.pid ?? 'unknown'}`)
    await terminateProcessTree(child)
    this.child = undefined
    this.trustedUrl = undefined
    this.setStatus('idle')
  }

  /** @returns The only HTTP URL the BrowserWindow is allowed to load. */
  getTrustedUrl(): string | undefined {
    return this.trustedUrl
  }

  /** @returns A renderer-safe status snapshot. */
  snapshot(): RuntimeSnapshot {
    return {
      status: this.status,
      url: this.trustedUrl,
      detail: this.detail,
      updatedAt: this.updatedAt,
    }
  }

  /** @returns A filtered tail of runtime output for support diagnostics. */
  diagnostics(): string {
    return [
      `Runtime directory: ${this.runtimeDirectory}`,
      `Status: ${this.status}`,
      this.detail ? `Detail: ${this.detail}` : undefined,
      '--- runtime output tail ---',
      this.output || '(no output captured)',
    ].filter(Boolean).join('\n')
  }

  private async startInternal(): Promise<RuntimeSnapshot> {
    try {
      assertRuntimeDirectory(this.runtimeDirectory)
      this.output = ''
      this.detail = undefined
      this.trustedUrl = undefined
      this.setStatus('starting')
      this.logger.write(`Starting dsh web from ${this.runtimeDirectory}`)

      const command = resolveRuntimeCommand(this.runtimeDirectory)
      const child = spawn(command.executable, command.args, {
        cwd: this.runtimeDirectory,
        detached: process.platform !== 'win32',
        env: { ...process.env, ...command.environment, NO_PROXY: appendNoProxy(process.env.NO_PROXY, '127.0.0.1,localhost') },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child
      child.stdout?.on('data', (chunk: Buffer) => this.captureOutput(chunk.toString(), 'stdout'))
      child.stderr?.on('data', (chunk: Buffer) => this.captureOutput(chunk.toString(), 'stderr'))

      const url = await this.waitForUrlOrExit(child)
      await this.waitForHealthyBootPage(url)
      this.trustedUrl = url
      this.setStatus('ready')
      this.logger.write(`Runtime ready at ${url}`)
      return this.snapshot()
    }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.setStatus('failed', detail)
      this.logger.write(`Runtime startup failed: ${detail}`)
      await this.stopAfterFailedStart()
      return this.snapshot()
    }
  }

  private captureOutput(chunk: string, stream: 'stdout' | 'stderr'): void {
    const entry = `[${stream}] ${chunk}`
    this.output = `${this.output}${entry}`.slice(-OUTPUT_LIMIT)
    this.logger.write(entry.trimEnd())
  }

  private async waitForUrlOrExit(child: ChildProcess): Promise<string> {
    const startedAt = Date.now()
    return new Promise((resolveUrl, reject) => {
      const timer = setInterval(() => {
        const url = parseLoopbackUrl(this.output)
        if (url) {
          clearInterval(timer)
          cleanup()
          resolveUrl(url)
        }
        else if (Date.now() - startedAt > STARTUP_TIMEOUT_MS) {
          clearInterval(timer)
          cleanup()
          reject(new Error(`Harness did not report a local URL within ${STARTUP_TIMEOUT_MS / 1000} seconds.`))
        }
      }, 100)

      const onError = (error: Error) => {
        clearInterval(timer)
        cleanup()
        reject(new Error(`Unable to start Harness runtime: ${error.message}`))
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        clearInterval(timer)
        cleanup()
        reject(new Error(`Harness exited before becoming ready (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`))
      }
      const cleanup = () => {
        child.off('error', onError)
        child.off('exit', onExit)
      }

      child.once('error', onError)
      child.once('exit', onExit)
      child.once('exit', (code, signal) => this.handleExit(child, code, signal))
    })
  }

  private async waitForHealthyBootPage(url: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    let lastError = 'No response received.'

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
        const page = await response.text()
        if (response.status === 200 && page.includes('window.__DSH_BOOT__')) return
        lastError = `HTTP ${response.status}; Harness boot manifest was ${page.includes('window.__DSH_BOOT__') ? 'present' : 'missing'}.`
      }
      catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await delay(250)
    }

    throw new Error(`Harness URL was not healthy: ${lastError}`)
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child || this.status === 'stopping' || this.status === 'idle') return
    this.child = undefined
    this.trustedUrl = undefined
    this.setStatus('crashed', `Harness stopped unexpectedly (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`)
    this.logger.write(this.detail ?? 'Harness stopped unexpectedly.')
  }

  private async stopAfterFailedStart(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    try {
      await terminateProcessTree(child)
    }
    catch (error) {
      this.logger.write(`Failed to terminate startup process: ${error instanceof Error ? error.message : String(error)}`)
    }
    finally {
      this.child = undefined
      this.trustedUrl = undefined
    }
  }

  private setStatus(status: RuntimeStatus, detail?: string): void {
    this.status = status
    this.detail = detail
    this.updatedAt = new Date().toISOString()
  }
}

function resolveRuntimeCommand(directory: string): { executable: string; args: string[]; environment: NodeJS.ProcessEnv } {
  const runtimeDirectory = resolve(directory)
  const bundledBin = join(runtimeDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(bundledBin)) {
    return {
      executable: process.execPath,
      args: [bundledBin, 'web', '--host', '127.0.0.1', '--port', '0'],
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  return {
    executable: 'pnpm',
    args: ['dsh', 'web', '--host', '127.0.0.1', '--port', '0'],
    environment: {},
  }
}

function assertRuntimeDirectory(directory: string): void {
  const packagePath = join(directory, 'package.json')
  if (!existsSync(packagePath)) {
    throw new Error(`Harness runtime was not found at ${directory}. Set DSH_RUNTIME_DIR to a DeepSeek Harness checkout.`)
  }
  try {
    accessSync(packagePath, constants.R_OK)
  }
  catch {
    throw new Error(`Harness runtime is not readable at ${directory}.`)
  }
}

function parseLoopbackUrl(output: string): string | undefined {
  const match = output.match(LOOPBACK_URL)
  if (!match) return undefined
  const url = new URL(match[1])
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) return undefined
  return url.origin
}

function appendNoProxy(existing: string | undefined, values: string): string {
  return [existing, values].filter(Boolean).join(',')
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolveStop) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.once('exit', () => resolveStop())
      killer.once('error', () => resolveStop())
    })
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  }
  catch {
    child.kill('SIGTERM')
  }

  const exited = await waitForExit(child, 5_000)
  if (exited) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  }
  catch {
    child.kill('SIGKILL')
  }
  await waitForExit(child, 2_000)
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolveExit(true)
    }
    child.once('exit', onExit)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

/** Resolves an explicit development checkout or the runtime embedded in a packaged application. */
export function resolveRuntimeDirectory(resourcesPath: string): string {
  const explicit = process.env.DSH_RUNTIME_DIR
  if (explicit) return resolve(explicit)

  const embeddedRuntime = join(resourcesPath, 'runtime')
  if (existsSync(join(embeddedRuntime, 'package.json'))) return embeddedRuntime
  return join(embeddedRuntime, 'deepseek-harness')
}
