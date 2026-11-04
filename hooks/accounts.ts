import type { EngineInterface } from 'claude-code'

import type { AccountRow, SwitcherView } from '../types'

type Engine = EngineInterface

// Where each piece lives. The CLI keeps its login in `.credentials.json` (next
// to the MCP servers' tokens, which a switch keeps) and the profile it shows in
// `.claude.json`; the desktop app keeps its own in its data folder.
export type Paths = {
  isWindows: boolean
  isMac: boolean
  credentials: string
  globalConfig: string
  store: string
  desktopData?: string
}

type Tokens = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
}

type CliSnapshot = {
  claudeAiOauth: Tokens
  oauthAccount?: Record<string, unknown>
  savedAt: number
}

type Identity = { uuid: string; email?: string; orgName?: string }

type Index = { accounts: Record<string, { email?: string; orgName?: string }> }

export type LastSwap = {
  ok: boolean
  mode: 'switch' | 'new'
  from?: string | null
  to?: string
  at: number
  error?: string | null
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A CLI login saved while its account could not be told (offline, token expired).
const UNIDENTIFIED = /^unidentified-\d+$/
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const DESKTOP_AUTH_KEYS = ['oauth:tokenCache', 'oauth:tokenCacheV2']

export const join = (...parts: string[]) =>
  parts
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/')

const toWindows = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '')

const quote = (arg: string) => `"${arg}"`

export const isAccountId = (id: string) => ACCOUNT_ID.test(id) || UNIDENTIFIED.test(id)

export const shortId = (id: string) => (UNIDENTIFIED.test(id) ? 'Unidentified CLI login' : `Account ${id.slice(0, 8)}`)

async function readJson<T>($: Engine, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function writeJson($: Engine, path: string, value: unknown) {
  await $.fs.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function listNames($: Engine, dir: string, kind: 'file' | 'dir') {
  const entries = await $.fs.list(dir).catch(() => [])

  return entries.filter(entry => entry.kind === kind).map(entry => entry.name)
}

export async function resolvePaths($: Engine): Promise<Paths> {
  const localAppData = await $.env.get('LOCALAPPDATA')
  const isWindows = localAppData !== undefined
  const home = isWindows ? ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))) : await $.env.get('HOME')
  if (home === undefined) {
    throw new Error('neither HOME nor USERPROFILE is set')
  }
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const configDir = configured ?? join(home, '.claude')

  return {
    isWindows,
    isMac: !isWindows && (await $.fs.exists('/System/Library/CoreServices/SystemVersion.plist')),
    credentials: join(configDir, '.credentials.json'),
    globalConfig: configured ? join(configured, '.claude.json') : join(home, '.claude.json'),
    store: join(configDir, 'account-switcher'),
    desktopData: isWindows ? await findDesktopData($, localAppData, await $.env.get('APPDATA')) : undefined,
  }
}

// The packaged app keeps its data in %LOCALAPPDATA%\Claude-Data\claude_<id>,
// the per-user install in %APPDATA%\Claude. A folder that holds a sign-in wins.
async function findDesktopData($: Engine, localAppData: string, appData: string | undefined) {
  const root = join(localAppData, 'Claude-Data')
  const candidates = (await listNames($, root, 'dir')).filter(name => /^claude/i.test(name)).map(name => join(root, name))
  if (appData !== undefined) {
    candidates.push(join(appData, 'Claude'))
  }
  let fallback: string | undefined
  for (const dir of candidates) {
    const config = await readJson<Record<string, unknown>>($, join(dir, 'config.json'))
    if (config === undefined) continue
    if ('lastKnownAccountUuid' in config || DESKTOP_AUTH_KEYS.some(key => key in config)) return dir
    fallback ??= dir
  }

  return fallback
}

const cliPath = (paths: Paths, id: string) => join(paths.store, 'cli', `${id}.json`)
const desktopAuthPath = (paths: Paths, id: string) => join(paths.store, 'desktop', id, 'auth.json')

async function readIndex($: Engine, paths: Paths): Promise<Index> {
  return (await readJson<Index>($, join(paths.store, 'accounts.json'))) ?? { accounts: {} }
}

async function remember($: Engine, paths: Paths, index: Index, who: Identity | undefined) {
  if (who === undefined) return
  const known = index.accounts[who.uuid] ?? {}
  const next = { email: who.email ?? known.email, orgName: who.orgName ?? known.orgName }
  if (next.email === known.email && next.orgName === known.orgName && who.uuid in index.accounts) return
  index.accounts[who.uuid] = next
  await writeJson($, join(paths.store, 'accounts.json'), index)
}

