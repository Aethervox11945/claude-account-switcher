// One saved (or currently signed-in) account, as the pane lists it.
export type AccountRow = {
  uuid: string
  email: string
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
  desktopEmail?: string
  cliEmail?: string
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
