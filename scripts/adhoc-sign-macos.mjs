import { spawn } from 'node:child_process'
import { join } from 'node:path'

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

/**
 * Electron's bundled executable is ad-hoc signed, but an unsigned outer app
 * bundle can then fail macOS integrity checks as an invalid signature. Seal the
 * complete bundle before electron-builder creates the DMG. A Developer ID
 * signature, when configured, is applied later by electron-builder and
 * replaces this local ad-hoc signature.
 */
export default async function adHocSignMacApp(context) {
  if (process.platform !== 'darwin') return

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )

  await run('xattr', ['-cr', appPath])
  await run('codesign', ['--force', '--deep', '--sign', '-', appPath])
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
}
