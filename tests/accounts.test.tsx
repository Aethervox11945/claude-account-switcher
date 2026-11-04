import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const HOME = 'C:/Users/t'
const LOCAL = `${HOME}/AppData/Local`
const DESKTOP = `${LOCAL}/Claude-Data/claude_test`
const STORE = `${HOME}/.claude/account-switcher`
const CREDENTIALS = `${HOME}/.claude/.credentials.json`
const GLOBAL = `${HOME}/.claude.json`

const tokens = (who: string) => ({ accessToken: `access-${who}`, refreshToken: `refresh-${who}`, expiresAt: 10 ** 13 })
const profile = (uuid: string, email: string) => ({ accountUuid: uuid, emailAddress: email, organizationName: `${email} org` })

// The world beneath the plugin: a file system, the account server and the
// processes it starts, each answered from memory.
function world(on: On, files: Map<string, string>) {
  const norm = (path: string) => path.replace(/\\/g, '/')
  const runs: string[][] = []
  const toasts: string[] = []

  on('fs.read', (_, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => {
    const path = norm(e.path)
    return { value: files.has(path) || [...files.keys()].some(key => key.startsWith(`${path}/`)) }
  })
  on('fs.list', (_, e) => {
    const dir = `${norm(e.path).replace(/\/$/, '')}/`
    const found = new Map<string, 'file' | 'dir'>()
    for (const key of files.keys()) {
      if (!key.startsWith(dir)) continue
      const [head, ...rest] = key.slice(dir.length).split('/')
      found.set(head!, rest.length > 0 ? 'dir' : 'file')
    }
    if (found.size === 0) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...found].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('http.fetch', (_, e) => {
    const auth = e.init?.headers?.Authorization ?? ''
    const who = auth === 'Bearer access-A' ? { uuid: A, email: 'a@example.com' } : auth === 'Bearer access-B' ? { uuid: B, email: 'b@example.com' } : undefined
    return {
      value: who
        ? { status: 200, ok: true, headers: {}, text: JSON.stringify({ account: who, organization: { name: `${who.email} org` } }) }
        : { status: 401, ok: false, headers: {}, text: '' },
    }
  })
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)

  return { runs, toasts }
}

const json = (value: unknown) => JSON.stringify(value)
const parse = (files: Map<string, string>, path: string) => JSON.parse(files.get(path) ?? 'null')

const PANE = {
  plugin: 'account-switcher',
  component: 'Pane',
  requestId: 'accounts',
  props: {
    title: 'Accounts',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the CLI switches in place, saving the login it leaves and keeping MCP tokens', async ($, on) => {
  const files = new Map([
    [CREDENTIALS, json({ claudeAiOauth: tokens('A'), mcpOAuth: { linear: { accessToken: 'mcp' } } })],
    [GLOBAL, json({ numStartups: 3, oauthAccount: profile(A, 'a@example.com') })],
    [`${STORE}/cli/${B}.json`, json({ claudeAiOauth: tokens('B'), oauthAccount: profile(B, 'b@example.com'), savedAt: 1 })],
    [`${STORE}/accounts.json`, json({ accounts: { [B]: { email: 'b@example.com' } } })],
  ])
  world(on, files)
  mock.env(on, { USERPROFILE: HOME, HOME, CLAUDE_CODE_ENTRYPOINT: 'cli' })

  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'accounts', args: 'b@example' })

  expect(ran.text).toBe('The CLI is now signed in as b@example.com.')
  const credentials = parse(files, CREDENTIALS)
  expect(credentials.claudeAiOauth.refreshToken).toBe('refresh-B')
  expect(credentials.mcpOAuth.linear.accessToken).toBe('mcp')
  expect(parse(files, GLOBAL).oauthAccount.accountUuid).toBe(B)
  expect(parse(files, GLOBAL).numStartups).toBe(3)
  expect(parse(files, `${STORE}/cli/${A}.json`).claudeAiOauth.refreshToken).toBe('refresh-A')
})

test('switching back finds the saved login by its token, with the server unreachable', async ($, on) => {
  const files = new Map([
    // B's access token is expired, so only the saved copy can name it.
    [CREDENTIALS, json({ claudeAiOauth: { ...tokens('B'), expiresAt: 0 } })],
    [GLOBAL, json({ oauthAccount: profile(A, 'a@example.com') })],
    [`${STORE}/cli/${A}.json`, json({ claudeAiOauth: tokens('A'), oauthAccount: profile(A, 'a@example.com'), savedAt: 1 })],
    [`${STORE}/cli/${B}.json`, json({ claudeAiOauth: { ...tokens('B'), expiresAt: 0 }, oauthAccount: profile(B, 'b@example.com'), savedAt: 1 })],
    [`${STORE}/accounts.json`, json({ accounts: { [A]: { email: 'a@example.com' }, [B]: { email: 'b@example.com' } } })],
  ])
  world(on, files)
  mock.env(on, { USERPROFILE: HOME, HOME })

  const listed = await $.command.run({ command: 'accounts', args: 'list' })
  expect(listed.text).toContain('b@example.com: app —, CLI in use')

  const ran = await $.command.run({ command: 'accounts', args: 'a@example.com' })
  expect(ran.text).toBe('The CLI is now signed in as a@example.com.')
  expect(parse(files, CREDENTIALS).claudeAiOauth.refreshToken).toBe('refresh-A')
  expect([...files.keys()].some(key => key.includes('unidentified'))).toBe(false)
})

