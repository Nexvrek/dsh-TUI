#!/usr/bin/env node
/** Regression for #1660: run the real version synchronizer and archive loader.
 * Run: node scripts/verify-standalone-bundle.mjs
 * Tiny runtime fixtures keep missing-export failures deterministic and offline.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Header, PackSync, ReadEntry } from 'tar'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'standalone-bundle-'))
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const json = (path, value) => write(path, `${JSON.stringify(value)}\n`)
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const tuiVersion = readJson(join(source, 'package.json')).version
const primary = readFileSync(join(source, 'src/dsh-adapter/contract.ts'), 'utf8')
  .match(/^export const UPSTREAM_VALIDATED_VERSION\s*=\s*'([^']+)'/m)[1]
const sync = () => spawnSync(process.execPath, [join(fixture, 'scripts/make-standalone-bundle.mjs'), '--sync-versions-only'], { encoding: 'utf8' })
const retainedScratch = new Set()
let probeNumber = 0
const probe = () => {
  const evidence = join(fixture, `probe-${probeNumber++}`)
  const result = spawnSync(process.execPath, [join(fixture, 'scripts/verify-standalone-runtime.mjs'), '--out', evidence], { encoding: 'utf8', timeout: 30_000 })
  for (const mode of ['cold', 'warm']) {
    const report = join(evidence, `${mode}.result.json`)
    if (existsSync(report)) retainedScratch.add(readJson(report).scratch)
  }
  return { ...result, evidence }
}
const ok = (result, label) => assert.equal(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`)

try {
  for (const path of ['scripts/make-standalone-bundle.mjs', 'scripts/verify-standalone-runtime.mjs', 'standalone/entry.mjs', 'standalone/cacheGuard.cjs', 'standalone/package.json']) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true })
    copyFileSync(join(source, path), join(fixture, path))
  }
  json(join(fixture, 'package.json'), { version: tuiVersion, type: 'module' })
  const contract = join(fixture, 'src/dsh-adapter/contract.ts')
  write(contract, `export const UPSTREAM_VALIDATED_VERSION = '${primary}'\n`)
  ok(sync(), 'synchronize stale seed manifest and launcher')
  const checkVersions = (tui, dsh) => {
    const manifest = readJson(join(fixture, 'standalone/package.json'))
    assert.equal(manifest.dependencies['@deepseek-harness-tui/dsh-tui'], tui)
    assert.equal(manifest.dependencies['@deepseek-ai/dsh'], dsh)
    const entry = readFileSync(join(fixture, 'standalone/entry.mjs'), 'utf8')
    assert.ok(entry.includes(`const TUI_VERSION = '${tui}'`))
    assert.ok(entry.includes(`const DSH_VERSION = '${dsh}'`))
  }
  checkVersions(tuiVersion, primary)
  write(contract, "export const UPSTREAM_VALIDATED_VERSION = '0.9.0-rc.1'\n")
  ok(sync(), 'future contract bump')
  checkVersions(tuiVersion, '0.9.0-rc.1')
  write(contract, '// missing primary declaration\n')
  assert.notEqual(sync().status, 0, 'Missing contract must stop before resolving packages')
  checkVersions(tuiVersion, '0.9.0-rc.1')
  write(contract, `export const UPSTREAM_VALIDATED_VERSION = '${primary}'\n`)
  ok(sync(), 'restore primary')
  const candidate = join(fixture, 'candidate package.tgz')
  write(candidate, '')
  ok(spawnSync(process.execPath, [join(fixture, 'scripts/make-standalone-bundle.mjs'), '--sync-versions-only', '--tui-package', candidate], { encoding: 'utf8' }), 'use a local candidate')
  assert.equal(readJson(join(fixture, 'standalone/package.json')).dependencies['@deepseek-harness-tui/dsh-tui'], `file:${candidate.replaceAll('\\', '/')}`)
  ok(sync(), 'restore registry source')
  checkVersions(tuiVersion, primary)
  console.log('PASS: manifest and launcher follow the primary contract, including future bumps and invalid input')

  // Only the launcher needs tar; the archived fixture is its own isolated tree.
  symlinkSync(join(source, 'node_modules'), join(fixture, 'standalone/node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const staging = join(fixture, 'payload')
  const dsh = join(staging, 'node_modules/@deepseek-ai/dsh')
  const tui = join(staging, 'node_modules/@deepseek-harness-tui/dsh-tui')
  const llm = join(staging, 'node_modules/@deepseek-ai/dsh-llm')
  json(join(dsh, 'package.json'), { name: '@deepseek-ai/dsh', version: primary, type: 'module' })
  write(join(dsh, 'lib/bin.js'), "export async function runCli() { if (process.argv.includes('--self-test')) throw new Error('Self-test must not launch a profile'); console.log('DSH_TUI_BOOT_CALLED ' + JSON.stringify(process.argv.slice(2))) }\n")
  json(join(tui, 'package.json'), { name: '@deepseek-harness-tui/dsh-tui', version: tuiVersion, type: 'module' })
  write(join(tui, 'cordis.patch.yml'), '[]\n')
  for (const path of ['lib/types/index.js', 'cli/entry.mjs', 'cli/adapters/dsh/management-plugin.mjs']) write(join(tui, path), 'export {}\n')
  write(join(tui, 'lib/types/dsh-adapter/plugin.js'), "import { ToolCallId } from '@deepseek-ai/dsh-llm'\nexport function apply() { return ToolCallId }\n")
  json(join(llm, 'package.json'), { name: '@deepseek-ai/dsh-llm', type: 'module', exports: './index.js' })
  write(join(llm, 'index.js'), 'export const ToolCallId = Symbol()\n')
  for (const name of ['cordis', 'schemastery']) {
    const path = join(staging, `node_modules/@deepseek-ai/${name}`)
    json(join(path, 'package.json'), { name: `@deepseek-ai/${name}`, type: 'module', exports: './index.js' })
    write(join(path, 'index.js'), 'export {}\n')
  }
  // Synthetic link headers avoid requiring OS symlink privileges merely to
  // construct the regression that verifies an unprivileged Windows launch.
  const archive = (extraEntries = []) => {
    const pack = new PackSync({ cwd: staging, gzip: true })
    const chunks = []
    pack.on('data', chunk => chunks.push(chunk))
    pack.add('node_modules')
    for (const fields of extraEntries) {
      const entry = new ReadEntry(new Header({ size: 0, mode: 0o777, ...fields }))
      pack.add(entry)
      entry.end()
    }
    pack.end()
    write(join(fixture, 'standalone/runtime.tar.gz'), Buffer.concat(chunks))
  }
  await archive()
  const compatible = probe()
  ok(compatible, 'cold and warm compatible runtime')
  const coldTrace = readFileSync(join(compatible.evidence, 'cold.stderr.log'), 'utf8')
  const warmTrace = readFileSync(join(compatible.evidence, 'warm.stderr.log'), 'utf8')
  assert.match(coldTrace, /"stage":"extract-start"/)
  assert.match(coldTrace, /"stage":"extract-done"/)
  assert.match(coldTrace, /"stage":"imports-done"/)
  assert.doesNotMatch(warmTrace, /"stage":"extract-start"/)
  assert.doesNotMatch(coldTrace + warmTrace, /正在准备运行环境，已用/)
  console.log('PASS: real entry extracts and imports a compatible runtime without launching a profile')

  // Exercise Windows' synchronous extractor through the same copied launcher
  // on every host. The normal-launch check below must use that path too.
  const entryPath = join(fixture, 'standalone/entry.mjs')
  const entryText = readFileSync(entryPath, 'utf8')
  const synchronousEntry = entryText.replace("const windowsExtraction = process.platform === 'win32'", 'const windowsExtraction = true')
  assert.notEqual(synchronousEntry, entryText, 'The launcher must select its Windows extractor')
  const deniedEntry = synchronousEntry.replace("traceStage('runtime-check')",
    "fs.symlinkSync = () => { throw Object.assign(new Error('FIXTURE_SYMLINK_PRIVILEGE_REQUIRED'), { code: 'EPERM' }) }\ntraceStage('runtime-check')")
  assert.notEqual(deniedEntry, synchronousEntry)
  write(join(staging, 'node_modules/.bin/tool.cmd'), '@echo fixture command\r\n')
  const binLinks = [
    { path: 'node_modules/.bin/dsh', linkpath: '../@deepseek-ai/dsh/lib/bin.js', type: 'SymbolicLink' },
    { path: 'node_modules/@deepseek-ai/dsh/node_modules/.bin/tool', linkpath: '../../lib/bin.js', type: 'SymbolicLink' },
    { path: 'node_modules/.bin/tool-hardlink', linkpath: 'node_modules/.bin/tool.cmd', type: 'Link' },
  ]
  await archive(binLinks)
  const unfilteredEntry = deniedEntry.replace('filter: (path, entry) => !(windowsExtraction', 'filter: (path, entry) => !(false')
  assert.notEqual(unfilteredEntry, deniedEntry)
  write(entryPath, unfilteredEntry)
  const deniedLink = probe()
  assert.notEqual(deniedLink.status, 0)
  assert.match(deniedLink.stderr, /FIXTURE_SYMLINK_PRIVILEGE_REQUIRED/)
  write(entryPath, deniedEntry)
  ok(probe(), 'synchronous cold and warm compatible runtime')
  console.log('PASS: Windows extraction works without POSIX bin-link privileges and reuses its complete cache')

  const launchHome = join(fixture, 'normal launch home')
  const launchEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(systemroot|systemdrive|windir|comspec|pathext)$/i.test(key)))
  Object.assign(launchEnv, {
    HOME: launchHome, USERPROFILE: launchHome,
    DSH_TUI_STANDALONE_HOME: join(launchHome, 'profiles home'),
    DSH_TUI_STANDALONE_CACHE: join(launchHome, 'runtime cache'),
  })
  const launched = spawnSync(process.execPath, [join(fixture, 'standalone/entry.mjs'), '--resume', 'example-session'], {
    env: launchEnv, encoding: 'utf8', timeout: 30_000,
  })
  ok(launched, 'ordinary standalone launch')
  assert.doesNotMatch(launched.stderr, /正在准备运行环境，已用/, 'Non-TTY launch must not emit interactive progress')
  const invocations = launched.stdout.split(/\r?\n/).filter(line => line.startsWith('DSH_TUI_BOOT_CALLED '))
  assert.equal(invocations.length, 1, 'The imported DSH public entry must be invoked exactly once')
  assert.deepEqual(JSON.parse(invocations[0].slice('DSH_TUI_BOOT_CALLED '.length)), ['--profile', 'dsh-tui', '--resume', 'example-session'])
  const launchedRuntime = join(launchEnv.DSH_TUI_STANDALONE_CACHE, `tui-${tuiVersion}-dsh-${primary}`)
  assert.ok(!existsSync(join(launchedRuntime, binLinks[0].path)))
  assert.ok(!existsSync(join(launchedRuntime, binLinks[1].path)))
  for (const name of ['tool.cmd', 'tool-hardlink']) {
    assert.equal(readFileSync(join(launchedRuntime, 'node_modules/.bin', name), 'utf8'), '@echo fixture command\r\n')
  }
  console.log('PASS: ordinary launch calls the imported DSH entry once with its profile and user arguments')

  for (const path of ['node_modules/@deepseek-ai/dsh/runtime-link.js', 'node_modules/example/.bin/tool']) {
    await archive([...binLinks, { path, linkpath: 'unneeded.js', type: 'SymbolicLink' }])
    const otherLink = probe()
    assert.notEqual(otherLink.status, 0)
    assert.match(otherLink.stderr, /FIXTURE_SYMLINK_PRIVILEGE_REQUIRED/)
    const otherReport = readJson(join(otherLink.evidence, 'cold.result.json'))
    assert.equal(otherReport.cache.completeMarkerPresent, false)
    assert.deepEqual(otherReport.cache.entries, [])
  }
  console.log('PASS: other symlinks still fail strictly without leaving a complete or temporary runtime')

  write(join(fixture, 'standalone/runtime.tar.gz'), 'not a tar archive\n')
  const corruptArchive = probe()
  assert.notEqual(corruptArchive.status, 0)
  assert.match(corruptArchive.stderr, /TAR_BAD_ARCHIVE/)
  const corruptReport = readJson(join(corruptArchive.evidence, 'cold.result.json'))
  assert.equal(corruptReport.cache.completeMarkerPresent, false)
  assert.deepEqual(corruptReport.cache.entries, [], 'Failed extraction must remove its temporary archive and tree')
  assert.doesNotMatch(readFileSync(join(corruptArchive.evidence, 'cold.stderr.log'), 'utf8'), /"stage":"runtime-ready"/)
  console.log('PASS: synchronous extraction errors leave no complete marker or temporary cache tree')
  write(entryPath, entryText)

  json(join(dsh, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2', type: 'module' })
  await archive()
  const mismatched = probe()
  assert.notEqual(mismatched.status, 0)
  assert.match(mismatched.stderr, /Standalone runtime mismatch: expected @deepseek-ai\/dsh@/)
  console.log('PASS: stale DSH payload is rejected even when launcher metadata is current')

  json(join(dsh, 'package.json'), { name: '@deepseek-ai/dsh', version: primary, type: 'module' })
  write(join(llm, 'index.js'), 'export const CallId = Symbol()\n')
  await archive()
  const missingExport = probe()
  assert.notEqual(missingExport.status, 0)
  assert.match(missingExport.stderr, /does not provide an export named 'ToolCallId'/)
  console.log('PASS: missing ToolCallId export is caught by loading the lazy plugin, even with matching versions')

  write(join(llm, 'index.js'), 'export const ToolCallId = Symbol()\n')
  const duplicate = join(tui, 'node_modules/@deepseek-ai/cordis')
  json(join(duplicate, 'package.json'), { name: '@deepseek-ai/cordis', type: 'module', exports: './index.js' })
  write(join(duplicate, 'index.js'), 'export {}\n')
  await archive()
  const separateFramework = probe()
  assert.notEqual(separateFramework.status, 0)
  assert.match(separateFramework.stderr, /separate host\/TUI instances of @deepseek-ai\/cordis/)
  console.log('PASS: a second TUI Cordis instance is rejected before plugin initialization')

  // A deliberately stalled import proves timeout errors retain the output
  // collected before termination. Shorten only this copied test verifier;
  // the production acceptance budget remains 120 seconds.
  rmSync(duplicate, { recursive: true, force: true })
  write(join(tui, 'lib/types/dsh-adapter/plugin.js'), "console.error('FIXTURE_IMPORT_STALLED'); setInterval(() => {}, 1000); await new Promise(() => {}); export function apply() {}\n")
  await archive()
  const verifier = join(fixture, 'scripts/verify-standalone-runtime.mjs')
  const verifierText = readFileSync(verifier, 'utf8')
  assert.ok(verifierText.includes('const timeoutMs = 120_000'))
  write(verifier, verifierText.replace('const timeoutMs = 120_000', 'const timeoutMs = 2_000'))
  const timedOut = probe()
  assert.notEqual(timedOut.status, 0)
  assert.match(timedOut.stderr, /ETIMEDOUT/)
  assert.match(timedOut.stderr, /FIXTURE_IMPORT_STALLED/)
  const timedOutReport = readJson(join(timedOut.evidence, 'cold.result.json'))
  assert.equal(timedOutReport.error.code, 'ETIMEDOUT')
  assert.equal(timedOutReport.cache.completeMarkerPresent, true)
  assert.ok(existsSync(timedOutReport.scratch), 'A failed probe must preserve its isolated runtime')
  assert.match(readFileSync(join(timedOut.evidence, 'cold.stderr.log'), 'utf8'), /"stage":"lazy-import-start"/)
  console.log('PASS: a timed-out import retains child output, extraction stages, cache state and isolated runtime')
} finally {
  for (const scratch of retainedScratch) rmSync(scratch, { recursive: true, force: true })
  rmSync(fixture, { recursive: true, force: true })
}
