import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const ORG_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const HOME = 'C:/Users/t'
const LOCAL = `${HOME}/AppData/Local`
const DESKTOP = `${LOCAL}/Claude-Data/claude_test`
const STORE = `${HOME}/.claude/account-switcher`
const CREDENTIALS = `${HOME}/.claude/.credentials.json`
const GLOBAL = `${HOME}/.claude.json`
const NOW = 1_000_000

const tokens = (who: string, expiresAt = 10 ** 13) => ({ accessToken: `access-${who}`, refreshToken: `refresh-${who}`, expiresAt })
const profile = (uuid: string, email: string, org?: { uuid: string; name: string }) => ({
  accountUuid: uuid,
  emailAddress: email,
  organizationName: org?.name ?? `${email} org`,
  ...(org ? { organizationUuid: org.uuid } : {}),
})

// Who the account server says each access token belongs to.
const SERVER: Record<string, { account: { uuid: string; email: string }; organization: { uuid?: string; name: string } }> = {
  'access-A': { account: { uuid: A, email: 'a@example.com' }, organization: { name: 'a@example.com org' } },
  'access-B': { account: { uuid: B, email: 'b@example.com' }, organization: { name: 'b@example.com org' } },
  'access-A1': { account: { uuid: A, email: 'a@example.com' }, organization: { uuid: ORG_1, name: 'Home' } },
  'access-A2': { account: { uuid: A, email: 'a@example.com' }, organization: { uuid: ORG_2, name: 'Work' } },
}

// The world beneath the plugin: a file system, the account server and the
// processes it starts, each answered from memory. A path in `locked` exists
// but can't be read, as a file another program holds; `mtimes` says when a
// file was last written (0 when not listed).
function world(on: On, files: Map<string, string>, { locked = new Set<string>(), mtimes = new Map<string, number>() } = {}) {
  const norm = (path: string) => path.replace(/\\/g, '/')
  const runs: string[][] = []
  const toasts: string[] = []
  const isDir = (path: string) => [...files.keys()].some(key => key.startsWith(`${path}/`))

  on('fs.read', (_, e) => {
    const path = norm(e.path)
    if (locked.has(path)) throw new Error(`EBUSY: ${e.path}`)
    const text = files.get(path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => {
    const path = norm(e.path)
    return { value: files.has(path) || locked.has(path) || isDir(path) }
  })
  on('fs.stat', (_, e) => {
    const path = norm(e.path)
    if (!files.has(path) && !isDir(path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: files.has(path) ? 'file' : 'dir', size: 0, mtimeMs: mtimes.get(path) ?? 0, isLink: false } }
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
    const who = SERVER[(e.init?.headers?.Authorization ?? '').replace(/^Bearer /, '')]
    return {
      value: who ? { status: 200, ok: true, headers: {}, text: JSON.stringify(who) } : { status: 401, ok: false, headers: {}, text: '' },
    }
  })
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    // The removal command: `rm` with the paths after its flags, or PowerShell
    // naming them as quoted literals.
    const script = e.argv.at(-1) ?? ''
    const gone =
      e.argv[0] === 'rm' ? e.argv.slice(2) : script.includes('Remove-Item') ? [...script.matchAll(/'([^']+)'/g)].map(m => m[1]!) : []
    for (const path of gone.map(norm)) {
      for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)

  return { runs, toasts, clock }
}

// What the engine stamps on a command typed at the prompt.
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
const accounts = ($: Engine, args: string) => $.command.run({ command: 'accounts', args, ...TYPED })

const json = (value: unknown) => JSON.stringify(value)
const parse = (files: Map<string, string>, path: string) => JSON.parse(files.get(path) ?? 'null')
const unidentified = (files: Map<string, string>) => [...files.keys()].filter(key => key.includes('/cli/unidentified-'))

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

const DESKTOP_ENV = (uuid: string) => ({
  USERPROFILE: HOME,
  LOCALAPPDATA: LOCAL,
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
  CLAUDE_CODE_ACCOUNT_UUID: uuid,
})

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
  const ran = await accounts($, 'b@example')

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
    [CREDENTIALS, json({ claudeAiOauth: tokens('B', 0) })],
    [GLOBAL, json({ oauthAccount: profile(A, 'a@example.com') })],
    [`${STORE}/cli/${A}.json`, json({ claudeAiOauth: tokens('A'), oauthAccount: profile(A, 'a@example.com'), savedAt: 1 })],
    [`${STORE}/cli/${B}.json`, json({ claudeAiOauth: tokens('B', 0), oauthAccount: profile(B, 'b@example.com'), savedAt: 1 })],
    [`${STORE}/accounts.json`, json({ accounts: { [A]: { email: 'a@example.com' }, [B]: { email: 'b@example.com' } } })],
  ])
  world(on, files)
  mock.env(on, { USERPROFILE: HOME, HOME })

  const listed = await accounts($, 'list')
  expect(listed.text).toContain('b@example.com: app —, CLI in use')

  const ran = await accounts($, 'a@example.com')
  expect(ran.text).toBe('The CLI is now signed in as a@example.com.')
  expect(parse(files, CREDENTIALS).claudeAiOauth.refreshToken).toBe('refresh-A')
  expect(unidentified(files)).toEqual([])
})

