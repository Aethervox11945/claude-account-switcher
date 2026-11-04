import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AccountRow, SwitcherView } from '../types'
import { forget, loadView, readLastSwap, resolvePaths, saveCurrentCli, swapDesktop, switchCli } from './accounts'
import type { Paths } from './accounts'

type Engine = EngineInterface
type Where = 'app' | 'cli'

const PANE = 'accounts'
const view = atom({ plugin: 'account-switcher', key: 'view' } as const, null, { shape: 'view-1' })
const message = atom({ plugin: 'account-switcher', key: 'message' } as const, null)
const confirmRemove = atom({ plugin: 'account-switcher', key: 'confirmRemove' } as const, null)

// Both start over on a reload, which is what they should do.
let paths: Paths | undefined
let isSwapping = false

const stateOf = (has: boolean, isActive: boolean) => (isActive ? 'in use' : has ? 'saved' : '—')

const canSwitchApp = (v: SwitcherView, row: AccountRow) => v.canSwitchDesktop && row.hasDesktop && !row.isDesktopActive
const canSwitchCli = (v: SwitcherView, row: AccountRow) => v.canSwitchCli && row.hasCli && !row.isCliActive

function describe(v: SwitcherView) {
  const lines = v.rows.map(
    row => `- ${row.email}: app ${stateOf(row.hasDesktop, row.isDesktopActive)}, CLI ${stateOf(row.hasCli, row.isCliActive)}`,
  )

  return [
    v.rows.length === 0 ? 'No accounts saved yet.' : 'Accounts:',
    ...lines,
    'Switch with /accounts <email>, add one with /accounts add [app|cli].',
  ].join('\n')
}

async function pathsOf($: Engine) {
  paths ??= await resolvePaths($)

  return paths
}

async function refresh($: Engine) {
  const next = await loadView($, await pathsOf($))
  await update($, view, () => next)
  const email = next.host === 'desktop' ? next.desktopEmail : next.cliEmail
  $.ui.status(email === undefined ? undefined : `${next.host === 'desktop' ? 'App' : 'CLI'}: ${email}`)

  return next
}

async function say($: Engine, text: string | null) {
  await update($, message, () => text)
}

async function startAppSwap($: Engine, mode: 'switch' | 'new', id?: string) {
  if (isSwapping) return 'An app switch is already under way.'
  const started = await swapDesktop($, await pathsOf($), mode, id)
  if (started.error !== undefined) return started.error
  isSwapping = true

  return undefined
}

async function switchTo($: Engine, id: string, only?: Where) {
  const v = await refresh($)
  const row = v.rows.find(one => one.uuid === id)
  if (row === undefined) return 'That account is not saved.'
  const movesCli = only !== 'app' && canSwitchCli(v, row)
  const movesApp = only !== 'cli' && canSwitchApp(v, row)
  if (!movesCli && !movesApp) {
    return row.isCliActive || row.isDesktopActive
      ? `Already using ${row.email}.`
      : `${row.email} has no saved ${only ?? 'app or CLI'} login yet.`
  }
  const said: string[] = []
  // The CLI first: it switches in place, while the app switch restarts the app.
  if (movesCli) said.push(await switchCli($, await pathsOf($), id, row.email))
  if (movesApp) said.push((await startAppSwap($, 'switch', id)) ?? `Restarting the app as ${row.email}…`)
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
  await forget($, await pathsOf($), row.uuid)
  await refresh($)

  return `Removed ${row.email}.`
}

