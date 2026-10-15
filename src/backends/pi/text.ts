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
  // ── Project trust ──
  'pi-trust-header': { zh: '项目信任', en: 'Project trust' },
  'pi-trust-question': { zh: '信任这个项目文件夹吗？', en: 'Trust this project folder?' },
  'pi-trust-found': { zh: '这里有 pi 的项目资源：{{resources}}', en: 'pi project resources here: {{resources}}' },
  'pi-trust-means': { zh: '信任后 pi 会加载 .pi 设置与资源、安装缺失的项目包，并执行项目扩展。记住的选择写入 pi 的 trust.json，与 pi 自己的界面共用。', en: 'Trusting lets pi load .pi settings and resources, install missing project packages, and execute project extensions. A remembered choice goes to pi\'s trust.json, shared with pi\'s own interface.' },
  'pi-trust-now-trusted': { zh: '当前：已信任，项目资源已加载', en: 'Now: trusted, the project\'s resources are loaded' },
  'pi-trust-now-untrusted': { zh: '当前：未信任，项目资源没有加载', en: 'Now: not trusted, the project\'s resources are not loaded' },
  'pi-trust-opt-trust': { zh: '信任', en: 'Trust' },
  'pi-trust-opt-parent': { zh: '信任上级文件夹（{{path}}）', en: 'Trust parent folder ({{path}})' },
  'pi-trust-opt-session': { zh: '仅本次信任', en: 'Trust (this session only)' },
  'pi-trust-opt-deny': { zh: '不信任', en: 'Do not trust' },
  'pi-trust-opt-deny-session': { zh: '仅本次不信任', en: 'Do not trust (this session only)' },
  'pi-trust-opt-remembered': { zh: '记住，写入 pi 的 trust.json', en: 'Remembered in pi\'s trust.json' },
  'pi-trust-opt-parent-desc': { zh: '记住，其下的项目都信任', en: 'Remembered; covers every project under it' },
  'pi-trust-opt-session-desc': { zh: '本次运行有效，不保存；下次启动再问', en: 'For this run only, not saved; asked again next time' },
  'pi-trust-restarting': { zh: '正在重启 pi 以应用信任设置…', en: 'Restarting pi to apply the trust setting…' },
  'pi-trust-applied': { zh: '已信任此项目：pi 已重启并加载项目资源', en: 'Project trusted: pi restarted with the project\'s resources' },
  'pi-trust-revoked': { zh: '已不再信任此项目：pi 已重启，项目资源已卸下', en: 'Project no longer trusted: pi restarted without the project\'s resources' },
  'pi-trust-deferred': { zh: '这一轮结束后 pi 会重启以应用信任设置', en: 'pi restarts to apply the trust setting once this turn ends' },
  'pi-trust-kept-trusted': { zh: '此项目保持信任，项目资源照常加载', en: 'The project stays trusted; its resources stay loaded' },
  'pi-trust-kept-untrusted': { zh: '此项目未被信任，项目的 pi 资源不会加载；可随时用 /trust 更改', en: 'The project is not trusted, so its pi resources stay unloaded; change it anytime with /trust' },
  'pi-trust-not-needed': { zh: '这个项目没有需要信任的 pi 资源', en: 'This project has no pi resources that need trust' },
  'pi-trust-write-failed': { zh: '没能写入 pi 的 trust.json：{{err}}', en: 'Could not write pi\'s trust.json: {{err}}' },
  'pi-trust-restart-failed': { zh: 'pi 重启失败：{{err}}', en: 'pi failed to restart: {{err}}' },
  'pi-trust-command': { zh: '查看或更改 pi 对此项目的信任', en: 'Review or change pi\'s trust for this project' },
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
