/**
 * pi backend detection: is a usable `pi` installed, is it a supported
 * version, and does it look like it has a model credential — all without
 * starting pi or touching the network. Never throws.
 *
 * The credential check is cheap and only ever says `ok` or `unknown`: pi's
 * stored logins (`auth.json`), its custom providers (`models.json`) and the
 * provider keys its docs name count as present. Anything else may still be
 * fine (an extension can register a provider), and pi itself names what is
 * missing when it refuses to start, so `unknown` never dims the row.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BackendDetection, BackendHost } from '../../agent/backend.js'
import { piText } from './text.js'
import { MIN_PI_VERSION, piVersionDrift, piVersionSupported } from './contract.js'
import { errorText, rec } from './narrow.js'
import { piAgentDir } from './paths.js'
import { resolvePiExecutable } from './rpc/binary.js'

/** Provider credentials pi reads from the environment (pi's docs/providers.md). */
const PROVIDER_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY', 'CEREBRAS_API_KEY',
  'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'ZAI_API_KEY', 'MINIMAX_API_KEY', 'FIREWORKS_API_KEY', 'TOGETHER_API_KEY',
  'AI_GATEWAY_API_KEY', 'COPILOT_GITHUB_TOKEN', 'HF_TOKEN', 'NVIDIA_API_KEY', 'OPENCODE_API_KEY',
]

/** Whether a credential is visible without a network call. */
export function detectPiAuth(env: NodeJS.ProcessEnv = process.env): 'ok' | 'unknown' {
  if (PROVIDER_ENV_KEYS.some(key => (env[key] ?? '') !== '')) return 'ok'
  const agentDir = piAgentDir(env)
  try {
    const stored = rec(JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8')))
    if (stored !== undefined && Object.keys(stored).length > 0) return 'ok'
  } catch { /* no stored login */ }
  if (existsSync(join(agentDir, 'models.json'))) return 'ok'
  return 'unknown'
}

export async function detectPi(host: BackendHost, env: NodeJS.ProcessEnv = process.env): Promise<BackendDetection> {
  try {
    const executable = await resolvePiExecutable(env)
    if (executable === undefined) return { installed: false, hint: piText('pi-not-installed') }
    const version = executable.version
    if (!piVersionSupported(version)) {
      return { installed: false, stale: true, ...(version === undefined ? {} : { version }), hint: piText('pi-too-old', { version: version ?? '', min: MIN_PI_VERSION }) }
    }
    const auth = detectPiAuth(env)
    const drift = piVersionDrift(version)
    return {
      installed: true,
      auth,
      ...(version === undefined ? {} : { version }),
      ...(drift === undefined ? {} : { drift }),
      ...(auth === 'ok' ? {} : { hint: piText('pi-auth-unknown-hint') }),
    }
  } catch (error) {
    host.debug(`pi: detection failed (${errorText(error)})`)
    return { installed: false }
  }
}
