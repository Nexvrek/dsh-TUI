/**
 * The pi backend's own copy: every string this backend puts on screen, in
 * the languages the TUI ships. A backend does not read the host dictionary
 * (D2); the shape and the `{{name}}` rule are shared
 * (`src/backends/shared/localized-text.ts`), and the platform strings it
 * renders come from the one shared source (`src/backends/shared/platform-text.ts`).
 *
 * The language is read live from the host (`BackendHost.locale`), installed
 * by `detect()`/`open()`; before either runs the fallback is `zh`, the same
 * last-resort default the host documents.
 */
import type { BackendLocale } from '../../agent/backend.js'
import { fillTemplate, type LocalizedText, type TextParams } from '../shared/localized-text.js'
import { pickPlatformText } from '../shared/platform-text.js'

/**
 * Every string of this backend. `zh` and `en` are both required
 * (`scripts/verify-i18n.ts` checks language completeness, placeholder
 * parity and single-brace typos).
 */
const texts = {
  // ── Detection and startup ──
  'pi-not-installed': { zh: '没有找到 pi：用 `npm install -g @earendil-works/pi-coding-agent` 安装，或用 DSH_TUI_PI_EXECUTABLE 指定可执行文件', en: 'pi was not found: install it with `npm install -g @earendil-works/pi-coding-agent`, or point DSH_TUI_PI_EXECUTABLE at the executable' },
  'pi-too-old': { zh: '本机 pi {{version}} 太旧，至少需要 {{min}}（`pi update` 升级）', en: 'pi {{version}} is too old; {{min}} or newer is required (upgrade with `pi update`)' },
  'pi-auth-unknown-hint': { zh: '没有看到 pi 的模型凭据：若启动失败，先在终端运行 `pi` 用 /login 登录，或设置提供方的 API key 环境变量', en: 'No pi model credential was found: if startup fails, run `pi` in a terminal and /login, or set the provider\'s API key variable' },
  'pi-start-failed': { zh: 'pi 启动失败：{{err}}', en: 'pi failed to start: {{err}}' },
  'pi-resume-not-found': { zh: '找不到 pi 会话 {{id}}', en: 'No pi session {{id}} was found' },
  'pi-resume-cwd-missing': { zh: 'pi 会话 {{id}} 的工作目录 {{cwd}} 已不存在', en: 'The working directory {{cwd}} of pi session {{id}} no longer exists' },
  'pi-version-drift': { zh: 'pi {{version}} 未经验证（已验证：{{validated}}），继续运行', en: 'pi {{version}} is not validated (validated: {{validated}}); running anyway' },
  'pi-no-model': { zh: 'pi 没有选中模型：用 /model 选一个，或在 pi 里登录提供方', en: 'pi has no model selected: pick one with /model, or sign in to a provider in pi' },
  'pi-process-exited': { zh: 'pi 进程已退出：{{err}}', en: 'The pi process exited: {{err}}' },
  'pi-session-closed': { zh: 'pi 会话已关闭', en: 'The pi session is closed' },
  'pi-session-lost': { zh: 'pi 进程已退出，这个会话不能再发送消息（用 /resume 重新打开）', en: 'The pi process exited; this session cannot take messages any more (reopen it with /resume)' },
  // ── Turns, tools and notices ──
  'pi-interrupted': { zh: '已中断', en: 'Interrupted' },
  'pi-tool-unfinished': { zh: '回合结束时仍未完成', en: 'Unfinished when the turn ended' },
  'pi-reply-failed': { zh: '模型回复失败：{{err}}', en: 'The model reply failed: {{err}}' },
  'pi-exit-code': { zh: '退出码 {{code}}', en: 'exit code {{code}}' },
  'pi-branch-summary': { zh: '分支摘要：{{summary}}', en: 'Branch summary: {{summary}}' },
  'pi-retry': { zh: '请求失败，{{seconds}} 秒后重试（第 {{attempt}}/{{max}} 次）：{{err}}', en: 'Request failed; retrying in {{seconds}}s (attempt {{attempt}}/{{max}}): {{err}}' },
  'pi-retry-failed': { zh: '重试后仍然失败：{{err}}', en: 'Still failing after retries: {{err}}' },
  'pi-extension-error': { zh: 'pi 扩展 {{extension}} 处理 {{event}} 时出错：{{err}}', en: 'The pi extension {{extension}} failed on {{event}}: {{err}}' },
  'pi-prompt-refused': { zh: 'pi 没有接受这条消息：{{err}}', en: 'pi did not take this message: {{err}}' },
  // ── Extension dialogs ──
  'pi-dialog-header': { zh: 'pi 扩展', en: 'pi extension' },
  'pi-dialog-yes': { zh: '是', en: 'Yes' },
  'pi-dialog-no': { zh: '否', en: 'No' },
  'pi-dialog-prefill': { zh: '留空则沿用：\n{{text}}', en: 'Leave empty to keep:\n{{text}}' },
  'pi-dialog-expired': { zh: 'pi 扩展的提问已超时，按默认处理', en: 'The pi extension\'s question timed out and took its default' },
  // ── Controls ──
  'pi-model-unknown': { zh: '找不到模型 {{model}}', en: 'No model {{model}} was found' },
  'pi-fork-unsaved': { zh: '这个会话还没有保存（发出第一条消息后才落盘），暂时不能分叉或回退', en: 'This session is not saved yet (pi writes it at the first message), so it cannot be forked or rewound' },
  'pi-anchor-missing': { zh: '在 pi 会话里找不到这条消息', en: 'This message was not found in the pi session' },
  'pi-rewind-files-unsupported': { zh: 'pi 不记录文件快照，只能回退对话', en: 'pi keeps no file snapshots; only the conversation can be rewound' },
  'pi-trust-unsettled': { zh: '这个项目的 pi 资源（.pi/ 或 .agents/skills）没有加载：pi 还没被告知是否信任此目录，RPC 模式下不会询问。在终端运行一次 `pi` 并选择信任，或在 pi 设置里配置 defaultProjectTrust', en: 'This project\'s pi resources (.pi/ or .agents/skills) were not loaded: pi has no trust decision for this folder and does not ask in RPC mode. Run `pi` here once and trust it, or set defaultProjectTrust in pi\'s settings' },
  // ── Images ──
  'pi-images-too-many': { zh: '一条消息最多 {{n}} 张图片', en: 'At most {{n}} images per message' },
  'pi-image-type-refused': { zh: '图片 {{name}} 的类型 {{type}} 不受支持', en: 'The image {{name}} has an unsupported type {{type}}' },
  'pi-image-unreadable': { zh: '读不到图片 {{name}}', en: 'The image {{name}} could not be read' },
  'pi-image-too-large': { zh: '图片 {{name}} 超过 {{mb}} MB', en: 'The image {{name}} is larger than {{mb}} MB' },
  'pi-images-too-large': { zh: '这条消息的图片合计超过 {{mb}} MB', en: 'The images of this message exceed {{mb}} MB in total' },
  'pi-preview-image': { zh: '[图片]', en: '[image]' },
  // ── /doctor ──
  'pi-doctor-cli': { zh: 'pi：{{path}}（{{source}}）· 版本 {{version}}', en: 'pi: {{path}} ({{source}}) · version {{version}}' },
  'pi-doctor-agent-dir': { zh: 'pi 目录：{{dir}}', en: 'pi directory: {{dir}}' },
  'pi-doctor-session': { zh: '会话：{{id}} · {{file}}', en: 'Session: {{id}} · {{file}}' },
  'pi-doctor-unsaved': { zh: '（首条消息前尚未落盘）', en: '(not saved before the first message)' },
  'pi-doctor-model': { zh: '模型：{{provider}}/{{model}} · 思考等级 {{level}}', en: 'Model: {{provider}}/{{model}} · thinking level {{level}}' },
  'pi-doctor-exited': { zh: 'pi 进程已退出', en: 'The pi process has exited' },
  // ── Shared platform strings (one source, see the module comment) ──
  ...pickPlatformText([
    'doctor-unknown',
    'effort-invalid',
  ]),
} as const satisfies Record<string, { readonly zh: LocalizedText; readonly en: LocalizedText }>

/** Read-only view of {@link texts} for audits (`scripts/verify-i18n.ts`). */
export const piTexts: Readonly<Record<string, { readonly zh: LocalizedText; readonly en: LocalizedText }>> = texts

/** A key of {@link texts}; a typo is a compile error. */
export type PiTextKey = keyof typeof texts

/** Where the live language comes from: the host, in production. */
let localeSource: () => BackendLocale = () => 'zh'

/** Install the language source (`BackendHost.locale`). */
export function installPiLocale(source: () => BackendLocale): void {
  localeSource = source
}

/** The language this backend is writing in right now. */
export function piLocale(): BackendLocale {
  return localeSource()
}

/** One string of this backend in the active language. */
export function piText(key: PiTextKey, params: TextParams = {}): string {
  return fillTemplate(texts[key][piLocale()], params)
}
