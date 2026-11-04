using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using AccountSwitcher.Core;

namespace AccountSwitcher;

// One card in the list. A class, not a record: a rebuilt card that compared equal
// to the old one would keep its stale accessibility node, hiding its buttons.
public sealed class RowView(AccountRow row, bool movesApp, bool movesCli)
{
    public AccountRow Row { get; } = row;
    public bool MovesApp { get; } = movesApp;
    public bool MovesCli { get; } = movesCli;
    public string Name => Row.Title;

    // What a screen reader announces for the card.
    public override string ToString() => Row.Title;

    public string Initial => char.ToUpperInvariant(Row.Name.TrimStart().FirstOrDefault('?')).ToString();

    public string Subtitle
    {
        get
        {
            var parts = new[] { Row.Email == Row.Name ? null : Row.Email, Row.OrgName }.Where(p => !string.IsNullOrEmpty(p));
            var text = string.Join(" · ", parts);

            return text == "" && Row.Name.StartsWith("Account ", StringComparison.Ordinal)
                ? "Email unknown. Rename it from the ⋯ menu."
                : text;
        }
    }

    public bool HasSubtitle => Subtitle != "";
    public bool AppActive => Row.IsDesktopActive;
    public bool AppSaved => Row.HasDesktop && !Row.IsDesktopActive;
    public bool CliActive => Row.IsCliActive;
    public bool CliSaved => Row.HasCli && !Row.IsCliActive;
    public bool CanSwitch => MovesApp || MovesCli;
    public bool CanRemove => !Row.IsDesktopActive && !Row.IsCliActive;
    public string SwitchLabel => MovesApp && MovesCli ? "Switch" : MovesApp ? "Switch app" : "Switch CLI";

    public string SwitchHint =>
        MovesApp && MovesCli ? "Switches the CLI and restarts the Claude app"
        : MovesApp ? "Restarts the Claude app"
        : "Switches the CLI in place";
}

