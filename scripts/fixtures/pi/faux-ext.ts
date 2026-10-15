/**
 * A pi extension for regressions: a scripted model on pi's own faux provider
 * (`registerFauxProvider` from `@earendil-works/pi-ai`), so a real `pi --mode rpc`
 * produces its real event stream with no network and no provider charge.
 * Loaded by `scripts/lib/pi-faux.ts` through an isolated agent directory's
 * `settings.json`; never by a user's pi.
 *
 * The reply depends on the newest user text:
 *   "use tool"      → thinking + a `bash` call (`echo hello-from-tool`), then a reply quoting the result
 *   "use slow tool" → a `bash` call that sleeps a second (time to steer), then a reply
 *   "slow"          → a long streamed reply (time to interrupt)
 *   "think"         → thinking + text
 *   "read file"     → a `read` call of note.txt, then a reply
 *   anything else   → "echo: <text>"
 * `/ask-me` runs select → confirm → input dialogs and notifies the answers.
 */
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai'

type Block = { readonly type?: string; readonly text?: string }
type Message = { readonly role?: string; readonly content?: string | readonly Block[] }

function lastUserText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    return typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  }
  return ''
}

export default function (pi: { registerProvider(name: string, config: unknown): void; registerCommand(name: string, options: unknown): void }): void {
  const faux = registerFauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', name: 'Faux One', reasoning: true, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 4096 }],
    tokensPerSecond: 400,
  })
  const reply = (context: { readonly messages?: readonly Message[] }) => {
    const messages = context.messages ?? []
    const last = messages[messages.length - 1] as (Message & { readonly content?: readonly Block[] }) | undefined
    const text = lastUserText(messages)
    if (last?.role === 'toolResult') {
      const result = Array.isArray(last.content) ? last.content[0]?.text ?? '' : ''
      return fauxAssistantMessage([fauxText(`tool said: ${result.trim()}`)])
    }
    if (text.includes('use slow tool')) return fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 1; echo slow-done' })], { stopReason: 'toolUse' })
    if (text.includes('use tool')) return fauxAssistantMessage([fauxThinking('I should run a command.'), fauxToolCall('bash', { command: 'echo hello-from-tool' })], { stopReason: 'toolUse' })
    if (text.includes('read file')) return fauxAssistantMessage([fauxToolCall('read', { path: 'note.txt' })], { stopReason: 'toolUse' })
    if (text.includes('slow')) return fauxAssistantMessage([fauxText('slow '.repeat(600))])
    if (text.includes('think')) return fauxAssistantMessage([fauxThinking('Let me think about it.'), fauxText('Thought done.')])
    return fauxAssistantMessage([fauxText(`echo: ${text}`)])
  }
  faux.setResponses(Array.from({ length: 500 }, () => reply))
  pi.registerProvider('faux', {
    baseUrl: 'http://localhost:0',
    apiKey: 'faux-key',
    api: faux.api,
    models: faux.models.map(model => ({ id: model.id, name: model.name, reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens })),
  })
  pi.registerCommand('ask-me', {
    description: 'Ask through extension dialogs (regression fixture)',
    handler: async (_args: string, ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined>; confirm(title: string, message: string): Promise<boolean>; input(title: string, placeholder?: string): Promise<string | undefined>; notify(message: string, kind?: string): void } }) => {
      const pick = await ctx.ui.select('Pick a fruit', ['apple', 'pear'])
      const ok = await ctx.ui.confirm('Sure?', `You picked ${pick}`)
      const name = await ctx.ui.input('Your name?', 'type here')
      ctx.ui.notify(`picked=${pick} ok=${ok} name=${name}`, 'info')
    },
  })
}
