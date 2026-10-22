#!/usr/bin/env node
/** One bounded native-tar comparison after the real Windows runtime check fails.
 * Reuses its retained archive, without exclusions or retries. This diagnostic
 * never replaces the executable's cold/warm or ConPTY acceptance checks.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const option = name => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`${name} requires a path`)
  return resolve(process.argv[index + 1])
}
const diagnostic = option('--diagnostic')
const out = option('--out')
mkdirSync(out, { recursive: true })
const report = { benchmarkOnly: true, platform: process.platform, timeoutMs: 120_000, exclusions: [] }
const processResult = (result, started) => ({
  elapsedMs: Math.round(performance.now() - started), status: result.status, signal: result.signal,
  error: result.error ? { code: result.error.code, message: result.error.message } : null,
})
const pathState = path => {
  try {
    const stat = lstatSync(path)
    return { present: true, type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
      ...(stat.isSymbolicLink() ? { target: readlinkSync(path) } : {}) }
  } catch (error) { return { present: false, error: error.code } }
}

try {
  assert.equal(process.platform, 'win32', 'This diagnostic requires the Windows runner')
  const cold = JSON.parse(readFileSync(diagnostic, 'utf8'))
  assert.equal(typeof cold.scratch, 'string', 'Missing failed runtime scratch path')
  const archives = cold.cache?.entries?.filter(entry => entry.type === 'file' && /^\.runtime-[^/\\]+\.tar\.gz$/.test(entry.name)) ?? []
  assert.equal(archives.length, 1, 'Expected exactly one retained runtime archive')
  const archive = join(cold.scratch, '用户 home', 'runtime cache', archives[0].name)
  const archiveStat = lstatSync(archive)
  assert.ok(archiveStat.isFile(), 'Retained archive must be a regular file')
  assert.equal(archiveStat.size, archives[0].bytes, 'Retained archive size changed after runtime failure')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  report.archive = { path: archive, bytes: archiveStat.size, sha256: hash.digest('hex') }
  report.runtimeFailure = { error: cold.error, elapsedMs: cold.elapsedMs }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  assert.ok(systemRoot, 'Missing Windows SystemRoot')
  const executable = join(systemRoot, 'System32', 'tar.exe')
  assert.ok(existsSync(executable), 'Windows system tar.exe is unavailable')
  report.executable = executable
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(systemroot|systemdrive|windir|comspec|pathext)$/i.test(key)))
  Object.assign(environment, { HOME: cold.scratch, USERPROFILE: cold.scratch, TMP: cold.scratch, TEMP: cold.scratch,
    PATH: join(cold.scratch, 'empty-bin') })
  let started = performance.now()
  const version = spawnSync(executable, ['--version'], { env: environment, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 })
  report.version = { ...processResult(version, started), output: (version.stdout ?? '').trim() }
  writeFileSync(join(out, 'version.stderr.log'), version.stderr ?? '')
  assert.equal(version.error, undefined, 'Could not query Windows tar version')
  assert.equal(version.status, 0, 'Windows tar version query failed')
  const destination = mkdtempSync(join(dirname(archive), '原生 解压诊断 '))
  report.destination = destination
  // Node sets the Unicode cwd through Windows APIs. Keep tar's argv ASCII for
  // Windows builds whose command-line path conversion uses the ANSI code page.
  const archiveArgument = relative(destination, archive)
  assert.match(archiveArgument, /^[\x20-\x7e]+$/, 'The retained archive needs a non-ASCII argument; refusing to copy or retry it')
  const args = ['-xf', archiveArgument, '--no-same-owner', '--no-same-permissions']
  report.args = args
  started = performance.now()
  const extracted = spawnSync(executable, args, { cwd: destination, env: environment, encoding: 'utf8',
    timeout: report.timeoutMs, maxBuffer: 4 * 1024 * 1024 })
  report.extraction = processResult(extracted, started)
  writeFileSync(join(out, 'native.stdout.log'), extracted.stdout ?? '')
  writeFileSync(join(out, 'native.stderr.log'), extracted.stderr ?? '')
  report.keyPaths = Object.fromEntries([
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/plugin.js',
    'node_modules/@deepseek-harness-tui/dsh-tui/cordis.patch.yml',
    'node_modules/@deepseek-harness-tui/dsh-tui/cli/entry.mjs',
    'node_modules/@deepseek-harness-tui/dsh-tui/cli/adapters/dsh/management-plugin.mjs',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  ].map(path => [path, pathState(join(destination, path))]))
  // Inspect written paths without following links outside the fresh tree.
  const pending = [destination]
  const links = []
  const scanErrors = []
  let files = 0
  let directories = 0
  while (pending.length) {
    const directory = pending.pop()
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) }
    catch (error) { scanErrors.push({ path: relative(destination, directory), error: error.code }); continue }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) links.push({ path: relative(destination, path).replaceAll('\\', '/'), ...pathState(path) })
      else if (entry.isDirectory()) { directories++; pending.push(path) }
      else files++
    }
  }
  report.writtenTree = { files, directories, links, scanErrors,
    nonBinSymbolicLinks: links.filter(link => !/(?:^|\/)node_modules\/\.bin\/[^/]+$/.test(link.path)).length }
  report.completeMarkerPresent = existsSync(join(destination, '.complete'))
} catch (error) {
  report.diagnosticError = { code: error.code, message: error.message }
} finally {
  writeFileSync(join(out, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`DSH_TUI_NATIVE_EXTRACTION_DIAGNOSTIC ${JSON.stringify(report)}`)
}
// The preceding runtime step remains failed even when this diagnostic succeeds.