// Says how the last app switch went, once, in the first session after it.
async function announceLastSwap($: Engine, v: SwitcherView) {
  const last = await readLastSwap($, await pathsOf($))
  if (last === undefined || (await $.store.get('lastSwapSeen')) === last.at) return
  await $.store.set('lastSwapSeen', last.at)
  const target = v.rows.find(row => row.uuid === last.to)?.email ?? 'the other account'
  const current = v.rows.find(row => row.isDesktopActive)
  if (!last.ok) {
    $.ui.toast(`The app switch did not happen: ${last.error ?? 'unknown error'}`)
  } else if (last.mode === 'new') {
    $.ui.toast(
      current !== undefined && current.uuid !== last.from ? `Added ${current.email}.` : 'The app was signed out so you can add an account.',
    )
  } else if (v.host === 'desktop' && current !== undefined && current.uuid !== last.to) {
    $.ui.toast(`The app was switched to ${target}, but is signed in as ${current.email}.`)
  } else {
    $.ui.toast(`Switched the app to ${target}.`)
  }
}

async function runCommand($: Engine, args: string) {
  const [first, second] = args.trim().split(/\s+/).filter(Boolean)
  const where = second === 'app' || second === 'cli' ? second : undefined
  const v = await refresh($)
  if (first === undefined || first === 'list') return describe(v)
  if (first === 'add') return addAccount($, where ?? (v.host === 'desktop' && v.canSwitchDesktop ? 'app' : 'cli'))
  const query = first.toLowerCase()
  const exact = v.rows.filter(row => row.email.toLowerCase() === query)
  const matches =
    exact.length > 0
      ? exact
      : v.rows.filter(
          row => row.email.toLowerCase().includes(query) || row.orgName?.toLowerCase().includes(query) || row.uuid.startsWith(query),
        )
  if (matches.length === 0) return `No saved account matches "${first}".\n${describe(v)}`
  if (matches.length > 1) return `"${first}" matches ${matches.map(row => row.email).join(', ')}. Be more specific.`

  return switchTo($, matches[0]!.uuid, where)
}

async function act($: Engine, work: () => Promise<string | null>) {
  await say($, 'Working…')
  try {
    await say($, await work())
  } catch (error) {
    await say($, `Something went wrong: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function pressRemove($: Engine, row: AccountRow) {
  if ((await read($, confirmRemove)) !== row.uuid) {
    await update($, confirmRemove, () => row.uuid)
    return
  }
  await update($, confirmRemove, () => null)
  await act($, () => removeAccount($, row))
}

async function saveBeforeLogin($: Engine) {
  const p = await pathsOf($)
  if (!p.isMac) await saveCurrentCli($, p)
}

async function refreshQuietly($: Engine) {
  await refresh($).catch(() => undefined)
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
          <Text dimColor>App: {v.canSwitchDesktop ? (v.desktopEmail ?? 'signed out') : 'not found on this computer'}</Text>
          <Text dimColor>CLI: {v.canSwitchCli ? (v.cliEmail ?? 'not signed in') : 'not switchable on macOS yet'}</Text>
        </Box>
        {v.rows.length === 0 && <Text dimColor>No accounts yet.</Text>}
        {v.rows.map(row => {
          const isActive = row.isDesktopActive || row.isCliActive
          const movesApp = canSwitchApp(v, row)
          const canSwitch = movesApp || canSwitchCli(v, row)
          const facts = [row.orgName, `app ${stateOf(row.hasDesktop, row.isDesktopActive)}`, `CLI ${stateOf(row.hasCli, row.isCliActive)}`]

          return (
            <Box key={row.uuid} flexDirection="column">
              <Text bold={isActive}>{row.email}</Text>
              <Text dimColor>{facts.filter(Boolean).join(' · ')}</Text>
              {(canSwitch || !isActive) && (
                <Box flexDirection="row" flexWrap="wrap" gap={1}>
                  {canSwitch && (
                    <Button
                      key={`switch-${row.uuid}`}
                      variant="primary"
                      label={movesApp ? 'Switch (restarts app)' : 'Switch'}
                      onPress={() => act($, () => switchTo($, row.uuid))}
                    />
                  )}
                  {!isActive && (
                    <Button
                      key={`remove-${row.uuid}`}
                      dimColor
                      label={removing === row.uuid ? 'Confirm remove' : 'Remove'}
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
