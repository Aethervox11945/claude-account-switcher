# account-switcher

> This is an improved version of [claude-account-switcher](https://github.com/Kajcsi/claude-account-switcher) by [Kajcsi](https://github.com/Kajcsi), who created the mod and the account switching behind it. It adds a Windows app and Code chat carry-over. See [Credits](#credits). The install commands below are for the original mod. **[Download the Windows app](https://github.com/Aethervox11945/claude-account-switcher/releases)** from Releases.

A Claude Code mod that keeps several Claude accounts signed in on one computer and switches between them in one click, for both the **Claude desktop app** and the **Claude Code CLI**.

- **CLI:** switches in place. A running `claude` picks up the new login without a restart.
- **Desktop app (Windows):** the app closes, the other account's sign-in is put back, and the app opens again, already signed in. It takes a few seconds and ends the sessions that are open at that moment. Your sessions are kept and can be reopened.

Before each switch, the mod saves the login you're switching away from, so switching back always works, including after a token refresh. A login the CLI refreshed while nothing was watching is still filed under its own account. The saved copy it replaces is kept in `replaced/`.

An account that belongs to more than one organization keeps one CLI login per organization. Where two rows would show the same name, the organization is added to tell them apart, e.g. `you@example.com (Work)`.

## Install

At the prompt of a terminal session:

```
/plugin install account-switcher --marketplace Kajcsi/claude-account-switcher
```

Answer `y` to add the marketplace, then choose a scope. Choose the user scope so the mod also loads in the desktop app's Code sessions.

From a shell:

```
claude plugin install account-switcher --marketplace Kajcsi/claude-account-switcher
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Kajcsi/claude-account-switcher`, then **Add plugin**.

## Use

- `/accounts` opens the Accounts pane. It lists every saved account and which one the app and the CLI are using. Each row has a **Switch** button and a **Remove** button, which asks before it removes anything.
- `/accounts <email>` switches to the account whose name, email or organization matches. Add `app` or `cli` to switch only that one, e.g. `/accounts work@company.com cli`. If more than one account matches, it lists them so you can be more specific.
- `/accounts add app` restarts the desktop app signed out so you can sign in with another account. The current one is saved first.
- `/accounts add cli` saves the current CLI login. Then run `/login` in a terminal with the other account. (While the mod is loaded, `/login` saves the login it replaces on its own.)
- `/accounts list` prints the accounts.

The status line shows which account the session is on. If the CLI is signed in to an account the mod hasn't identified yet (its token has expired and no saved copy matches), the pane and `/accounts list` say "signed in, account not recognized yet" rather than "not signed in".

## Windows app

`ClaudeAccountSwitcher.exe` does the same job in a window of its own, with no Claude Code session needed. It's one portable file: run it from anywhere, nothing else to install. It shares its saved accounts with the mod.

- **Switch** moves the app and the CLI to that account. The **⋯** menu can move just one of them, rename an account, or remove it. Removing deletes the saved logins, but copies may stay in `backups/` until newer switches replace them.
- **Add account** restarts the app signed out, or opens `claude auth login` for the CLI. The current login is saved first.
- **More > Install to this computer** is optional. It adds a Start menu entry and an Installed apps entry, without admin rights. Uninstalling keeps your saved accounts.

[Download `ClaudeAccountSwitcher.exe` from Releases](https://github.com/Aethervox11945/claude-account-switcher/releases). It isn't code signed, so Windows SmartScreen may warn you on first run: choose **More info > Run anyway**.

To build it yourself, use the .NET 10 SDK. This runs the smoke tests, then writes `dist\ClaudeAccountSwitcher.exe`:

```
powershell -ExecutionPolicy Bypass -File gui\build.ps1
```

### Chats and history

- **CLI:** nothing to do. Transcripts live in `~/.claude/projects`, which no account owns, so every account sees them.
- **Claude app Code tab:** the app lists chats per account, in `claude-code-sessions\<account>\<org>\`. The Windows app can bring them along. During a switch, while Claude is closed, it copies each `local_*.json` record into every organization of the account you switch to. A record only points at its transcript, so the conversation itself doesn't move. The newest copy of a record wins, and any record it replaces is kept in `chat-backups/`.

This is **off by default**. Turn it on under **More > Bring Code chats along when switching**, which asks first. The setting is saved in `settings.json`, and a switch from the `/accounts` mod follows it too.

Limits of bringing chats along:

- Records are copied across organizations as well as accounts, so a work organization's chats can show up under a personal account, and the other way round. Keep this off if they must stay apart.
- A copied chat carries what it saw where it ran, such as its MCP servers and its folder. Resuming it sends its transcript to the account you're on, and later messages go to that account.
- Connectors and Remote Control links saved in a chat belong to the account that started it, so they may not work from another account.
- A chat you delete after it came across stays deleted there. `chats-copied.json` remembers what was copied where.
- A newly added account gets the chats on the first switch into it after you've signed in.
- Cowork sessions and chats on claude.ai aren't copied. claude.ai chats are stored on the server per account.

> **Changed in this version:** bringing chats along used to be on by default. If you relied on that, turn it back on under **More**.

## How it works

| | Where the login lives | What a switch does |
|---|---|---|
| CLI | `~/.claude/.credentials.json` (`claudeAiOauth`) and the profile in `~/.claude.json` (`oauthAccount`) | Swaps only those two entries. MCP server tokens in the same file are left alone. If either file can't be read right now (another program holds it, or it's half written), nothing is written. |
| Desktop app | `config.json` in the app's data folder (`oauth:tokenCache`, `oauth:tokenCacheV2`, `lastKnownAccountUuid`) and its cookie store `Network\Cookies` | `scripts/desktop-swap.ps1` closes the app, saves the current sign-in, puts the target's in place and starts the app again. Both the mod and the Windows app start it through WMI, outside their own process tree, so it survives the app closing. |

Saved logins are kept in `~/.claude/account-switcher/` (or `$CLAUDE_CONFIG_DIR/account-switcher/`):

| Path | What it holds |
|---|---|
| `cli/<account>.json` | A saved CLI login. A second organization's is `cli/<account>.<organization>.json`. |
| `replaced/<account>.json` | The saved CLI login a newer one replaced, in case the newer one turns out to be wrong. |
| `desktop/<account>/` | A saved desktop app sign-in and its cookies. |
| `accounts.json`, `labels.json` | Emails and organizations seen, and names given in the Windows app. |
| `settings.json` | Windows app settings, such as bringing chats along. |
| `backups/`, `chat-backups/` | The last five of what each desktop switch replaced. |
| `swap.log`, `last-swap.json`, `swap.lock` | What the desktop helper did, how its last run ended, and the lock that keeps it to one switch at a time. |

The desktop helper checks the result before it finishes. If any step fails, or the app's `config.json` doesn't name the account it was switched to, it rolls back from the backup. If the app holds a sign-in its `config.json` names no account for, the switch stops before changing anything, since that sign-in couldn't be saved. A second switch started while one is running does nothing (exit code 3) and says so.

**Treat `~/.claude/account-switcher/` as you would `~/.claude/.credentials.json`.** It holds the same kind of tokens, stored the same way (the desktop ones stay encrypted by Windows for your user).

## Limits

- Desktop switching is Windows-only for now (both the Microsoft Store/MSIX install and the per-user install).
- On macOS the CLI keeps its login in the Keychain, which this mod doesn't switch yet.
- Signing out in the app or running `/logout` can revoke that account's tokens on the server. To add an account, use `/accounts add` instead of signing out.
- The desktop app's storage layout isn't a public interface, so an app update could change it. If a switch doesn't take, `swap.log` says why, and the previous sign-in is in `backups/`.
- The store follows `CLAUDE_CONFIG_DIR`. A session with it set and one without keep separate stores, and each sees only its own saved accounts.
- **Install to this computer** copies the exe over the installed one without checking versions, so installing an older download replaces a newer install.

## Credits

The original [claude-account-switcher](https://github.com/Kajcsi/claude-account-switcher) is by [Kajcsi](https://github.com/Kajcsi) and is released under the MIT License. The mod, the way logins are saved and swapped, and `scripts/desktop-swap.ps1` all come from that project.

Added in this version:

- The Windows app in `gui/`: a portable exe with an optional install
- Bringing Code chats along on an app switch (the `-SyncChats` option of `scripts/desktop-swap.ps1`)
- Logins for more than one organization of an account, safer reads and writes of the login files, and a lock so desktop switches don't overlap

This version keeps the original MIT License and copyright notice in [LICENSE](LICENSE).
