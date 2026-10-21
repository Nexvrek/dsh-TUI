/**
 * /update must not retry, remove stale files, repair, or restart after cleanup
 * becomes unconfirmed. Runs the real updater from a disposable transpiled
 * source copy; only its installer runner and replacement spawn are controlled.
 * No network, installer, replacement process, or real user profile is touched.
 * Run: node scripts/verify-update-cleanup.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repo = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(repo, 'src')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-update-cleanup-'))
const pkg = join(scratch, 'package')
const modules = join(pkg, 'lib', 'types')
const savedEnvironment = new Map(['DSH_HOME', 'DSH_TUI_STANDALONE', 'DSH_TUI_STANDALONE_BINARY', 'HOME', 'USERPROFILE'].map(key => [key, process.env[key]]))
const originalStderr = process.stderr.write
let diagnostics = ''

try {
  mkdirSync(modules, { recursive: true })
  mkdirSync(join(scratch, 'home'), { recursive: true })
  process.env.HOME = join(scratch, 'home')
  process.env.USERPROFILE = join(scratch, 'home')
  process.env.DSH_HOME = join(scratch, 'profiles-home')
  delete process.env.DSH_TUI_STANDALONE
  delete process.env.DSH_TUI_STANDALONE_BINARY
  symlinkSync(join(repo, 'node_modules'), join(pkg, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const manifest = join(pkg, 'package.json')
  const writeVersion = version => writeFileSync(manifest, JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version, type: 'module' }))
  writeVersion('1.2.3')

  // Transpile the actual dependency closure without changing generated lib/.
  // Replacing imports in this disposable copy creates no production test hook.
  const visited = new Set()
  function copyModule(source) {
    if (visited.has(source)) return
    visited.add(source)
    const output = join(modules, relative(sourceRoot, source).replace(/\.tsx?$/, '.js'))
    let code = ts.transpileModule(readFileSync(source, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      fileName: source,
    }).outputText
    if (source === join(sourceRoot, 'update.ts')) {
      assert.ok(code.includes("from './updateProcess.js'"))
      code = code.replace("from './updateProcess.js'", "from './installer-stub.js'")
      code = code.replace("from 'node:child_process'", "from './replacement-stub.js'")
    }
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, code)
    for (const imported of ts.preProcessFile(code, true, true).importedFiles) {
      const name = imported.fileName
      if (!name.startsWith('.') || name.endsWith('-stub.js')) continue
      const base = resolve(dirname(source), name)
      const candidate = base.replace(/\.js$/, '.ts')
      const dependency = existsSync(candidate) ? candidate : base.replace(/\.js$/, '.tsx')
      assert.ok(existsSync(dependency), `runtime source dependency exists: ${name}`)
      copyModule(dependency)
    }
  }
  copyModule(join(sourceRoot, 'update.ts'))
  writeFileSync(join(modules, 'installer-stub.js'), `
let plan = []
export const calls = []
export function configure(steps) { plan = steps; calls.length = 0 }
export async function runInstallerProcess(command, args, options) {
  const step = plan[calls.length]
  calls.push({ command, args: [...args] })
  if (!step) throw new Error('Unexpected installer invocation: ' + JSON.stringify(args))
  step.onRun?.()
  if (step.stderr) options.onStderr?.(step.stderr)
  if (step.cleanup) options.onEvent?.({ category: options.category, stage: 'cleanup-error', code: step.code, message: 'fixture: owned job cleanup unconfirmed' })
  options.onEvent?.({ category: options.category, stage: 'close', code: step.code })
  return step.code
}
`)
  writeFileSync(join(modules, 'replacement-stub.js'), `
export { execFileSync } from 'node:child_process'
export let spawnCount = 0
export function spawn() { spawnCount++; throw new Error('Replacement must never spawn after cleanup uncertainty') }
`)
  const updater = await import(pathToFileURL(join(modules, 'update.js')).href)
  const runner = await import(pathToFileURL(join(modules, 'installer-stub.js')).href)
  const replacement = await import(pathToFileURL(join(modules, 'replacement-stub.js')).href)
  process.stderr.write = function (chunk) { diagnostics += String(chunk); return true }

  const transient = 'ENOENT: scandir dsh-tui_tmp_123_0\n'
  const collision = 'EEXIST: rename dsh-tui_tmp_123_0\n'
  const cases = [
    { name: 'native failure plus transient stderr', steps: [{ code: 127, stderr: transient, cleanup: true }] },
    { name: 'native failure plus collision stderr', steps: [{ code: 127, stderr: collision, cleanup: true }] },
    { name: 'unexpected success cannot enter repair', target: '9.9.9', steps: [{ code: 0, stderr: collision, cleanup: true }] },
    { name: 'unexpected success cannot restart', target: '1.2.3', steps: [{ code: 0, cleanup: true }] },
    { name: 'uncertainty on plain retry prevents stale removal', steps: [{ code: 1, stderr: transient }, { code: 127, stderr: transient, cleanup: true }] },
    { name: 'uncertainty on stale recovery prevents repair', target: '9.9.9', recovery: true, steps: [{ code: 1, stderr: collision }, { code: 0, cleanup: true }] },
    { name: 'uncertainty during repair prevents replacement', target: '9.9.9', repair: true, steps: [{ code: 0 }, { code: 0, cleanup: true }] },
  ]
  for (const [index, test] of cases.entries()) {
    writeVersion('1.2.3')
    diagnostics = ''
    const profile = `cleanup-${index}`
    const packageDir = updater.profilePackageDir(profile)
    const stagingDir = join(dirname(packageDir), 'dsh-tui_tmp_123_0')
    const markers = [join(packageDir, 'sentinel'), join(stagingDir, 'sentinel')]
    const seedMarkers = () => {
      for (const marker of markers) {
        mkdirSync(dirname(marker), { recursive: true })
        writeFileSync(marker, 'preserve while ownership is uncertain')
      }
    }
    seedMarkers()
    // A stale recovery is allowed before uncertainty; recreate sentinels at
    // that installer invocation to prove no subsequent destructive pass runs.
    if (test.recovery) test.steps[1].onRun = seedMarkers
    if (test.repair) test.steps[1].onRun = () => writeVersion('9.9.9')
    runner.configure(test.steps)
    const result = await updater.updateTuiAndRestart('fixture-session', profile, test.target)
    assert.notEqual(result.updateCode, 0, test.name)
    assert.notEqual(result.restartCode, 0, `${test.name}: nonzero restart result`)
    assert.equal(runner.calls.length, test.steps.length, `${test.name}: no additional installer`)
    assert.equal(replacement.spawnCount, 0, `${test.name}: no replacement`)
    assert.ok(markers.every(marker => existsSync(marker)), `${test.name}: no stale removal after cleanup uncertainty`)
    assert.match(readFileSync(join(scratch, 'home', '.dsh-tui', 'restart.log'), 'utf8'), /cleanup-error/, `${test.name}: cleanup diagnostic recorded`)
    if (test.steps.length === 1) assert.doesNotMatch(diagnostics, /retrying once|rerunning the update/)
    if (test.repair) assert.equal(runner.calls[1].args.at(-1), 'install')
    else assert.ok(runner.calls.every(call => call.args.includes('update')), `${test.name}: no repair invocation`)
    process.stdout.write(`PASS: ${test.name}\n`)
  }
} finally {
  process.stderr.write = originalStderr
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
}
