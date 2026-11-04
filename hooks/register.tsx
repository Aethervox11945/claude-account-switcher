import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AccountRow, SwitcherView } from '../types'
import {
  DESKTOP_AUTH_KEYS,
  PROFILE_URL,
  SWAP_TIMEOUT_MS,
  cliPath,
  desktopAuthPath,
  desktopSwapLauncher,
  fallbackName,
  hasLogin,
  identityOf,
  isAccountId,
  isCliId,
  isIdentified,
  isUnidentified,
  join,
  orgLoginId,
  removeCommand,
} from './accounts'
import type { CliSnapshot, Identity, Index, LastSwap, Paths, Profile, Tokens } from './accounts'

type Engine = EngineInterface
type Where = 'app' | 'cli'
type CliState = { isSignedIn: boolean; who?: Identity }

const PANE = 'accounts'
const view = atom({ plugin: 'account-switcher', key: 'view' } as const, null, { shape: 'view-2' })
const message = atom({ plugin: 'account-switcher', key: 'message' } as const, null)
const confirmRemove = atom({ plugin: 'account-switcher', key: 'confirmRemove' } as const, null)

// All start over on a reload, which is what they should do.
let paths: Paths | undefined
// When this session started an app switch that hasn't reported back yet.
let swapStartedAt: number | undefined

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ---- Files ----------------------------------------------------------------