test('a login refreshed while nothing watched is filed under the account its profile names', async ($, on) => {
  const files = new Map([
    // The CLI refreshed A's login (a new refresh token) and its access token has
    // since expired, so neither the saved copy nor the server can name it.
    [CREDENTIALS, json({ claudeAiOauth: { ...tokens('A-new'), expiresAt: 500 } })],
    [GLOBAL, json({ oauthAccount: profile(A, 'a@example.com') })],
    [`${STORE}/cli/${A}.json`, json({ claudeAiOauth: tokens('A', 100), oauthAccount: profile(A, 'a@example.com'), savedAt: 1 })],
    [`${STORE}/cli/${B}.json`, json({ claudeAiOauth: tokens('B'), oauthAccount: profile(B, 'b@example.com'), savedAt: 1 })],
    [`${STORE}/accounts.json`, json({ accounts: { [A]: { email: 'a@example.com' }, [B]: { email: 'b@example.com' } } })],
  ])
  world(on, files)
  mock.env(on, { USERPROFILE: HOME, HOME })

  expect((await accounts($, 'list')).text).toContain('a@example.com: app —, CLI in use')
  expect(parse(files, `${STORE}/cli/${A}.json`).claudeAiOauth.refreshToken).toBe('refresh-A-new')
  // The copy it replaced is kept aside.
  expect(parse(files, `${STORE}/replaced/${A}.json`).claudeAiOauth.refreshToken).toBe('refresh-A')

  await accounts($, 'b@')
  await accounts($, 'a@')
  expect(parse(files, CREDENTIALS).claudeAiOauth.refreshToken).toBe('refresh-A-new')
  expect(unidentified(files)).toEqual([])
})

test('a login nobody can name is kept once, shown as signed in, and named by its profile', async ($, on) => {
  const files = new Map([
    [CREDENTIALS, json({ claudeAiOauth: tokens('X', 0) })],
    [GLOBAL, json({ oauthAccount: { emailAddress: 'x@example.com' } })],
    [`${STORE}/cli/${B}.json`, json({ claudeAiOauth: tokens('B'), oauthAccount: profile(B, 'b@example.com'), savedAt: 1 })],
    [`${STORE}/accounts.json`, json({ accounts: { [B]: { email: 'b@example.com' } } })],
  ])
  world(on, files)
  mock.env(on, { USERPROFILE: HOME, HOME })

  const listed = await accounts($, 'list')
  expect(listed.text).toContain('The CLI is signed in, account not recognized yet')

  await accounts($, 'add cli')
  await accounts($, 'add cli')
  expect(unidentified(files).length).toBe(1)

  await accounts($, 'b@')
  expect(unidentified(files).length).toBe(1)
  expect((await accounts($, 'list')).text).toContain('x@example.com (unverified): app —, CLI saved')

  // Switching back restores both the login and the profile beside it.
  await accounts($, 'x@')
  expect(parse(files, CREDENTIALS).claudeAiOauth.refreshToken).toBe('refresh-X')
  expect(parse(files, GLOBAL).oauthAccount.emailAddress).toBe('x@example.com')
})