async function hostOf($: Engine): Promise<SwitcherView['host']> {
  return (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop' ? 'desktop' : 'terminal'
}

// Whose CLI login this is: the account a saved copy of the same token names,
// else the one the account server answers for it while it is fresh.
async function identifyCli($: Engine, paths: Paths, tokens: Tokens): Promise<Identity | undefined> {
  if (tokens.refreshToken !== undefined) {
    for (const name of await listNames($, join(paths.store, 'cli'), 'file')) {
      const id = name.replace(/\.json$/, '')
      if (!isAccountId(id)) continue
      const saved = await readJson<CliSnapshot>($, cliPath(paths, id))
      if (saved?.claudeAiOauth?.refreshToken === tokens.refreshToken && ACCOUNT_ID.test(id)) {
        return { uuid: id, email: saved.oauthAccount?.emailAddress as string | undefined }
      }
    }
  }
  const isFresh = tokens.accessToken !== undefined && (tokens.expiresAt ?? 0) > (await $.clock.now()) + 60_000
  if (!isFresh) return undefined
  try {
    const answer = await $.http.fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
    })
    if (!answer.ok) return undefined
    const profile = JSON.parse(answer.text)
    const uuid = profile?.account?.uuid

    return typeof uuid === 'string' && ACCOUNT_ID.test(uuid)
      ? { uuid, email: profile.account.email, orgName: profile.organization?.name }
      : undefined
  } catch {
    return undefined
  }
}

async function saveCli($: Engine, paths: Paths, id: string, tokens: Tokens, who: Identity | undefined) {
  const global = await readJson<{ oauthAccount?: Record<string, unknown> }>($, paths.globalConfig)
  const saved = await readJson<CliSnapshot>($, cliPath(paths, id))
  const oauthAccount =
    global?.oauthAccount?.accountUuid === id
      ? global.oauthAccount
      : (saved?.oauthAccount ??
        (who ? { accountUuid: id, emailAddress: who.email, organizationName: who.orgName } : undefined))
  await writeJson($, cliPath(paths, id), { claudeAiOauth: tokens, oauthAccount, savedAt: await $.clock.now() })
}

async function readCliTokens($: Engine, paths: Paths) {
  return (await readJson<{ claudeAiOauth?: Tokens }>($, paths.credentials))?.claudeAiOauth
}

// Keeps the saved copy of the CLI's live login current (a refresh replaces its
// tokens), and answers whose it is.
async function syncCli($: Engine, paths: Paths): Promise<Identity | undefined> {
  const tokens = await readCliTokens($, paths)
  if (tokens?.refreshToken === undefined && tokens?.accessToken === undefined) return undefined
  const who = await identifyCli($, paths, tokens)
  if (who === undefined) return undefined
  const saved = await readJson<CliSnapshot>($, cliPath(paths, who.uuid))
  if (saved?.claudeAiOauth?.refreshToken !== tokens.refreshToken || saved?.claudeAiOauth?.accessToken !== tokens.accessToken) {
    await saveCli($, paths, who.uuid, tokens, who)
  }

  return who
}

async function desktopCurrent($: Engine, paths: Paths): Promise<Identity | undefined> {
  if ((await hostOf($)) === 'desktop') {
    const uuid = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
    if (uuid !== undefined && ACCOUNT_ID.test(uuid)) {
      return { uuid, email: await $.env.get('CLAUDE_CODE_USER_EMAIL') }
    }
  }
  if (paths.desktopData === undefined) return undefined
  const config = await readJson<Record<string, unknown>>($, join(paths.desktopData, 'config.json'))
  const uuid = config?.lastKnownAccountUuid
  const isSignedIn = config !== undefined && DESKTOP_AUTH_KEYS.some(key => key in config)

  return isSignedIn && typeof uuid === 'string' && ACCOUNT_ID.test(uuid) ? { uuid } : undefined
}