test('the desktop app switch hands a quoted command line to the helper', async ($, on) => {
  const files = new Map([
    [`${DESKTOP}/config.json`, json({ lastKnownAccountUuid: A, 'oauth:tokenCache': 'x' })],
    [`${STORE}/desktop/${B}/auth.json`, json({ lastKnownAccountUuid: B })],
    [`${STORE}/accounts.json`, json({ accounts: { [B]: { email: 'b@example.com' } } })],
  ])
  const { runs } = world(on, files)
  mock.env(on, {
    USERPROFILE: HOME,
    LOCALAPPDATA: LOCAL,
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    CLAUDE_CODE_ACCOUNT_UUID: A,
    CLAUDE_CODE_USER_EMAIL: 'a@example.com',
  })

  const ran = await $.command.run({ command: 'accounts', args: 'b@' })

  expect(ran.text).toBe('Restarting the app as b@example.com…')
  expect(runs.length).toBe(1)
  const launcher = runs[0]!.at(-1)!
  expect(launcher).toContain('Invoke-CimMethod -ClassName Win32_Process -MethodName Create')
  expect(launcher).toContain(`-DataDir "C:\\Users\\t\\AppData\\Local\\Claude-Data\\claude_test"`)
  expect(launcher).toContain(`-StoreDir "C:\\Users\\t\\.claude\\account-switcher"`)
  expect(launcher).toContain(`-Mode switch -To ${B}`)
  // The account this session runs as is remembered under its email.
  expect(parse(files, `${STORE}/accounts.json`).accounts[A].email).toBe('a@example.com')

  const again = await $.command.run({ command: 'accounts', args: 'b@' })
  expect(again.text).toBe('An app switch is already under way.')
})

test('/login saves the CLI login it replaces before it runs', async ($, on) => {
  const files = new Map([[CREDENTIALS, json({ claudeAiOauth: tokens('A') })], [GLOBAL, json({})]])
  world(on, files)
  mock.env(on, { USERPROFILE: HOME, HOME })
  let savedFirst = false
  on('command.run', { command: 'login' }, () => {
    savedFirst = files.has(`${STORE}/cli/${A}.json`)
    return { text: 'Login successful' }
  })

  const ran = await $.command.run({ command: 'login' })

  expect(ran.text).toBe('Login successful')
  expect(savedFirst).toBe(true)
})

test('the pane lists accounts and switches one on a press, on every surface', async ($, on) => {
  const files = new Map<string, string>()
  world(on, files)
  mock.env(on, { USERPROFILE: HOME, HOME })

  for (const surface of ['terminal', 'desktop'] as const) {
    files.clear()
    files.set(CREDENTIALS, json({ claudeAiOauth: tokens('A') }))
    files.set(GLOBAL, json({ oauthAccount: profile(A, 'a@example.com') }))
    files.set(`${STORE}/cli/${B}.json`, json({ claudeAiOauth: tokens('B'), oauthAccount: profile(B, 'b@example.com'), savedAt: 1 }))
    files.set(`${STORE}/accounts.json`, json({ accounts: { [B]: { email: 'b@example.com' } } }))
    await $.command.run({ command: 'accounts', args: 'list' })

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^CLI: a@example\.com/ }))?.text).toBe('CLI: a@example.com')
    expect(await ui.find({ type: 'Text', text: 'b@example.com' })).toBeDefined()

    await ui.press({ key: `switch-${B}` })
    expect(parse(files, CREDENTIALS).claudeAiOauth.refreshToken).toBe('refresh-B')
    expect((await ui.find({ type: 'Text', text: /now signed in/ }))?.text).toBe('The CLI is now signed in as b@example.com.')
    await ui.unmount()
  }
})

test('the first session after an app switch says how it went', async ($, on) => {
  const files = new Map([
    [`${DESKTOP}/config.json`, json({ lastKnownAccountUuid: B, 'oauth:tokenCacheV2': 'x' })],
    [`${STORE}/accounts.json`, json({ accounts: { [B]: { email: 'b@example.com' } } })],
    [`${STORE}/last-swap.json`, json({ ok: true, mode: 'switch', from: A, to: B, at: 5 })],
  ])
  const { toasts } = world(on, files)
  mock.env(on, { USERPROFILE: HOME, LOCALAPPDATA: LOCAL, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_ACCOUNT_UUID: B })

  await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
  await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })

  expect(toasts).toEqual(['Switched the app to b@example.com.'])
})