test('two organizations of one account keep two CLI logins', async ($, on) => {
  const files = new Map([
    [CREDENTIALS, json({ claudeAiOauth: tokens('A2') })],
    [GLOBAL, json({ oauthAccount: profile(A, 'a@example.com', { uuid: ORG_2, name: 'Work' }) })],
    [`${STORE}/cli/${A}.json`, json({ claudeAiOauth: tokens('A1'), oauthAccount: profile(A, 'a@example.com', { uuid: ORG_1, name: 'Home' }), savedAt: 1 })],
    [`${STORE}/accounts.json`, json({ accounts: { [A]: { email: 'a@example.com', orgName: 'Home' } } })],
  ])
  world(on, files)
  mock.env(on, { USERPROFILE: HOME, HOME })

  const listed = await accounts($, 'list')
  expect(listed.text).toContain('a@example.com (Work): app —, CLI in use')
  expect(listed.text).toContain('a@example.com (Home): app —, CLI saved')
  expect(parse(files, `${STORE}/cli/${A}.json`).claudeAiOauth.refreshToken).toBe('refresh-A1')
  expect(parse(files, `${STORE}/cli/${A}.${ORG_2}.json`).claudeAiOauth.refreshToken).toBe('refresh-A2')

  const ambiguous = await accounts($, 'a@example.com')
  expect(ambiguous.text).toContain('matches a@example.com (Work), a@example.com (Home)')

  const ran = await accounts($, 'home')
  expect(ran.text).toBe('The CLI is now signed in as a@example.com (Home).')
  expect(parse(files, CREDENTIALS).claudeAiOauth.refreshToken).toBe('refresh-A1')
  expect(parse(files, `${STORE}/cli/${A}.${ORG_2}.json`).claudeAiOauth.refreshToken).toBe('refresh-A2')
})

test('an older index names no organizations, and one that cannot be read is not written over', async ($, on) => {
  const index = `${STORE}/accounts.json`
  const files = new Map([
    [CREDENTIALS, json({ claudeAiOauth: tokens('A2') })],
    [GLOBAL, json({ oauthAccount: profile(A, 'a@example.com', { uuid: ORG_2, name: 'Work' }) })],
    [`${STORE}/cli/${A}.json`, json({ claudeAiOauth: tokens('A1'), oauthAccount: profile(A, 'a@example.com', { uuid: ORG_1, name: 'Home' }), savedAt: 1 })],
    [index, json({ accounts: { [A]: { email: 'a@example.com' } } })],
  ])
  const locked = new Set<string>()
  world(on, files, { locked })
  mock.env(on, { USERPROFILE: HOME, HOME })

  const listed = await accounts($, 'list')
  expect(listed.text).toContain('a@example.com (Home): app —, CLI saved')
  expect(listed.text).toContain('a@example.com (Work): app —, CLI in use')

  files.set(CREDENTIALS, json({ claudeAiOauth: tokens('B') }))
  files.set(GLOBAL, json({ oauthAccount: profile(B, 'b@example.com') }))
  const before = files.get(index)
  locked.add(index)
  await accounts($, 'list')
  expect(files.get(index)).toBe(before)

  locked.clear()
  await accounts($, 'list')
  expect(Object.keys(parse(files, index).accounts)).toEqual(expect.arrayContaining([A, `${A}.${ORG_2}`, B]))
})

