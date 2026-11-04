// The parts of the switcher that need no engine: the store's layout, account
// ids, names and the helper's command lines. Everything that takes `$` lives
// in register.tsx, since the engine follows `$` only into functions of the
// hooks module's own file.

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

export type Tokens = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
}

// The CLI's `oauthAccount` in `.claude.json`.
export type Profile = {
  accountUuid?: string
  emailAddress?: string
  organizationUuid?: string
  organizationName?: string
  [key: string]: unknown
}

export type CliSnapshot = {
  claudeAiOauth: Tokens
  oauthAccount?: Profile
  savedAt: number
}

// Whose login it is: `uuid` is the account, `id` the key of its saved copy.
// `isGuess` where only the profile the CLI wrote beside the login names it.
export type Identity = { id: string; uuid: string; email?: string; orgName?: string; orgUuid?: string; isGuess?: boolean }

export type Index = { accounts: Record<string, { email?: string; orgName?: string }> }

export type LastSwap = {
  ok: boolean
  mode: 'switch' | 'new'
  from?: string | null
  to?: string
  at: number
  error?: string | null
  chats?: number
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ACCOUNT_ID = new RegExp(`^${UUID}$`, 'i')
// One account can belong to several organizations, and a CLI login belongs to
// one of them: a second organization's login is saved as `<account>.<org>`.
const ORG_LOGIN_ID = new RegExp(`^${UUID}\\.${UUID}$`, 'i')
// A CLI login saved while its account could not be told (offline, token expired).
const UNIDENTIFIED = /^unidentified-(\d+)$/

export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
export const DESKTOP_AUTH_KEYS = ['oauth:tokenCache', 'oauth:tokenCacheV2']
// How long an app switch may take before the mod stops waiting for its result.
export const SWAP_TIMEOUT_MS = 120_000

export const isAccountId = (id: unknown): id is string => typeof id === 'string' && ACCOUNT_ID.test(id)
export const isUnidentified = (id: string) => UNIDENTIFIED.test(id)
export const isIdentified = (id: string) => ACCOUNT_ID.test(id) || ORG_LOGIN_ID.test(id)
export const isCliId = (id: string) => isIdentified(id) || isUnidentified(id)
export const accountOf = (id: string) => id.split('.')[0]!
export const orgLoginId = (uuid: string, orgUuid: string) => `${uuid}.${orgUuid}`

export const hasLogin = (tokens: Tokens | undefined): tokens is Tokens =>
  tokens?.refreshToken !== undefined || tokens?.accessToken !== undefined

export function identityOf(id: string, profile: Profile | undefined): Identity {
  return {
    id,
    uuid: accountOf(id),
    email: profile?.emailAddress,
    orgName: profile?.organizationName,
    orgUuid: profile?.organizationUuid,
  }
}

// What a row is called when nobody named it and its email is unknown.
export function fallbackName(id: string) {
  const unidentified = UNIDENTIFIED.exec(id)
  if (unidentified === null) return `Account ${id.slice(0, 8)}`
  const at = new Date(Number(unidentified[1]))

  return Number.isNaN(at.getTime())
    ? 'Unidentified CLI login'
    : `Unidentified CLI login (saved ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC)`
}

export const join = (...parts: string[]) =>
  parts
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/')

export const cliPath = (paths: Paths, id: string) => join(paths.store, 'cli', `${id}.json`)
export const desktopAuthPath = (paths: Paths, id: string) => join(paths.store, 'desktop', id, 'auth.json')

const toWindows = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '')

const quote = (arg: string) => `"${arg}"`

const literal = (text: string) => `'${text.replace(/'/g, "''")}'`

// A PowerShell line that starts scripts/desktop-swap.ps1 through WMI, so the
// helper runs outside the app's process tree and outlives the app it restarts.
export function desktopSwapLauncher(
  root: string,
  paths: Paths & { desktopData: string },
  mode: 'switch' | 'new',
  id: string | undefined,
  syncChats: boolean,
) {
  const helper = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    quote(toWindows(join(root, 'scripts', 'desktop-swap.ps1'))),
    '-DataDir',
    quote(toWindows(paths.desktopData)),
    '-StoreDir',
    quote(toWindows(paths.store)),
    '-Mode',
    mode,
    ...(id !== undefined ? ['-To', id] : []),
    ...(syncChats ? ['-SyncChats'] : []),
  ].join(' ')

  return [
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${literal(helper)}; ProcessStartupInformation = $si }`,
    'exit [int]$r.ReturnValue',
  ].join('; ')
}

// The command that deletes these files and folders; `$.fs` has no delete.
export function removeCommand(paths: Paths, targets: string[]) {
  if (!paths.isWindows) return ['rm', '-rf', ...targets]
  const list = targets.map(path => literal(toWindows(path))).join(', ')

  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ErrorActionPreference = 'Stop'; foreach ($p in @(${list})) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force } }`,
  ]
}
