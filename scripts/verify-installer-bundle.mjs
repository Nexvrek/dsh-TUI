#!/usr/bin/env node
/**
 * verify-installer-bundle.mjs — 一键安装整合包文本产物的行尾/编码契约回归（#1068）。
 *
 * 生成器用同一条 LF/无 BOM 路径写出全部 5 个文本产物，但宿主契约各不相同：
 * cmd.exe 需要 .bat 为 CRLF（LF-only 会被逐行误切），Windows PowerShell 5.1
 * 需要 .ps1 带 UTF-8 BOM 才能正确解码中文，POSIX 要求 .sh 保持 LF。产物是
 * 发布资产的一部分，契约必须由回归锚定，否则缺陷会随每个 Release 稳定复发。
 *
 * 平台：全平台可跑。Windows 专属组（PS 5.1 默认解码回读 / cmd stub 冒烟）只在
 * Windows 上执行；非 Windows 打显式 SKIP 并计入 SKIPPED，不冒充 PASS。
 * DSH_TUI_TEST_POWERSHELL 可指定其他平台的 pwsh，仅运行 PS1 流程，不冒充 Windows 验收。
 *
 * 运行：node scripts/verify-installer-bundle.mjs（有 FAIL 即以非 0 退出）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

let passed = 0
let failed = 0
let skipped = 0

// 断言出口只有这一个：失败必须含 文件 + 首个违规字节偏移（D6）——行尾/BOM 问题
// 肉眼不可见，偏移量是唯一能快速定位的线索；文件读不到要变成 FAIL 而不是栈中途
// 中止（否则后面的断言根本不跑）。
const pass = label => {
  passed++
  console.log(`PASS: ${label}`)
}
const fail = (file, reason, offset) => {
  failed++
  console.log(`FAIL: ${file}: ${reason}（首个违规字节偏移 ${offset}）`)
}
const skip = (group, reason) => {
  skipped++
  console.log(`SKIP: ${group}  (${reason})`)
}

// 首个裸 LF：0x0A 的前一字节必须是 0x0D；-1 = 无违规。
const bareLfAt = bytes => {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0A && bytes[i - 1] !== 0x0D) return i
  return -1
}
// 首个 BOM 字节不符位置：-1 = 前 3 字节恰为 EF BB BF。
const bomMismatchAt = bytes => {
  const bom = [0xEF, 0xBB, 0xBF]
  for (let i = 0; i < 3; i++) if (bytes[i] !== bom[i]) return i
  return -1
}
const hex = bytes => [...bytes.subarray(0, 3)].map(b => b.toString(16).padStart(2, '0')).join(' ')
// 子进程输出诊断样本：压平空白并截断，避免刷屏。
const clip = (text, max = 160) => text.replace(/\s+/g, ' ').trim().slice(0, max)
// PowerShell 单引号字面量转义（路径里出现单引号也不会拼接注入）。
const psQuote = value => `'${value.replace(/'/g, "''")}'`

// 生成器产出到 mkdtemp 隔离目录，只断言 staging 文本；zip 打包（既有行为）与断言
// 无关，但随生成器一起真实执行。结束时无论晴雨都清掉临时目录（AC-6 零副作用）。
const tmp = mkdtempSync(join(tmpdir(), 'dsh-installer-'))
const stage = file => join(tmp, 'dsh-tui-setup', file)
let exitCode = 1
try {
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'make-installer-bundle.mjs'), '--out', tmp], { stdio: 'inherit' })
  } catch (err) {
    fail('scripts/make-installer-bundle.mjs', `生成器退出非 0（status=${err.status ?? 'signal'}）`, 'N/A')
  }

  const read = file => {
    try {
      return readFileSync(stage(file))
    } catch {
      fail(file, '文件缺失或不可读', 'N/A')
      return null
    }
  }

  // .bat × 2：cmd.exe 的 CRLF 解析契约。
  for (const file of ['install.bat', '启动 dsh-tui.bat']) {
    const bytes = read(file)
    if (!bytes) continue
    const offset = bareLfAt(bytes)
    if (offset === -1) pass(`${file}: CRLF（0x0A 前一字节均为 0x0D）`)
    else fail(file, '裸 LF（0x0A 前一字节不是 0x0D）', offset)
  }

  // install.ps1：Windows PowerShell 5.1 默认按 ANSI 解码，没有 BOM 中文必乱码。
  {
    const bytes = read('install.ps1')
    if (bytes) {
      const offset = bomMismatchAt(bytes)
      if (offset === -1) pass('install.ps1: UTF-8 BOM（EF BB BF）')
      else fail('install.ps1', `缺 UTF-8 BOM（实际前 3 字节 ${hex(bytes)}，期望 EF BB BF）`, offset)
    }
  }

  // install.sh：POSIX 契约，任何 0x0D 都会污染 shebang / 参数。
  {
    const bytes = read('install.sh')
    if (bytes) {
      const offset = bytes.indexOf(0x0D)
      if (offset === -1) pass('install.sh: LF（不含 0x0D）')
      else fail('install.sh', '含 0x0D（应为 LF）', offset)
    }
  }

  // 使用说明.txt：读者是编辑器而非解释器 → LF 且无 BOM；两条契约分别断言，
  // 失败时各自给偏移。
  {
    const bytes = read('使用说明.txt')
    if (bytes) {
      if (bomMismatchAt(bytes) !== -1) pass('使用说明.txt: 无 BOM')
      else fail('使用说明.txt', '不应带 UTF-8 BOM', 0)
      const offset = bytes.indexOf(0x0D)
      if (offset === -1) pass('使用说明.txt: LF（不含 0x0D）')
      else fail('使用说明.txt', '含 0x0D（应为 LF）', offset)
    }
  }

  // ── Windows 专属组 ①：PS 5.1 默认解码回读（AC-2）────────────────────────
  // 不传 -Encoding：PS 5.1 的 Get-Content -Raw 按默认（ANSI / BOM）解码，无 BOM
  // 的 UTF-8 中文会变乱码——正是用户症状。解码结果经 [IO.File]::WriteAllText
  // （UTF-8 无 BOM）送回 Node，避免控制台代码页对读回内容二次伤害。
  const checkPs51Decode = () => {
    if (!isWin) return skip('PS 5.1 默认解码回读 install.ps1', '非 Windows：无 Windows PowerShell 5.1')
    const ps1Path = stage('install.ps1')
    // 预期中文提示取自生成器的 INSTALL_PS1 模板；模板口径变了就显式 FAIL 提示同步，
    // 不让断言静默过期（与 cmd 调用形状断言同策略）。生成器缺失时不抛栈，走同一 FAIL。
    const generatorPath = join(root, 'scripts', 'make-installer-bundle.mjs')
    const expected = (existsSync(generatorPath) ? readFileSync(generatorPath, 'utf8') : '')
      .match(/const INSTALL_PS1 = `([\s\S]*?)`\n/)?.[1]
      ?.match(/未检测到 Node\.js[^'\r\n]*/)?.[0]
    if (!expected) return fail('PS 5.1 默认解码回读 install.ps1', 'INSTALL_PS1 模板已不含预期中文提示（未检测到 Node.js…），断言失效，请同步本脚本', 'N/A')
    if (!existsSync(ps1Path)) return fail('PS 5.1 默认解码回读 install.ps1', 'install.ps1 缺失或不可读（生成器未产出）', 'N/A')
    const psExe = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const decodedPath = join(tmp, 'ps51-default-decode.txt')
    const psCmd = `$ErrorActionPreference='Stop'; $c = Get-Content -Raw -LiteralPath ${psQuote(ps1Path)}; [IO.File]::WriteAllText(${psQuote(decodedPath)}, $c, (New-Object System.Text.UTF8Encoding($false)))`
    try {
      execFileSync(existsSync(psExe) ? psExe : 'powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    } catch (err) {
      return fail('PS 5.1 默认解码回读 install.ps1', `powershell 执行失败（status=${err.status ?? 'signal'}）`, 'N/A')
    }
    let decoded
    try {
      decoded = readFileSync(decodedPath, 'utf8')
    } catch {
      return fail('PS 5.1 默认解码回读 install.ps1', '默认解码回读文件缺失或不可读', 'N/A')
    }
    const hasExpected = decoded.includes(expected)
    const fffdAt = decoded.indexOf('\uFFFD')
    if (!hasExpected) fail('PS 5.1 默认解码回读 install.ps1', `默认解码未含预期中文提示「${expected}」（解码片段: ${clip(decoded)}）`, 'N/A')
    if (fffdAt !== -1) fail('PS 5.1 默认解码回读 install.ps1', `默认解码出现 U+FFFD 替换字符（首个字符位置 ${fffdAt}）`, 'N/A')
    if (hasExpected && fffdAt === -1) pass('PS 5.1 默认解码回读 install.ps1: 预期中文提示命中且无 U+FFFD')
  }
  checkPs51Decode()

  // ── Windows 专属组 ②：cmd 冒烟 install.bat（stub 隔离，AC-4）──────────────
  // 原字节复制 install.bat + 把 install.ps1 换成只打印标记的 stub；全部发生在
  // mkdtemp 子目录内，绝不触发真实安装（AC-6）。
  const checkCmdSmoke = () => {
    if (!isWin) return skip('cmd 冒烟 install.bat（stub 隔离）', '非 Windows：无 cmd.exe')
    const batPath = stage('install.bat')
    if (!existsSync(batPath)) return fail('cmd 冒烟 install.bat（stub 隔离）', 'install.bat 缺失或不可读（生成器未产出）', 'N/A')
    // 运行前锚定调用形状（DESIGN R4）：形状不符时不得执行（stub 可能被绕开），
    // 直接 FAIL 并提示同步本脚本。
    if (!/powershell\b[^\r\n]*-File\s+"%DIR%install\.ps1"/i.test(readFileSync(batPath, 'utf8')))
      return fail('cmd 冒烟 install.bat（stub 隔离）', '调用形状已变更（未匹配 powershell … -File "%DIR%install.ps1"），与真实安装器脱节，请同步本脚本', 'N/A')
    const comSpec = process.env.ComSpec
    if (!comSpec || !existsSync(comSpec)) return fail('cmd 冒烟 install.bat（stub 隔离）', '未找到 cmd.exe（process.env.ComSpec 缺失或无效）', 'N/A')
    const smokeDir = mkdtempSync(join(tmp, 'cmd-smoke-'))
    const marker = 'DSH_INSTALLER_CMD_SMOKE_STUB_OK'
    try {
      copyFileSync(batPath, join(smokeDir, 'install.bat'))
      writeFileSync(join(smokeDir, 'install.ps1'), `Write-Output '${marker}'\n`, 'utf8')
    } catch (err) {
      return fail('cmd 冒烟 install.bat（stub 隔离）', `stub 布置失败（${err.code ?? err.message}）`, 'N/A')
    }
    const run = spawnSync(comSpec, ['/d', '/c', 'install.bat'], { cwd: smokeDir, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    if (run.error) return fail('cmd 冒烟 install.bat（stub 隔离）', `cmd 执行失败（${run.error.code ?? run.error.message}）`, 'N/A')
    const stdout = run.stdout ?? ''
    const stderr = run.stderr ?? ''
    if (run.status !== 0) return fail('cmd 冒烟 install.bat（stub 隔离）', `cmd /c install.bat 退出码 ${run.status}（stdout: ${clip(stdout)}）`, 'N/A')
    if (!stdout.includes(marker)) return fail('cmd 冒烟 install.bat（stub 隔离）', `stdout 未含 stub 标记 ${marker}（stdout: ${clip(stdout)}；stderr: ${clip(stderr)}）`, 'N/A')
    if (/is not recognized as an internal or external command/i.test(stdout + stderr))
      return fail('cmd 冒烟 install.bat（stub 隔离）', 'stdout/stderr 含 cmd 解析错误 "is not recognized as an internal or external command"', 'N/A')
    pass('cmd 冒烟 install.bat（stub 隔离）: 退出码 0 且 stub 标记命中')

    writeFileSync(join(smokeDir, 'install.ps1'), 'exit 13\n', 'utf8')
    const failedInstall = spawnSync(comSpec, ['/d', '/c', 'install.bat'], {
      cwd: smokeDir, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    if (failedInstall.error || failedInstall.status !== 1 || !failedInstall.stdout?.includes('Installer failed.')) {
      fail('install.bat: child failure', '安装失败未保留错误提示与非零退出码', 'N/A')
    } else pass('install.bat: child failure remains nonzero after pause')

    copyFileSync(stage('启动 dsh-tui.bat'), join(smokeDir, 'launch.bat'))
    for (const code of [0, 17]) {
      writeFileSync(join(smokeDir, 'dsh-tui.cmd'), `@echo off\r\necho DSH_LAUNCH_STUB_OK\r\nexit /b ${code}\r\n`)
      const launch = spawnSync(comSpec, ['/d', '/c', 'launch.bat'], {
        cwd: smokeDir, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      if (launch.error || launch.status !== code || !launch.stdout?.includes('DSH_LAUNCH_STUB_OK')
        || launch.stdout.includes('Read the error above') !== (code !== 0)) {
        fail(`启动 dsh-tui.bat: exit ${code}`, '启动器未返回调用结果或保留失败提示', 'N/A')
      } else pass(`启动 dsh-tui.bat: child exit ${code}, failure remains visible`)
    }
  }
  checkCmdSmoke()

  // Run the generated installer, with package commands and user persistence
  // isolated in the child PowerShell process. No downloads or registry writes.
  const checkInstallerFlow = () => {
    const powershell = process.env.DSH_TUI_TEST_POWERSHELL ?? (isWin ? 'powershell' : undefined)
    if (!powershell) return skip('生成 install.ps1 安装与首次启动流程', '需要 PowerShell；Windows CI 使用 PS 5.1')
    const fixtures = [
      { name: 'reject Node 22.18', node: '22.18.0', code: 1, installs: 0 },
      { name: 'reject Node 23', node: '23.10.0', code: 1, installs: 0 },
      { name: 'accept Node 22.19 and upgrade pnpm 10', node: '22.19.0', pnpm: '10.20.0', pnpmInstalls: 1 },
      { name: 'recheck pnpm after install', pnpm: '10.20.0', keepOldPnpm: true, code: 1, installs: 0, pnpmInstalls: 1 },
      { name: 'version failure is not installation success', versionCode: 7, code: 1, launches: 0, complete: false },
      { name: 'Enter launches with an existing process key', processKey: true, savedKey: true, keyPresent: true },
      { name: 'saved user key is available immediately', savedKey: true, keyPresent: true },
      { name: 'new key is hidden, saved and available immediately', newKey: true, keyPresent: true, saved: true },
      { name: 'blank key continues to in-app setup', keyPresent: false },
      { name: 'launch error is returned', launchCode: 9, code: 1 },
      { name: 'N leaves without launching', launchAnswer: ' N ', launches: 0 },
      { name: 'redirected input does not prompt or launch', redirected: true, prompts: 0, launches: 0 },
    ]
    for (const [index, fixture] of fixtures.entries()) {
      const config = {
        node: '24.0.0', pnpm: '11.21.0', versionCode: 0, launchCode: 0,
        launchAnswer: '', ...fixture,
      }
      const configPath = join(tmp, `flow-${index}.json`)
      const resultPath = join(tmp, `flow-${index}-result.json`)
      const wrapper = join(tmp, `flow-${index}.ps1`)
      writeFileSync(configPath, JSON.stringify(config))
      writeFileSync(wrapper, `\uFEFF
$ErrorActionPreference = 'Stop'
[System.Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$global:config = Get-Content -Raw -LiteralPath ${psQuote(configPath)} | ConvertFrom-Json
$global:events = [Collections.Generic.List[string]]::new()
$global:pnpmVersion = $config.pnpm
$global:LASTEXITCODE = 0
class Environment {
  static [string]$SavedKey = ''
  static [bool]$Written = $false
  static [string] GetEnvironmentVariable([string]$name, [string]$target) {
    if ($name -eq 'DEEPSEEK_API_KEY') { return [Environment]::SavedKey }
    return ''
  }
  static [void] SetEnvironmentVariable([string]$name, [string]$value, [string]$target) {
    if ($name -ne 'DEEPSEEK_API_KEY' -or $target -ne 'User') { throw 'Unexpected persistent write' }
    [Environment]::SavedKey = $value
    [Environment]::Written = $true
  }
}
class Console { static [bool]$IsInputRedirected = $false }
[Console]::IsInputRedirected = [bool]$config.redirected
if ($config.savedKey) { [Environment]::SavedKey = 'fixture-saved-secret' }
$env:DEEPSEEK_API_KEY = if ($config.processKey) { 'fixture-process-secret' } else { '' }
function node { $global:LASTEXITCODE = 0; "v$($config.node)" }
function npm { throw 'Bare npm may select an unsigned PowerShell shim' }
function pnpm { throw 'Bare pnpm may select an unsigned PowerShell shim' }
function dsh-tui { throw 'Bare dsh-tui may select an unsigned PowerShell shim' }
function npm.cmd {
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'config') { return 'C:\\fixture\\npm' }
  if ($args -match '^pnpm@') {
    $events.Add('pnpm-install')
    if (-not $config.keepOldPnpm) { $global:pnpmVersion = '11.21.0' }
  } else { $events.Add('install') }
}
function pnpm.cmd { $global:LASTEXITCODE = 0; $global:pnpmVersion }
function dsh-tui.cmd {
  if ($args -contains '--version') { $global:LASTEXITCODE = $config.versionCode; return '0.16.1' }
  $events.Add('launch')
  if ($config.processKey -and $env:DEEPSEEK_API_KEY -ne 'fixture-process-secret') { throw 'Existing key changed' }
  if ($config.newKey -and $env:DEEPSEEK_API_KEY -ne 'fixture-new-secret') { throw 'New key not inherited' }
  if (-not $config.processKey -and $config.savedKey -and $env:DEEPSEEK_API_KEY -ne 'fixture-saved-secret') { throw 'Saved key not inherited' }
  $global:LASTEXITCODE = $config.launchCode
}
function Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  $events.Add('prompt')
  if ($Prompt -like '*DEEPSEEK_API_KEY*') {
    if (-not $AsSecureString) { throw 'API key input must be hidden' }
    if ($config.newKey) { return ConvertTo-SecureString '  fixture-new-secret  ' -AsPlainText -Force }
    return [Security.SecureString]::new()
  }
  return $config.launchAnswer
}
& ${psQuote(stage('install.ps1'))}
$code = $LASTEXITCODE
$result = @{ events = @($events.ToArray()); saved = [Environment]::Written; keyPresent = [bool]$env:DEEPSEEK_API_KEY }
[IO.File]::WriteAllText(${psQuote(resultPath)}, ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
exit $code
`, 'utf8')
      const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
        encoding: 'utf8', timeout: 20_000, windowsHide: true,
      })
      const output = (run.stdout ?? '') + (run.stderr ?? '')
      let result
      try { result = JSON.parse(readFileSync(resultPath, 'utf8')) } catch {}
      const count = name => result?.events.filter(event => event === name).length
      const expectedCode = config.code ?? 0
      const problems = [
        run.error && String(run.error),
        run.status !== expectedCode && `exit ${run.status}, expected ${expectedCode}`,
        !result && 'missing fixture result',
        count('install') !== (config.installs ?? 1) && 'incorrect package install count',
        count('pnpm-install') !== (config.pnpmInstalls ?? 0) && 'incorrect pnpm repair count',
        count('launch') !== (config.launches ?? (expectedCode === 0 || config.launchCode ? 1 : 0)) && 'incorrect first-launch count',
        config.prompts !== undefined && count('prompt') !== config.prompts && 'unexpected prompt',
        result?.saved !== (config.saved ?? false) && 'incorrect credential persistence',
        config.keyPresent !== undefined && result?.keyPresent !== config.keyPresent && 'incorrect child credential state',
        config.complete === false && output.includes('安装完成！启动方式') && 'false success message',
        /fixture-(process|saved|new)-secret/.test(output) && 'credential leaked to output',
      ].filter(Boolean)
      if (problems.length) fail(`install.ps1: ${config.name}`, `${problems.join('; ')} (${clip(output, 400)})`, 'N/A')
      else pass(`install.ps1: ${config.name}${isWin ? ' (PS 5.1)' : ' (pwsh; 非 Windows)'}`)
    }
  }
  checkInstallerFlow()

  console.log(`\nPASS: ${passed} / FAIL: ${failed} / SKIPPED: ${skipped}`)
  exitCode = failed === 0 ? 0 : 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(exitCode)
