import { cp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = resolve('src/renderer')
const destination = resolve('dist/renderer')

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true })