export async function loadView($: Engine, paths: Paths): Promise<SwitcherView> {
  const index = await readIndex($, paths)
  const host = await hostOf($)
  const canSwitchCli = !paths.isMac
  const cli = canSwitchCli ? await syncCli($, paths) : undefined
  const desktop = await desktopCurrent($, paths)

  // The CLI's profile names the desktop account's organization where the two match.
  const profile = (await readJson<{ oauthAccount?: Record<string, unknown> }>($, paths.globalConfig))?.oauthAccount
  if (desktop !== undefined && profile?.accountUuid === desktop.uuid) {
    desktop.email ??= profile.emailAddress as string | undefined
    desktop.orgName = profile.organizationName as string | undefined
  }
  await remember($, paths, index, cli)
  await remember($, paths, index, desktop)

  const savedCli = new Set(
    (await listNames($, join(paths.store, 'cli'), 'file')).map(name => name.replace(/\.json$/, '')).filter(isAccountId),
  )
  const savedDesktop = new Set<string>()
  for (const id of await listNames($, join(paths.store, 'desktop'), 'dir')) {
    if (ACCOUNT_ID.test(id) && (await $.fs.exists(desktopAuthPath(paths, id)))) savedDesktop.add(id)
  }

  const ids = new Set([...Object.keys(index.accounts), ...savedCli, ...savedDesktop])
  for (const who of [cli, desktop]) if (who) ids.add(who.uuid)

  const rows: AccountRow[] = [...ids].filter(isAccountId).map(uuid => ({
    uuid,
    email: index.accounts[uuid]?.email ?? shortId(uuid),
    orgName: index.accounts[uuid]?.orgName,
    hasCli: savedCli.has(uuid) || cli?.uuid === uuid,
    hasDesktop: savedDesktop.has(uuid) || desktop?.uuid === uuid,
    isCliActive: cli?.uuid === uuid,
    isDesktopActive: desktop?.uuid === uuid,
  }))
  const rank = (row: AccountRow) => (row.isDesktopActive || row.isCliActive ? 0 : 1)
  rows.sort((a, b) => rank(a) - rank(b) || a.email.localeCompare(b.email))

  return {
    rows,
    host,
    canSwitchDesktop: paths.desktopData !== undefined,
    canSwitchCli,
    desktopEmail: desktop ? (index.accounts[desktop.uuid]?.email ?? shortId(desktop.uuid)) : undefined,
    cliEmail: cli ? (index.accounts[cli.uuid]?.email ?? shortId(cli.uuid)) : undefined,
  }
}

// Saves the CLI's live login, under its account where that can be told and
// under a placeholder otherwise, so a switch never loses or misfiles one.
export async function saveCurrentCli($: Engine, paths: Paths): Promise<string | undefined> {
  const tokens = await readCliTokens($, paths)
  if (tokens?.refreshToken === undefined && tokens?.accessToken === undefined) return undefined
  const who = await identifyCli($, paths, tokens)
  const id = who?.uuid ?? `unidentified-${await $.clock.now()}`
  await saveCli($, paths, id, tokens, who)
  await remember($, paths, await readIndex($, paths), who)

  return id
}

export async function switchCli($: Engine, paths: Paths, id: string, email: string) {
  const target = await readJson<CliSnapshot>($, cliPath(paths, id))
  if (target?.claudeAiOauth === undefined) return `No CLI login is saved for ${email}.`
  await saveCurrentCli($, paths)
  // Only the Claude login changes: the MCP servers' tokens beside it stay.
  const credentials = (await readJson<Record<string, unknown>>($, paths.credentials)) ?? {}
  await writeJson($, paths.credentials, { ...credentials, claudeAiOauth: target.claudeAiOauth })
  const global = await readJson<Record<string, unknown>>($, paths.globalConfig)
  if (global !== undefined && target.oauthAccount !== undefined) {
    await writeJson($, paths.globalConfig, { ...global, oauthAccount: target.oauthAccount })
  }

  return `The CLI is now signed in as ${email}.`
}

// Hands the desktop swap to scripts/desktop-swap.ps1, started through WMI so it
// runs outside the app's process tree and outlives the app it restarts.
export async function swapDesktop($: Engine, paths: Paths, mode: 'switch' | 'new', id?: string) {
  if (paths.desktopData === undefined) return { error: 'No Claude desktop app data was found on this computer.' }
  if (mode === 'switch' && (id === undefined || !ACCOUNT_ID.test(id))) return { error: 'That account has no saved app sign-in.' }
  const helper = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    quote(toWindows(join($.plugin.root, 'scripts', 'desktop-swap.ps1'))),
    '-DataDir',
    quote(toWindows(paths.desktopData)),
    '-StoreDir',
    quote(toWindows(paths.store)),
    '-Mode',
    mode,
    ...(id !== undefined ? ['-To', id] : []),
  ].join(' ')
  const launcher = [
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${helper.replace(/'/g, "''")}'; ProcessStartupInformation = $si }`,
    'exit [int]$r.ReturnValue',
  ].join('; ')
  const ran = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', launcher], {
    timeoutMs: 30_000,
  })

  return ran.exitCode === 0 ? {} : { error: `The app switch could not start (${ran.stderr.trim() || `exit ${ran.exitCode}`}).` }
}

export async function forget($: Engine, paths: Paths, id: string) {
  if (!isAccountId(id)) return
  const targets = [cliPath(paths, id), join(paths.store, 'desktop', id)]
  if (paths.isWindows) {
    const list = targets.map(path => `'${toWindows(path).replace(/'/g, "''")}'`).join(', ')
    await $.process.run([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `foreach ($p in @(${list})) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }`,
    ])
  } else {
    await $.process.run(['rm', '-rf', ...targets])
  }
  const index = await readIndex($, paths)
  delete index.accounts[id]
  await writeJson($, join(paths.store, 'accounts.json'), index)
}

export async function readLastSwap($: Engine, paths: Paths) {
  return readJson<LastSwap>($, join(paths.store, 'last-swap.json'))
}
