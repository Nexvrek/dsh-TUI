/**
 * Whether pi will skip a project's resources for want of a trust decision
 * (pi's `core/trust-manager.ts`, `core/project-trust.ts`).
 *
 * A project needs trust when its `.pi/` holds settings, MCP config,
 * extensions, skills, prompts or themes, or when it or a parent directory has
 * `.agents/skills` (the user's own `~/.agents/skills` excepted). pi then looks
 * for the nearest decision in `<agent dir>/trust.json` (the directory or a
 * parent), else its `defaultProjectTrust` setting; with the default `ask`, a
 * pi without a terminal UI — RPC mode — treats the project as untrusted and
 * says nothing. This backend never decides trust for pi; it only tells the
 * user when that silent skip is what happened.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { rec } from './narrow.js'
import { piAgentDir } from './paths.js'

const PROJECT_RESOURCES = ['settings.json', 'mcp.json', 'extensions', 'skills', 'prompts', 'themes'] as const

function canonical(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

/** Whether pi asks for trust before loading this project's resources. */
export function piProjectNeedsTrust(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const home = canonical(env.HOME || homedir())
  const userSkills = join(home, '.agents', 'skills')
  let dir = canonical(cwd)
  if (PROJECT_RESOURCES.some(entry => existsSync(join(dir, '.pi', entry)))) return true
  for (;;) {
    const skills = join(dir, '.agents', 'skills')
    if (skills !== userSkills && existsSync(skills)) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** The nearest trust decision for `cwd`, else null. */
export function piTrustDecision(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean | null {
  let data: Readonly<Record<string, unknown>> | undefined
  try {
    data = rec(JSON.parse(readFileSync(join(piAgentDir(env), 'trust.json'), 'utf8').replace(/^﻿/u, '')))
  } catch {
    data = undefined
  }
  if (data === undefined) return null
  let dir = canonical(cwd)
  for (;;) {
    const value = data[dir]
    if (value === true || value === false) return value
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** pi's `defaultProjectTrust` (global settings), `ask` when unset or unreadable. */
function defaultProjectTrust(env: NodeJS.ProcessEnv): 'always' | 'never' | 'ask' {
  try {
    const value = rec(JSON.parse(readFileSync(join(piAgentDir(env), 'settings.json'), 'utf8')))?.defaultProjectTrust
    return value === 'always' || value === 'never' ? value : 'ask'
  } catch {
    return 'ask'
  }
}

/** True when pi in RPC mode will silently leave this project's resources out:
 *  they need trust, nothing decided it, and the default is to ask. */
export function piTrustUnsettled(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return piProjectNeedsTrust(cwd, env) && piTrustDecision(cwd, env) === null && defaultProjectTrust(env) === 'ask'
}