public partial class MainWindow : Window
{
    private readonly AccountStore _store = new(AccountStore.ResolvePaths());
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(15) };
    private SwitcherView? _view;
    private bool _isBusy;
    private bool _isRefreshing;

    public MainWindow()
    {
        InitializeComponent();
        _timer.Tick += async (_, _) => await Reload();
        _timer.Start();
        Loaded += async (_, _) => await Reload();
        // Signing in happens in other windows, so look again on coming back.
        Activated += async (_, _) => await Reload();
    }

    // ---- Showing the accounts ---------------------------------------------

    private async Task Reload()
    {
        if (_isBusy || _isRefreshing) return;
        _isRefreshing = true;
        try
        {
            // Off the window's thread: .claude.json can be several megabytes.
            Show(await Task.Run(_store.LoadView));
        }
        catch (Exception e)
        {
            // Said in the window, not a dialog: closing one would look again and fail again.
            Say($"Could not read your accounts: {e.Message}");
        }
        finally
        {
            _isRefreshing = false;
        }
    }

    private void Show(SwitcherView view)
    {
        AppNow.Text = !view.CanSwitchDesktop ? "Not found" : view.DesktopName ?? "Signed out";
        CliNow.Text = view.CliName ?? (view.IsCliSignedIn ? "Signed in (account not recognized yet)" : "Not signed in");
        AppNow.ToolTip = AppNow.Text;
        CliNow.ToolTip = CliNow.Text;

        // Rebuilt only on a change, so a timer tick can't disturb a click.
        if (_view is not null && _view.Rows.SequenceEqual(view.Rows) && _view.CanSwitchDesktop == view.CanSwitchDesktop
            && _view.IsCliSignedIn == view.IsCliSignedIn)
        {
            _view = view;
            return;
        }
        _view = view;
        AccountList.ItemsSource = view.Rows
            .Select(row => new RowView(
                row,
                view.CanSwitchDesktop && row.HasDesktop && !row.IsDesktopActive,
                row.HasCli && !row.IsCliActive))
            .ToList();
        EmptyState.Visibility = view.Rows.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        ListArea.Visibility = view.Rows.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
    }

    private void Say(string? text)
    {
        Status.Text = text ?? "";
        Status.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;
    }

    private bool Ask(string question, string title) =>
        MessageBox.Show(this, question, title, MessageBoxButton.OKCancel, MessageBoxImage.Question) == MessageBoxResult.OK;

    private void Warn(string text) =>
        MessageBox.Show(this, text, Title, MessageBoxButton.OK, MessageBoxImage.Warning);

    // Runs one action with the buttons off and the progress bar on.
    private async Task Work(string doing, Func<Task<string?>> work)
    {
        if (_isBusy) return;
        _isBusy = true;
        SetEnabled(false);
        Say(doing);
        // A look already under way finishes first, so the two don't write the same files.
        while (_isRefreshing) await Task.Delay(50);
        string? said;
        try
        {
            said = await work();
        }
        catch (Exception e)
        {
            said = null;
            Say(null);
            Warn($"Something went wrong: {e.Message}");
        }
        _isBusy = false;
        SetEnabled(true);
        Say(said);
        await Reload();
    }

    private void SetEnabled(bool on)
    {
        ListArea.IsEnabled = on;
        AddButton.IsEnabled = on;
        RefreshButton.IsEnabled = on;
        MoreButton.IsEnabled = on;
        Busy.Visibility = on ? Visibility.Hidden : Visibility.Visible;
    }

    // ---- Switching --------------------------------------------------------

    private async Task Switch(AccountRow row, bool moveApp, bool moveCli)
    {
        if (moveApp && !Ask(
                $"Claude will close and reopen signed in as {row.Title}.\n\nOpen sessions end, but they're kept and you can reopen them.",
                "Switch the Claude app"))
            return;

        await Work($"Switching to {row.Title}…", async () =>
        {
            // The CLI first: it switches in place, while the app takes a moment.
            string? note = null;
            if (moveCli)
            {
                var cli = await _store.SwitchCli(row.Id);
                if (!cli.Ok) return moveApp ? $"{cli.Problem} The app was left as it is." : cli.Problem;
                note = cli.Problem;
            }
            var chats = 0;
            if (moveApp)
            {
                var swap = await _store.SwapDesktop("switch", row.Id);
                if (!swap.Ok)
                {
                    return moveCli
                        ? $"The CLI is now signed in as {row.Title}, but the app was not switched: {swap.Error}"
                        : $"The app was not switched: {swap.Error}";
                }
                chats = swap.ChatsCopied;
            }

            var said = chats switch
            {
                0 => $"Now using {row.Title}.",
                1 => $"Now using {row.Title}. 1 chat came across.",
                _ => $"Now using {row.Title}. {chats} chats came across.",
            };

            return note is null ? said : $"{said} {note}";
        });
    }

    private async void OnSwitch(object sender, RoutedEventArgs e)
    {
        if (((Button)sender).Tag is RowView view) await Switch(view.Row, view.MovesApp, view.MovesCli);
    }

    private void OnRowMenu(object sender, RoutedEventArgs e)
    {
        var button = (Button)sender;
        if (button.Tag is not RowView view) return;

        var menu = new ContextMenu();
        if (view.MovesApp && view.MovesCli)
        {
            Add(menu, "Switch app only", async () => await Switch(view.Row, true, false));
            Add(menu, "Switch CLI only", async () => await Switch(view.Row, false, true));
            menu.Items.Add(new Separator());
        }
        Add(menu, "Rename…", () => Rename(view.Row));
        Add(menu, "Remove…", () => Remove(view.Row), view.CanRemove,
            view.CanRemove ? null : "Switch to another account before removing this one.");
        Open(menu, button);
    }

    private async void Rename(AccountRow row)
    {
        var dialog = new RenameWindow(row.Name) { Owner = this };
        if (dialog.ShowDialog() != true) return;
        // An empty name goes back to the email.
        await Work("Renaming…", async () =>
        {
            await _store.SetLabel(row.Id, dialog.Value);

            return null;
        });
    }

    private async void Remove(AccountRow row)
    {
        if (!Ask(
                $"Remove {row.Title} from this computer?\n\nIts saved login is deleted here. You'd have to sign in again to use it. Copies in the backups folder stay until newer switches replace them.",
                "Remove account"))
            return;
        await Work($"Removing {row.Title}…", async () => await _store.Forget(row.Id) ?? $"Removed {row.Title}.");
    }

    // ---- Adding -----------------------------------------------------------

    private void OnAdd(object sender, RoutedEventArgs e)
    {
        var menu = new ContextMenu();
        var canApp = _view?.CanSwitchDesktop == true;
        Add(menu, "Add to the Claude app…", async () => await AddToApp(), canApp, canApp ? null : "The Claude app wasn't found on this computer.");
        Add(menu, "Add to the Claude CLI…", async () => await AddToCli());
        Open(menu, AddButton);
    }

    private async Task AddToApp()
    {
        if (!Ask(
                "Claude will close and reopen signed out, so you can sign in with another account.\n\nThe current account is saved first. Open sessions end, but they're kept and you can reopen them.\n\nDon't use Log out in Claude to do this: it can end the saved login.",
                "Add an account"))
            return;
        await Work("Restarting Claude signed out…", async () =>
        {
            var swap = await _store.SwapDesktop("new");

            return swap.Ok
                ? "Sign in to Claude with the other account. It shows up here once you have."
                : $"Nothing changed: {swap.Error}";
        });
    }

    private async Task AddToCli()
    {
        await Work("Saving the current CLI login…", async () =>
        {
            await _store.SaveCurrentCli();
            var cli = _store.FindClaudeCli();
            if (cli is null) return "Your CLI login is saved. Claude Code wasn't found, so run: claude auth login";

            Process.Start(new ProcessStartInfo("cmd.exe", $"/k \"\"{cli}\" auth login\"") { UseShellExecute = true });

            return "Finish signing in with the other account in the window that opened. It shows up here once you have.";
        });
    }

    // ---- The rest ---------------------------------------------------------

    private async void OnRefresh(object sender, RoutedEventArgs e)
    {
        Say(null);
        await Reload();
    }

    private void OnMore(object sender, RoutedEventArgs e)
    {
        var menu = new ContextMenu();
        var sync = new MenuItem
        {
            Header = "Bring Code chats along when switching",
            IsCheckable = true,
            IsChecked = _store.SyncChats,
            ToolTip = "Copies Claude app Code chats into every organization of the account you switch to, so each account lists them. A chat carries what it saw in its organization.",
        };
        sync.Click += (_, _) =>
        {
            if (sync.IsChecked && !Ask(
                    "Each switch will copy the Code chats of your other accounts into every organization of the account you switch to, so a work organization's chats can show up under a personal account, and the other way round.\n\nA copied chat carries what it saw where it ran, such as its MCP servers and its folder, and resuming it sends its transcript to the account you're on.\n\nTurn this on?",
                    "Bring Code chats along"))
            {
                sync.IsChecked = false;
                return;
            }
            _store.SyncChats = sync.IsChecked;
        };
        menu.Items.Add(sync);
        menu.Items.Add(new Separator());
        Add(menu, "Open saved logins folder", OpenStore);
        var log = Path.Combine(_store.Paths.Store, "swap.log");
        Add(menu, "View switch log", () => OpenFile(log), File.Exists(log));
        menu.Items.Add(new Separator());
        if (Installer.IsRunningInstalled) Add(menu, "Uninstall…", UninstallFromMenu);
        else Add(menu, "Install to this computer…", Install);
        Open(menu, MoreButton);
    }

    private void OpenStore()
    {
        Directory.CreateDirectory(_store.Paths.Store);
        OpenFile(_store.Paths.Store);
    }

    private static void OpenFile(string path) =>
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });

    private void Install()
    {
        if (!Ask(
                "Add Claude Account Switcher to the Start menu and Installed apps?\n\nThis needs no admin rights. You can delete the copy you're running afterwards.",
                "Install"))
            return;
        var installed = Installer.Install();
        Process.Start(new ProcessStartInfo(installed, "--wait") { UseShellExecute = false });
        Application.Current.Shutdown();
    }

    private void UninstallFromMenu()
    {
        if (!Ask(
                "Remove Claude Account Switcher from this computer?\n\nYour saved accounts stay in your .claude folder, so the Claude Code mod and a later reinstall can still use them.",
                "Uninstall"))
            return;
        Installer.Uninstall();
        Application.Current.Shutdown();
    }

    private static void Add(ContextMenu menu, string text, Action action, bool isEnabled = true, string? hint = null)
    {
        var item = new MenuItem { Header = text, IsEnabled = isEnabled, ToolTip = hint };
        ToolTipService.SetShowOnDisabled(item, true);
        item.Click += (_, _) => action();
        menu.Items.Add(item);
    }

    private static void Open(ContextMenu menu, Button under)
    {
        menu.PlacementTarget = under;
        menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
        menu.IsOpen = true;
    }
}
