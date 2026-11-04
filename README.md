# account-switcher

> This is an improved version of [claude-account-switcher](https://github.com/Kajcsi/claude-account-switcher) by [Kajcsi](https://github.com/Kajcsi), who created the mod and the account switching behind it. It adds a Windows app and Code chat carry-over. See [Credits](#credits). The install commands below are for the original mod; the Windows app is built from this repo, as described under [Windows app](#windows-app).

A Claude Code mod that keeps several Claude accounts signed in on one computer and switches between them in one click, for both the **Claude desktop app** and the **Claude Code CLI**.

- **CLI:** switches in place. A running `claude` picks up the new login without a restart.
- **Desktop app (Windows):** the app closes, the other account's sign-in is put back, and the app opens again, already signed in. It takes a few seconds and ends the sessions that are open at that moment. Your sessions are kept and can be reopened.

Before each switch, the mod saves the login you're switching away from, so switching back always works, including after a token refresh.

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

- `/accounts` opens the Accounts pane. It lists every saved account, which one the app and the CLI are using, and a **Switch** button on each row.
- `/accounts <email>` switches to the account whose email (or organization) matches. Add `app` or `cli` to switch only that one, e.g. `/accounts work@company.com cli`.
- `/accounts add app` restarts the desktop app signed out so you can sign in with another account. The current one is saved first.
- `/accounts add cli` saves the current CLI login. Then run `/login` in a terminal with the other account. (While the mod is loaded, `/login` saves the login it replaces on its own.)
- `/accounts list` prints the accounts.

The status line shows which account the session is on.

## Windows app

`ClaudeAccountSwitcher.exe` does the same job in a window of its own, with no Claude Code session needed. It's one portable file: run it from anywhere, nothing else to install. It shares its saved accounts with the mod.

- **Switch** moves the app and the CLI to that account. The **⋯** menu can move just one of them, rename an account, or remove it.
- **Add account** restarts the app signed out, or opens `claude auth login` for the CLI. The current login is saved first.
- **More > Install to this computer** is optional. It adds a Start menu entry and an Installed apps entry, without admin rights. Uninstalling keeps your saved accounts.

Build it with the .NET 10 SDK. This runs the smoke tests, then writes `dist\ClaudeAccountSwitcher.exe`:

```
powershell -ExecutionPolicy Bypass -File gui\build.ps1
```

### Chats and history

- **CLI:** nothing to do. Transcripts live in `~/.claude/projects`, which no account owns, so every account sees them.
- **Claude app Code tab:** the app lists chats per account, in `claude-code-sessions\<account>\<org>\`. The Windows app brings them along: during a switch, while Claude is closed, it copies each `local_*.json` record into the target account. A record only points at its transcript, so the conversation itself doesn't move. The newest copy of a record wins, and any record it replaces is kept in `chat-backups/`. Turn this off under **More > Bring Code chats along when switching**. The `/accounts` mod doesn't do this.

Limits of bringing chats along:

- A copied chat continues on the account you're signed in to, and later messages go to that account. Keep this off if work and personal chats must stay apart.
- Connectors and Remote Control links saved in a chat belong to the account that started it, so they may not work from another account.
- A chat deleted under one account comes back on the next switch if another account still has a copy.
- A newly added account gets the chats on the first switch into it after you've signed in.
- Cowork sessions and chats on claude.ai aren't copied. claude.ai chats are stored on the server per account.

## How it works

| | Where the login lives | What a switch does |
|---|---|---|
| CLI | `~/.claude/.credentials.json` (`claudeAiOauth`) and the profile in `~/.claude.json` (`oauthAccount`) | Swaps only those two entries. MCP server tokens in the same file are left alone. |
| Desktop app | `config.json` in the app's data folder (`oauth:tokenCache`, `oauth:tokenCacheV2`, `lastKnownAccountUuid`) and its cookie store `Network\Cookies` | `scripts/desktop-swap.ps1` closes the app, saves the current sign-in, puts the target's in place and starts the app again. It runs outside the app's process tree, so it survives the app closing. |

Saved logins are kept in `~/.claude/account-switcher/` (or `$CLAUDE_CONFIG_DIR/account-switcher/`). The desktop helper keeps the last five backups of what it replaced in `backups/` and writes a log to `swap.log`. If any step fails, it rolls back from the backup.

**Treat `~/.claude/account-switcher/` as you would `~/.claude/.credentials.json`.** It holds the same kind of tokens, stored the same way (the desktop ones stay encrypted by Windows for your user).

## Limits

- Desktop switching is Windows-only for now (both the Microsoft Store/MSIX install and the per-user install).
- On macOS the CLI keeps its login in the Keychain, which this mod doesn't switch yet.
- Signing out in the app or running `/logout` can revoke that account's tokens on the server. To add an account, use `/accounts add` instead of signing out.
- The desktop app's storage layout isn't a public interface, so an app update could change it. If a switch doesn't take, `swap.log` says why, and the previous sign-in is in `backups/`.

## Credits

The original [claude-account-switcher](https://github.com/Kajcsi/claude-account-switcher) is by [Kajcsi](https://github.com/Kajcsi) and is released under the MIT License. The mod, the way logins are saved and swapped, and `scripts/desktop-swap.ps1` all come from that project.

Added in this version:

- The Windows app in `gui/`: a portable exe with an optional install
- Bringing Code chats along on an app switch (the `-SyncChats` option of `scripts/desktop-swap.ps1`)

This version keeps the original MIT License and copyright notice in [LICENSE](LICENSE).