test('a login file that cannot be read is left alone', async ($, on) => {
  const files = new Map([
    [CREDENTIALS, json({ claudeAiOauth: tokens('A'), mcpOAuth: { linear: {} } })],
    [GLOBAL, json({ oauthAccount: profile(A, 'a@example.com') })],
    [`${STORE}/cli/${B}.json`, json({ claudeAiOauth: tokens('B'), oauthAccount: profile(B, 'b@example.com'), savedAt: 1 })],
    [`${STORE}/accounts.json`, json({ accounts: { [B]: { email: 'b@example.com' } } })],
  ])
  const locked = new Set<string>()
  world(on, files, { locked })
  mock.env(on, { USERPROFILE: HOME, HOME })

  await accounts($, 'list')
  locked.add(CREDENTIALS)
  const ran = await accounts($, 'b@')
  expect(ran.text).toContain('The CLI was not switched: its login file could not be read')
  locked.clear()
  expect(parse(files, CREDENTIALS).claudeAiOauth.refreshToken).toBe('refresh-A')
  expect(parse(files, CREDENTIALS).mcpOAuth).toEqual({ linear: {} })

  locked.add(GLOBAL)
  expect((await accounts($, 'b@')).text).toContain('.claude.json could not be read')
  locked.clear()
  expect(parse(files, CREDENTIALS).claudeAiOauth.refreshToken).toBe('refresh-A')
})

test('the desktop app switch hands a quoted command line to the helper', async ($, on) => {
  const files = new Map([
    [`${DESKTOP}/config.json`, json({ lastKnownAccountUuid: A, 'oauth:tokenCache': 'x' })],
    [`${STORE}/desktop/${B}/auth.json`, json({ lastKnownAccountUuid: B })],
    [`${STORE}/accounts.json`, json({ accounts: { [B]: { email: 'b@example.com' } } })],
  ])
  const { runs } = world(on, files)
  mock.env(on, { ...DESKTOP_ENV(A), CLAUDE_CODE_USER_EMAIL: 'a@example.com' })

  const ran = await accounts($, 'b@')

  expect(ran.text).toBe('Restarting the app as b@example.com…')
  expect(runs.length).toBe(1)
  const launcher = runs[0]!.at(-1)!
  expect(launcher).toContain('Invoke-CimMethod -ClassName Win32_Process -MethodName Create')
  expect(launcher).toContain(`-DataDir "C:\\Users\\t\\AppData\\Local\\Claude-Data\\claude_test"`)
  expect(launcher).toContain(`-StoreDir "C:\\Users\\t\\.claude\\account-switcher"`)
  expect(launcher).toContain(`-Mode switch -To ${B}`)
  // Chats come along only where the Windows app's setting turned that on.
  expect(launcher).not.toContain('-SyncChats')
  // The account this session runs as is remembered under its email.
  expect(parse(files, `${STORE}/accounts.json`).accounts[A].email).toBe('a@example.com')

  const again = await accounts($, 'b@')
  expect(again.text).toBe('An app switch is already under way.')
})

test('a terminal session hears how its app switch went, and can switch again', async ($, on) => {
  const files = new Map([
    [`${DESKTOP}/config.json`, json({ lastKnownAccountUuid: A, 'oauth:tokenCache': 'x' })],
    [`${STORE}/desktop/${B}/auth.json`, json({ lastKnownAccountUuid: B })],
    [`${STORE}/settings.json`, json({ syncChats: true })],
    [`${STORE}/accounts.json`, json({ accounts: { [A]: { email: 'a@example.com' }, [B]: { email: 'b@example.com' } } })],
  ])
  const { runs, toasts, clock } = world(on, files)
  mock.env(on, { USERPROFILE: HOME, LOCALAPPDATA: LOCAL })

  expect((await accounts($, 'b@ app')).text).toBe('Restarting the app as b@example.com…')
  expect(runs[0]!.at(-1)).toContain('-SyncChats')

  // The helper finishes: the app is B's now.
  await clock.advance(10_000)
  files.set(`${DESKTOP}/config.json`, json({ lastKnownAccountUuid: B, 'oauth:tokenCache': 'y' }))
  files.set(`${STORE}/desktop/${A}/auth.json`, json({ lastKnownAccountUuid: A }))
  files.set(`${STORE}/last-swap.json`, json({ ok: true, mode: 'switch', from: A, to: B, at: clock.now(), chats: 2 }))
  await clock.advance(3_000)
  expect(toasts).toEqual(['Switched the app to b@example.com. 2 chats came along.'])

  expect((await accounts($, 'a@ app')).text).toBe('Restarting the app as a@example.com…')
  expect(runs.length).toBe(2)

  // This one never reports back.
  await clock.advance(130_000)
  expect(toasts.at(-1)).toContain('The app switch did not report back.')
  expect((await accounts($, 'a@ app')).text).toBe('Restarting the app as a@example.com…')
})