async function readJson<T>($: Engine, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

// Tells a file that isn't there (nothing in it to keep) from one that can't be
// read right now (another program holds it, or it is half written), which a
// switch must not write over.
async function readJsonStrict<T>($: Engine, path: string): Promise<{ value?: T; error?: string }> {
  if (!(await $.fs.exists(path))) return {}
  try {
    return { value: JSON.parse(await $.fs.read(path)) as T }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

async function writeJson($: Engine, path: string, value: unknown) {
  await $.fs.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function listNames($: Engine, dir: string, kind: 'file' | 'dir') {
  const entries = await $.fs.list(dir).catch(() => [])

  return entries.filter(entry => entry.kind === kind).map(entry => entry.name)
}

// ---- Where things live ----------------------------------------------------

async function resolvePaths($: Engine): Promise<Paths> {
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
// the per-user install in %APPDATA%\Claude. Either can be left over from an
// earlier install, so the folder whose config.json the app wrote last wins.
async function findDesktopData($: Engine, localAppData: string, appData: string | undefined) {
  const root = join(localAppData, 'Claude-Data')
  const candidates = (await listNames($, root, 'dir')).filter(name => /^claude/i.test(name)).map(name => join(root, name))
  if (appData !== undefined) {
    candidates.push(join(appData, 'Claude'))
  }
  let newest: { dir: string; mtimeMs: number } | undefined
  for (const dir of candidates) {
    const stat = await $.fs.stat(join(dir, 'config.json')).catch(() => undefined)
    if (stat !== undefined && (newest === undefined || stat.mtimeMs > newest.mtimeMs)) newest = { dir, mtimeMs: stat.mtimeMs }
  }

  return newest?.dir
}

async function pathsOf($: Engine) {
  paths ??= await resolvePaths($)

  return paths
}

async function hostOf($: Engine): Promise<SwitcherView['host']> {
  return (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop' ? 'desktop' : 'terminal'
}

// ---- The index, and what the Windows app keeps beside it ------------------

async function readIndex($: Engine, p: Paths): Promise<Index> {
  return { accounts: { ...(await readJson<Index>($, join(p.store, 'accounts.json')))?.accounts } }
}

// The index as it stands, or undefined while it can't be read: written from
// nothing then, it would lose every other account's name.
async function readIndexToWrite($: Engine, p: Paths): Promise<Index | undefined> {
  const read = await readJsonStrict<Index>($, join(p.store, 'accounts.json'))

  return read.error === undefined ? { accounts: { ...read.value?.accounts } } : undefined
}

async function remember($: Engine, p: Paths, who: Identity | undefined) {
  if (who === undefined) return
  const index = await readIndexToWrite($, p)
  if (index === undefined) return
  const known = index.accounts[who.id] ?? {}
  const next = { email: who.email ?? known.email, orgName: who.orgName ?? known.orgName }
  if (who.id in index.accounts && next.email === known.email && next.orgName === known.orgName) return
  index.accounts[who.id] = next
  await writeJson($, join(p.store, 'accounts.json'), index)
}

// Names given to accounts in the Windows app.
async function readLabels($: Engine, p: Paths) {
  return (await readJson<Record<string, unknown>>($, join(p.store, 'labels.json'))) ?? {}
}

async function readLabelsToWrite($: Engine, p: Paths) {
  const read = await readJsonStrict<Record<string, unknown>>($, join(p.store, 'labels.json'))

  return read.error === undefined ? { ...read.value } : undefined
}

async function readSettings($: Engine, p: Paths) {
  return (await readJson<{ syncChats?: unknown }>($, join(p.store, 'settings.json'))) ?? {}
}

async function readLastSwap($: Engine, p: Paths) {
  return readJson<LastSwap>($, join(p.store, 'last-swap.json'))
}

// ---- The CLI --------------------------------------------------------------

async function savedCliIds($: Engine, p: Paths) {
  return (await listNames($, join(p.store, 'cli'), 'file'))
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -'.json'.length))
    .filter(isCliId)
}

async function readSnapshot($: Engine, p: Paths, id: string) {
  return readJson<CliSnapshot>($, cliPath(p, id))
}

async function readCliTokens($: Engine, p: Paths) {
  return (await readJson<{ claudeAiOauth?: Tokens }>($, p.credentials))?.claudeAiOauth
}

// Where a login to this organization of the account is saved: under the
// account, unless the account's saved login belongs to another organization.
async function cliIdFor($: Engine, p: Paths, uuid: string, orgUuid: string | undefined) {
  if (orgUuid === undefined) return uuid
  const second = orgLoginId(uuid, orgUuid)
  if (await $.fs.exists(cliPath(p, second))) return second
  const savedOrg = (await readSnapshot($, p, uuid))?.oauthAccount?.organizationUuid

  return savedOrg === undefined || savedOrg === orgUuid ? uuid : second
}

async function placed($: Engine, p: Paths, who: Omit<Identity, 'id'>): Promise<Identity> {
  return { ...who, id: await cliIdFor($, p, who.uuid, who.orgUuid) }
}

// Whose CLI login this is: the account a saved copy of the same token names;
// else the one the account server answers for it while it is fresh; else the
// profile the CLI wrote beside it, where this login is a newer copy of that
// account's saved one (a refresh replaced its tokens) or the first.
async function identifyCli($: Engine, p: Paths, tokens: Tokens): Promise<Identity | undefined> {
  if (tokens.refreshToken !== undefined) {
    for (const id of await savedCliIds($, p)) {
      if (!isIdentified(id)) continue
      const saved = await readSnapshot($, p, id)
      if (saved?.claudeAiOauth?.refreshToken === tokens.refreshToken) return identityOf(id, saved.oauthAccount)
    }
  }

  const isFresh = tokens.accessToken !== undefined && (tokens.expiresAt ?? 0) > (await $.clock.now()) + 60_000
  if (isFresh) {
    try {
      const answer = await $.http.fetch(PROFILE_URL, {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
      })
      if (answer.ok) {
        const profile = JSON.parse(answer.text)
        const uuid = profile?.account?.uuid
        if (isAccountId(uuid)) {
          return placed($, p, {
            uuid,
            email: profile.account.email,
            orgName: profile.organization?.name,
            orgUuid: typeof profile.organization?.uuid === 'string' ? profile.organization.uuid : undefined,
          })
        }
      }
    } catch {
      // Offline, or the server answered something else: try the profile.
    }
  }

  const profile = (await readJson<{ oauthAccount?: Profile }>($, p.globalConfig))?.oauthAccount
  if (!isAccountId(profile?.accountUuid)) return undefined
  const who = await placed($, p, identityOf(profile.accountUuid, profile))
  const saved = (await readSnapshot($, p, who.id))?.claudeAiOauth

  return saved === undefined || (tokens.expiresAt ?? 0) > (saved.expiresAt ?? 0) ? { ...who, isGuess: true } : undefined
}

// Before a guessed login replaces an account's saved one, the saved one is
// kept aside (one copy per account), in case the guess was wrong.
async function keepReplaced($: Engine, p: Paths, who: Identity, tokens: Tokens) {
  if (!who.isGuess) return
  const saved = await readSnapshot($, p, who.id)
  if (saved !== undefined && saved.claudeAiOauth?.refreshToken !== tokens.refreshToken) {
    await writeJson($, join(p.store, 'replaced', `${who.id}.json`), saved)
  }
}

async function saveCli($: Engine, p: Paths, id: string, tokens: Tokens, who: Identity | undefined) {
  const profile = (await readJson<{ oauthAccount?: Profile }>($, p.globalConfig))?.oauthAccount
  const saved = await readSnapshot($, p, id)
  const isTheirs =
    who !== undefined &&
    profile?.accountUuid === who.uuid &&
    (who.orgUuid === undefined || profile.organizationUuid === who.orgUuid)
  // A login that can't be told keeps the profile the CLI showed beside it, so
  // switching back to it puts both back as they were.
  const oauthAccount =
    who === undefined
      ? (saved?.oauthAccount ?? profile)
      : isTheirs
        ? profile
        : (saved?.oauthAccount ?? {
            accountUuid: who.uuid,
            emailAddress: who.email,
            organizationUuid: who.orgUuid,
            organizationName: who.orgName,
          })
  await writeJson($, cliPath(p, id), { claudeAiOauth: tokens, oauthAccount, savedAt: await $.clock.now() })
}

// Once a login is filed under its account, a placeholder copy of it goes.
async function dropUnidentifiedCopies($: Engine, p: Paths, refreshToken: string | undefined) {
  if (refreshToken === undefined) return
  const stale: string[] = []
  for (const id of await savedCliIds($, p)) {
    if (isUnidentified(id) && (await readSnapshot($, p, id))?.claudeAiOauth?.refreshToken === refreshToken) {
      stale.push(cliPath(p, id))
    }
  }
  if (stale.length > 0) await $.process.run(removeCommand(p, stale), { timeoutMs: 30_000 })
}

// Keeps the saved copy of the CLI's live login current (a refresh replaces its
// tokens), and answers whose it is.
async function syncCli($: Engine, p: Paths): Promise<CliState> {
  const tokens = await readCliTokens($, p)
  if (!hasLogin(tokens)) return { isSignedIn: false }
  const who = await identifyCli($, p, tokens)
  if (who === undefined) return { isSignedIn: true }
  const saved = (await readSnapshot($, p, who.id))?.claudeAiOauth
  if (saved?.refreshToken !== tokens.refreshToken || saved?.accessToken !== tokens.accessToken) {
    await keepReplaced($, p, who, tokens)
    await saveCli($, p, who.id, tokens, who)
    await dropUnidentifiedCopies($, p, tokens.refreshToken)
  }

  return { isSignedIn: true, who }
}

// Saves the CLI's live login (or the one given), under its account where that
// can be told and under a placeholder otherwise, so a switch never loses or
// misfiles one. Answers the id it was saved under.
async function saveCurrentCli($: Engine, p: Paths, given?: Tokens): Promise<string | undefined> {
  const tokens = given ?? (await readCliTokens($, p))
  if (!hasLogin(tokens)) return undefined
  const who = await identifyCli($, p, tokens)
  if (who === undefined && tokens.refreshToken !== undefined) {
    // The same unknown login needs only one placeholder.
    for (const id of await savedCliIds($, p)) {
      if (isUnidentified(id) && (await readSnapshot($, p, id))?.claudeAiOauth?.refreshToken === tokens.refreshToken) return id
    }
  }
  const id = who?.id ?? `unidentified-${await $.clock.now()}`
  if (who !== undefined) await keepReplaced($, p, who, tokens)
  await saveCli($, p, id, tokens, who)
  if (who !== undefined) {
    await remember($, p, who)
    await dropUnidentifiedCopies($, p, tokens.refreshToken)
  }

  return id
}

async function switchCli($: Engine, p: Paths, id: string, name: string): Promise<{ ok: boolean; text: string }> {
  const target = await readSnapshot($, p, id)
  if (target === undefined || !hasLogin(target.claudeAiOauth)) return { ok: false, text: `No CLI login is saved for ${name}.` }
  type Credentials = Record<string, unknown> & { claudeAiOauth?: Tokens }
  const before = await readJsonStrict<Credentials>($, p.credentials)
  if (before.error !== undefined) {
    return { ok: false, text: `The CLI was not switched: its login file could not be read (${before.error}).` }
  }
  const global = await readJsonStrict<Record<string, unknown>>($, p.globalConfig)
  if (global.error !== undefined) {
    return { ok: false, text: `The CLI was not switched: .claude.json could not be read (${global.error}).` }
  }
  await saveCurrentCli($, p, before.value?.claudeAiOauth)

  // Another session may have refreshed the login meanwhile: that one is kept too.
  const now = await readJsonStrict<Credentials>($, p.credentials)
  if (now.error !== undefined) {
    return { ok: false, text: `The CLI was not switched: its login file could not be read (${now.error}).` }
  }
  if (now.value?.claudeAiOauth?.refreshToken !== before.value?.claudeAiOauth?.refreshToken) {
    await saveCurrentCli($, p, now.value?.claudeAiOauth)
  }
  // Only the Claude login changes: the MCP servers' tokens beside it stay.
  await writeJson($, p.credentials, { ...now.value, claudeAiOauth: target.claudeAiOauth })
  // Older copies saved by the Windows app hold `null` where no profile was known.
  if (target.oauthAccount != null) {
    const latest = await readJsonStrict<Record<string, unknown>>($, p.globalConfig)
    if (latest.error !== undefined) {
      return {
        ok: true,
        text: `The CLI is now signed in as ${name}, but .claude.json could not be updated (${latest.error}), so it may show the previous account's name.`,
      }
    }
    if (latest.value !== undefined) await writeJson($, p.globalConfig, { ...latest.value, oauthAccount: target.oauthAccount })
  }

  return { ok: true, text: `The CLI is now signed in as ${name}.` }
}

// ---- The desktop app ------------------------------------------------------

async function desktopCurrent($: Engine, p: Paths): Promise<Identity | undefined> {
  if ((await hostOf($)) === 'desktop') {
    const uuid = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
    if (isAccountId(uuid)) {
      return { id: uuid, uuid, email: await $.env.get('CLAUDE_CODE_USER_EMAIL') }
    }
  }
  if (p.desktopData === undefined) return undefined
  const config = await readJson<Record<string, unknown>>($, join(p.desktopData, 'config.json'))
  const uuid = config?.lastKnownAccountUuid
  const isSignedIn = config !== undefined && DESKTOP_AUTH_KEYS.some(key => key in config)

  return isSignedIn && isAccountId(uuid) ? { id: uuid, uuid } : undefined
}

async function swapDesktop($: Engine, p: Paths, mode: 'switch' | 'new', id?: string) {
  const desktopData = p.desktopData
  if (desktopData === undefined) return { error: 'No Claude desktop app data was found on this computer.' }
  if (mode === 'switch' && !isAccountId(id)) return { error: 'That account has no saved app sign-in.' }
  // The Windows app's setting; off unless turned on there.
  const syncChats = (await readSettings($, p)).syncChats === true
  const launcher = desktopSwapLauncher($.plugin.root, { ...p, desktopData }, mode, id, syncChats)
  const ran = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', launcher], {
    timeoutMs: 30_000,
  })

  return ran.exitCode === 0 ? {} : { error: `The app switch could not start (${ran.stderr.trim() || `exit ${ran.exitCode}`}).` }
}

// ---- What the pane shows --------------------------------------------------

async function loadView($: Engine, p: Paths): Promise<SwitcherView> {
  const host = await hostOf($)
  const canSwitchCli = !p.isMac
  const cli: CliState = canSwitchCli ? await syncCli($, p) : { isSignedIn: false }
  const desktop = await desktopCurrent($, p)

  // The CLI's profile names the desktop account's email where the two match.
  const profile = (await readJson<{ oauthAccount?: Profile }>($, p.globalConfig))?.oauthAccount
  if (desktop !== undefined && profile?.accountUuid === desktop.uuid) {
    desktop.email ??= profile.emailAddress
  }
  await remember($, p, cli.who)
  await remember($, p, desktop)

  const index = await readIndex($, p)
  const labels = await readLabels($, p)
  const savedCli = new Set(await savedCliIds($, p))
  const savedDesktop = new Set<string>()
  for (const id of await listNames($, join(p.store, 'desktop'), 'dir')) {
    if (isAccountId(id) && (await $.fs.exists(desktopAuthPath(p, id)))) savedDesktop.add(id)
  }

  const ids = new Set([...Object.keys(index.accounts).filter(isIdentified), ...savedCli, ...savedDesktop])
  for (const who of [cli.who, desktop]) if (who) ids.add(who.id)

  // A placeholder goes by the profile the CLI showed when it was saved, as does
  // the organization of a login an older index never named one for.
  const saved = new Map<string, Profile | undefined>()
  for (const id of ids) {
    if (isUnidentified(id) || (savedCli.has(id) && index.accounts[id]?.orgName === undefined)) {
      saved.set(id, (await readSnapshot($, p, id))?.oauthAccount)
    }
  }
  const nameOf = (id: string) => {
    const label = labels[id]
    if (typeof label === 'string' && label.trim() !== '') return label.trim()
    const known = index.accounts[id]?.email
    if (known !== undefined) return known
    const shown = saved.get(id)?.emailAddress
    if (shown === undefined) return fallbackName(id)

    return isUnidentified(id) ? `${shown} (unverified)` : shown
  }

  const rows: AccountRow[] = [...ids].map(id => ({
    id,
    name: nameOf(id),
    email: index.accounts[id]?.email,
    orgName: index.accounts[id]?.orgName ?? saved.get(id)?.organizationName,
    hasCli: savedCli.has(id) || cli.who?.id === id,
    hasDesktop: savedDesktop.has(id) || desktop?.id === id,
    isCliActive: cli.who?.id === id,
    isDesktopActive: desktop?.id === id,
  }))
  const rank = (row: AccountRow) => (row.isDesktopActive || row.isCliActive ? 0 : 1)
  rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || (a.orgName ?? '').localeCompare(b.orgName ?? ''))

  return {
    rows,
    host,
    canSwitchDesktop: p.desktopData !== undefined,
    canSwitchCli,
    desktopName: desktop ? nameOf(desktop.id) : undefined,
    cliName: cli.who ? nameOf(cli.who.id) : undefined,
    isCliSignedIn: cli.isSignedIn,
  }
}

async function forget($: Engine, p: Paths, id: string): Promise<string | undefined> {
  if (!isCliId(id)) return 'That is not a saved account.'
  const targets = [cliPath(p, id), join(p.store, 'replaced', `${id}.json`), ...(isAccountId(id) ? [join(p.store, 'desktop', id)] : [])]
  const ran = await $.process.run(removeCommand(p, targets), { timeoutMs: 30_000 })
  if (ran.exitCode !== 0) return `Its saved login could not be removed (${ran.stderr.trim() || `exit ${ran.exitCode}`}).`
  const index = await readIndexToWrite($, p)
  const labels = await readLabelsToWrite($, p)
  if (index !== undefined && id in index.accounts) {
    delete index.accounts[id]
    await writeJson($, join(p.store, 'accounts.json'), index)
  }
  if (labels !== undefined && id in labels) {
    delete labels[id]
    await writeJson($, join(p.store, 'labels.json'), labels)
  }
  if (index === undefined || labels === undefined) {
    return 'Its saved login was removed, but the list of accounts could not be read to take it off. Try again shortly.'
  }

  return undefined
}

// ---- Commands and buttons -------------------------------------------------

const stateOf = (has: boolean, isActive: boolean) => (isActive ? 'in use' : has ? 'saved' : '—')

const canSwitchApp = (v: SwitcherView, row: AccountRow) => v.canSwitchDesktop && row.hasDesktop && !row.isDesktopActive
const canSwitchCli = (v: SwitcherView, row: AccountRow) => v.canSwitchCli && row.hasCli && !row.isCliActive

// A row's name, with its organization where another row has the same name.
function titleOf(v: SwitcherView, row: AccountRow) {
  const isTwin = v.rows.some(other => other.id !== row.id && other.name === row.name)

  return isTwin && row.orgName ? `${row.name} (${row.orgName})` : row.name
}

function cliNow(v: SwitcherView) {
  if (!v.canSwitchCli) return 'not switchable on macOS yet'

  return v.cliName ?? (v.isCliSignedIn ? 'signed in, account not recognized yet' : 'not signed in')
}

function describe(v: SwitcherView) {
  const lines = v.rows.map(
    row => `- ${titleOf(v, row)}: app ${stateOf(row.hasDesktop, row.isDesktopActive)}, CLI ${stateOf(row.hasCli, row.isCliActive)}`,
  )
  if (v.isCliSignedIn && v.cliName === undefined) {
    lines.push(`- The CLI is ${cliNow(v)}; it is saved before any switch.`)
  }

  return [
    v.rows.length === 0 ? 'No accounts saved yet.' : 'Accounts:',
    ...lines,
    'Switch with /accounts <email>, add one with /accounts add [app|cli].',
  ].join('\n')
}

function nothingToSwitch(v: SwitcherView, row: AccountRow, name: string, only: Where | undefined) {
  if (only === 'app') {
    if (!v.canSwitchDesktop) return 'No Claude desktop app was found on this computer.'
    return row.isDesktopActive ? `The app already uses ${name}.` : `${name} has no saved app sign-in yet.`
  }
  if (only === 'cli') {
    if (!v.canSwitchCli) return 'On macOS the CLI keeps its login in the Keychain, which this mod does not switch yet.'
    return row.isCliActive ? `The CLI already uses ${name}.` : `${name} has no saved CLI login yet.`
  }

  return row.isDesktopActive || row.isCliActive ? `Already using ${name}.` : `${name} has no saved app or CLI login yet.`
}

async function refresh($: Engine) {
  const next = await loadView($, await pathsOf($))
  await update($, view, () => next)
  const name = next.host === 'desktop' ? next.desktopName : next.cliName
  $.ui.status(name === undefined ? undefined : `${next.host === 'desktop' ? 'App' : 'CLI'}: ${name}`)

  return next
}

async function refreshQuietly($: Engine) {
  await refresh($).catch(() => undefined)
}

async function say($: Engine, text: string | null) {
  await update($, message, () => text)
}

async function startAppSwap($: Engine, mode: 'switch' | 'new', id?: string) {
  const startedAt = await $.clock.now()
  if (swapStartedAt !== undefined && startedAt - swapStartedAt < SWAP_TIMEOUT_MS) return 'An app switch is already under way.'
  swapStartedAt = startedAt
  const started = await swapDesktop($, await pathsOf($), mode, id)
  if (started.error !== undefined) {
    swapStartedAt = undefined
    return started.error
  }
  // A terminal session outlives the app it restarts, so it waits to say how it went.
  $.clock.after(3_000, () => void watchSwap($, startedAt))

  return undefined
}

async function watchSwap($: Engine, startedAt: number) {
  if (swapStartedAt !== startedAt) return
  const last = await readLastSwap($, await pathsOf($))
  if (last !== undefined && last.at >= startedAt) {
    swapStartedAt = undefined
    await announceLastSwap($, await refresh($))
    return
  }
  if ((await $.clock.now()) - startedAt >= SWAP_TIMEOUT_MS) {
    swapStartedAt = undefined
    $.ui.toast(`The app switch did not report back. ${join((await pathsOf($)).store, 'swap.log')} says how far it got.`)
    return
  }
  $.clock.after(3_000, () => void watchSwap($, startedAt))
}

function swapOutcome(v: SwitcherView, last: LastSwap) {
  if (!last.ok) return `The app switch did not happen: ${last.error ?? 'unknown error'}`
  const target = v.rows.find(row => row.id === last.to)
  const targetName = target === undefined ? 'the other account' : titleOf(v, target)
  const current = v.rows.find(row => row.isDesktopActive)
  if (last.mode === 'new') {
    return current !== undefined && current.id !== last.from
      ? `Added ${titleOf(v, current)}.`
      : 'The app was signed out so you can add an account. Sign in with the other one.'
  }
  if (current !== undefined && current.id !== last.to) {
    return `The app was switched to ${targetName}, but is signed in as ${titleOf(v, current)}.`
  }
  const chats = last.chats ? ` ${last.chats === 1 ? '1 chat' : `${last.chats} chats`} came along.` : ''

  return `Switched the app to ${targetName}.${chats}`
}

// Says how the last app switch went, once.
async function announceLastSwap($: Engine, v: SwitcherView) {
  const last = await readLastSwap($, await pathsOf($))
  if (last === undefined || (await $.store.get('lastSwapSeen')) === last.at) return
  await $.store.set('lastSwapSeen', last.at)
  $.ui.toast(swapOutcome(v, last))
}

async function switchTo($: Engine, id: string, only?: Where) {
  const v = await refresh($)
  const row = v.rows.find(one => one.id === id)
  if (row === undefined) return 'That account is not saved.'
  const name = titleOf(v, row)
  const movesCli = only !== 'app' && canSwitchCli(v, row)
  const movesApp = only !== 'cli' && canSwitchApp(v, row)
  if (!movesCli && !movesApp) return nothingToSwitch(v, row, name, only)
  const said: string[] = []
  // The CLI first: it switches in place, while the app switch restarts the app.
  if (movesCli) {
    const cli = await switchCli($, await pathsOf($), id, name)
    said.push(cli.text)
    if (!cli.ok && movesApp) {
      await refresh($)
      return `${cli.text} The app was left as it is.`
    }
  }
  if (movesApp) said.push((await startAppSwap($, 'switch', id)) ?? `Restarting the app as ${name}…`)
  await refresh($)

  return said.join(' ')
}

async function addAccount($: Engine, where: Where) {
  const v = await refresh($)
  if (where === 'app') {
    if (!v.canSwitchDesktop) return 'No Claude desktop app was found to add an account to (Windows only for now).'
    return (
      (await startAppSwap($, 'new')) ??
      'Restarting the app signed out. Sign in with the other account; the current one is saved and stays listed here.'
    )
  }
  if (!v.canSwitchCli) return 'On macOS the CLI keeps its login in the Keychain, which this mod does not switch yet.'
  const saved = await saveCurrentCli($, await pathsOf($))
  await refresh($)
  const kept = saved === undefined ? '' : 'Your current CLI login is saved. '

  return v.host === 'terminal'
    ? `${kept}Now run /login and sign in with the other account.`
    : `${kept}Now run claude in a terminal and sign in with the other account through /login; it then shows up here.`
}

async function removeAccount($: Engine, row: AccountRow) {
  const problem = await forget($, await pathsOf($), row.id)
  await refresh($)

  return problem ?? `Removed ${row.name}.`
}

async function runCommand($: Engine, args: string) {
  const [first, second] = args.trim().split(/\s+/).filter(Boolean)
  const where = second === 'app' || second === 'cli' ? second : undefined
  const v = await refresh($)
  if (first === undefined || first === 'list') return describe(v)
  if (first === 'add') return addAccount($, where ?? (v.host === 'desktop' && v.canSwitchDesktop ? 'app' : 'cli'))
  const query = first.toLowerCase()
  const exact = v.rows.filter(row => row.name.toLowerCase() === query || row.email?.toLowerCase() === query)
  const matches =
    exact.length > 0
      ? exact
      : v.rows.filter(
          row => [row.name, row.email, row.orgName].some(text => text?.toLowerCase().includes(query)) || row.id.startsWith(query),
        )
  if (matches.length === 0) return `No saved account matches "${first}".\n${describe(v)}`
  if (matches.length > 1) {
    return `"${first}" matches ${matches.map(row => titleOf(v, row)).join(', ')}. Use more of the name, or the organization's.`
  }

  return switchTo($, matches[0]!.id, where)
}

async function act($: Engine, work: () => Promise<string | null>) {
  await say($, 'Working…')
  try {
    await say($, await work())
  } catch (error) {
    await say($, `Something went wrong: ${messageOf(error)}`)
  }
}

async function pressRemove($: Engine, row: AccountRow) {
  if ((await read($, confirmRemove)) !== row.id) {
    await update($, confirmRemove, () => row.id)
    return
  }
  await update($, confirmRemove, () => null)
  await act($, () => removeAccount($, row))
}

async function saveBeforeLogin($: Engine) {
  const p = await pathsOf($)
  if (!p.isMac) await saveCurrentCli($, p)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'accounts',
      description: 'Switch between your saved Claude accounts, for the desktop app and the CLI',
      argumentHint: '[email | add [app|cli] | list] [app|cli]',
    })
    await announceLastSwap($, await refresh($))
    // A refresh saves the CLI's newest tokens, so switching back always works.
    $.clock.every(5 * 60_000, () => void refreshQuietly($))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'accounts' }, async ($, e) => {
    if (e.args.trim() === '') await $.ui.open({ id: PANE, title: 'Accounts', focus: true })

    return { text: await runCommand($, e.args) }
  })

  // /login replaces the CLI's login, so the one it replaces is saved first.
  on('command.run', { command: 'login' }, async ($, e, next) => {
    await saveBeforeLogin($)
    const ran = await next(e)
    void refreshQuietly($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const note = await read($, message)
    const removing = await read($, confirmRemove)

    if (v === null) return <Text dimColor>Reading your accounts…</Text>

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>App: {v.canSwitchDesktop ? (v.desktopName ?? 'signed out') : 'not found on this computer'}</Text>
          <Text dimColor>CLI: {cliNow(v)}</Text>
        </Box>
        {v.rows.length === 0 && <Text dimColor>No accounts yet.</Text>}
        {v.rows.map(row => {
          const isActive = row.isDesktopActive || row.isCliActive
          const movesApp = canSwitchApp(v, row)
          const canSwitch = movesApp || canSwitchCli(v, row)
          const facts = [
            row.email !== row.name ? row.email : undefined,
            row.orgName,
            `app ${stateOf(row.hasDesktop, row.isDesktopActive)}`,
            `CLI ${stateOf(row.hasCli, row.isCliActive)}`,
          ]

          return (
            <Box key={row.id} flexDirection="column">
              <Text bold={isActive}>{row.name}</Text>
              <Text dimColor>{facts.filter(Boolean).join(' · ')}</Text>
              {(canSwitch || !isActive) && (
                <Box flexDirection="row" flexWrap="wrap" gap={1}>
                  {canSwitch && (
                    <Button
                      key={`switch-${row.id}`}
                      variant="primary"
                      label={movesApp ? 'Switch (restarts app)' : 'Switch'}
                      onPress={() => act($, () => switchTo($, row.id))}
                    />
                  )}
                  {!isActive && (
                    <Button
                      key={`remove-${row.id}`}
                      dimColor
                      label={removing === row.id ? 'Confirm remove' : 'Remove'}
                      onPress={() => pressRemove($, row)}
                    />
                  )}
                </Box>
              )}
            </Box>
          )
        })}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {v.canSwitchDesktop && (
            <Button key="add-app" label="Add account to app" onPress={() => act($, () => addAccount($, 'app'))} />
          )}
          {v.canSwitchCli && <Button key="add-cli" label="Add CLI login" onPress={() => act($, () => addAccount($, 'cli'))} />}
          <Button key="refresh" dimColor label="Refresh" onPress={() => act($, async () => (await refresh($), null))} />
        </Box>
        {note !== null && <Text>{note}</Text>}
        <Text dimColor>The app restarts to switch; the CLI switches in place.</Text>
      </Box>
    )
  })
}
