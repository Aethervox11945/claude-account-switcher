using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using AccountSwitcher.Core;

namespace AccountSwitcher;

public partial class App : Application
{
    private const string Title = "Claude Account Switcher";

    private Mutex? _single;
    private bool _ownsMutex;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    private const int Restore = 9;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += (_, args) =>
        {
            MessageBox.Show(args.Exception.Message, Title, MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
            // With no window to go back to, a process left running would only
            // hold the lock that makes every later start look for it.
            if (MainWindow is null) Shutdown(1);
        };

        try
        {
            Start(e);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, Title, MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    private void Start(StartupEventArgs e)
    {
        var args = e.Args.Select(a => a.ToLowerInvariant()).ToHashSet();
        var quiet = args.Contains("--yes");

        // Two windows must not swap sign-ins at once. A freshly installed copy
        // waits for the copy that started it to close.
        _single = new Mutex(false, @"Local\ClaudeAccountSwitcher");
        try
        {
            _ownsMutex = _single.WaitOne(args.Contains("--wait") ? 5000 : 0);
        }
        catch (AbandonedMutexException)
        {
            _ownsMutex = true;
        }

        if (args.Contains("--uninstall"))
        {
            Uninstall(quiet);
            Shutdown();
            return;
        }
        if (args.Contains("--install"))
        {
            Installer.Install();
            Shutdown();
            return;
        }
        if (!_ownsMutex)
        {
            FocusOtherWindow();
            Shutdown();
            return;
        }

        MainWindow = new MainWindow();
        MainWindow.Show();
    }

    private void Uninstall(bool quiet)
    {
        if (!_ownsMutex)
        {
            if (!quiet) MessageBox.Show($"Close {Title} first, then uninstall it.", Title, MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        if (!quiet)
        {
            var answer = MessageBox.Show(
                $"Remove {Title} from this computer?\n\nYour saved accounts stay in your .claude folder, so the Claude Code mod and a later reinstall can still use them.",
                Title, MessageBoxButton.YesNo, MessageBoxImage.Question);
            if (answer != MessageBoxResult.Yes) return;
        }
        Installer.Uninstall();
    }

    private static void FocusOtherWindow()
    {
        using var me = Process.GetCurrentProcess();
        foreach (var other in Process.GetProcessesByName(me.ProcessName))
        {
            using (other)
            {
                if (other.Id == me.Id || other.MainWindowHandle == IntPtr.Zero) continue;
                if (IsIconic(other.MainWindowHandle)) ShowWindow(other.MainWindowHandle, Restore);
                SetForegroundWindow(other.MainWindowHandle);
            }
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        if (_ownsMutex) _single?.ReleaseMutex();
        _single?.Dispose();
        base.OnExit(e);
    }
}
