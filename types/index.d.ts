// One saved (or currently signed-in) login, as the pane lists it.
export type AccountRow = {
  // The account's id, or `<account id>.<organization id>` for a CLI login to
  // a second organization of the same account, or `unidentified-<time>`.
  id: string
  // What the row is called: a name given in the Windows app, else the email.
  name: string
  email?: string
  orgName?: string
  // A login the switcher can restore, or the one signed in right now.
  hasCli: boolean
  hasDesktop: boolean
  isCliActive: boolean
  isDesktopActive: boolean
}

export type SwitcherView = {
  rows: AccountRow[]
  // Whether this session is hosted by the desktop app or runs in a terminal.
  host: 'desktop' | 'terminal'
  canSwitchDesktop: boolean
  canSwitchCli: boolean
  desktopName?: string
  cliName?: string
  // The CLI holds a login, even where its account can't be told.
  isCliSignedIn: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'account-switcher': {
      view: Shaped<SwitcherView | null>
      message: string | null
      confirmRemove: string | null
    }
  }
}
