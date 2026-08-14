import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Writes bounded diagnostic events without persisting obvious credential values. */
export class DesktopLogger {
  private readonly filePath: string

  /** @param directory Directory where the rotating log file is stored. */
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true })
    this.filePath = join(directory, 'desktop.log')
  }

  /** @param message A diagnostic message that may contain runtime output. */
  write(message: string): void {
    const line = `${new Date().toISOString()} ${redact(message)}\n`
    try {
      appendFileSync(this.filePath, line, 'utf8')
    }
    catch {
      // Diagnostics must never prevent the app from starting or stopping.
    }
  }

  /** @returns The path of the current diagnostic log. */
  getPath(): string {
    return this.filePath
  }
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(sk-[a-z0-9_-]{12,})/gi, '[REDACTED]')
}