test('a switch says what it could not do', async ($, on) => {
  const files = new Map([
    [`${DESKTOP}/config.json`, json({ lastKnownAccountUuid: A, 'oauth:tokenCache': 'x' })],
    [CREDENTIALS, json({ claudeAiOauth: tokens('A') })],
    [GLOBAL, json({ oauthAccount: profile(A, 'a@example.com') })],
    [`${STORE}/cli/${B}.json`, json({ claudeAiOauth: tokens('B'), oauthAccount: profile(B, 'b@example.com'), savedAt: 1 })],
    [`${STORE}/accounts.json`, json({ accounts: { [A]: { email: 'a@example.com' }, [B]: { email: 'b@example.com' } } })],
  ])
  const { runs } = world(on, files)
  mock.env(on, { USERPROFILE: HOME, LOCALAPPDATA: LOCAL })

  expect((await accounts($, 'b@ app')).text).toBe('b@example.com has no saved app sign-in yet.')
  expect((await accounts($, 'a@ app')).text).toBe('The app already uses a@example.com.')
  expect((await accounts($, 'a@')).text).toBe('Already using a@example.com.')
  expect(runs).toEqual([])
})

test('names given in the Windows app are used, and removing an account forgets it', async ($, on) => {
  const files = new Map([
    [CREDENTIALS, json({ claudeAiOauth: tokens('A') })],
    [GLOBAL, json({ oauthAccount: profile(A, 'a@example.com') })],
    [`${STORE}/cli/${B}.json`, json({ claudeAiOauth: tokens('B'), oauthAccount: profile(B, 'b@example.com'), savedAt: 1 })],
    [`${STORE}/accounts.json`, json({ accounts: { [B]: { email: 'b@example.com' } } })],
    [`${STORE}/labels.json`, json({ [B]: 'Work' })],
  ])
  const { runs } = world(on, files)
  mock.env(on, { USERPROFILE: HOME, HOME })

  await accounts($, 'list')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Work' })).toBeDefined()

  await ui.press({ key: `remove-${B}` })
  expect(files.has(`${STORE}/cli/${B}.json`)).toBe(true)
  await ui.press({ key: `remove-${B}` })
  expect((await ui.find({ type: 'Text', text: /^Removed/ }))?.text).toBe('Removed Work.')
  expect(runs.length).toBe(1)
  expect(files.has(`${STORE}/cli/${B}.json`)).toBe(false)
  expect(parse(files, `${STORE}/accounts.json`).accounts[B]).toBeUndefined()
  expect(parse(files, `${STORE}/labels.json`)[B]).toBeUndefined()
  await ui.unmount()
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

  const ran = await $.command.run({ command: 'login', args: '', ...TYPED })

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
    await accounts($, 'list')

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
  mock.env(on, DESKTOP_ENV(B))

  await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })
  await $.session.start({ cwd: HOME, surface: 'desktop', isInteractive: true })

  expect(toasts).toEqual(['Switched the app to b@example.com.'])
})

test('the app data folder the app wrote last is the one switched', async ($, on) => {
  const OLD = `${HOME}/AppData/Roaming/Claude`
  const files = new Map([
    [`${DESKTOP}/config.json`, json({ lastKnownAccountUuid: A, 'oauth:tokenCache': 'x' })],
    [`${OLD}/config.json`, json({ lastKnownAccountUuid: B, 'oauth:tokenCache': 'x' })],
    [`${STORE}/desktop/${B}/auth.json`, json({ lastKnownAccountUuid: B })],
  ])
  const { runs } = world(on, files, { mtimes: new Map([[`${DESKTOP}/config.json`, 2], [`${OLD}/config.json`, 1]]) })
  mock.env(on, { USERPROFILE: HOME, LOCALAPPDATA: LOCAL, APPDATA: `${HOME}/AppData/Roaming` })

  await accounts($, `${B.slice(0, 8)} app`)
  expect(runs[0]!.at(-1)).toContain('Claude-Data\\claude_test')
})
