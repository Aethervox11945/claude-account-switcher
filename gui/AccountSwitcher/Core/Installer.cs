using System.Diagnostics;
using System.IO;
using System.Reflection;
using Microsoft.Win32;

namespace AccountSwitcher.Core;

// The exe is portable as it stands. Installing is optional: it copies the exe
// into the user's own Programs folder and adds a Start Menu entry and an entry
// in Installed apps. No admin rights, and saved accounts are never touched.
public static class Installer
{
    private const string AppName = "Claude Account Switcher";
    private const string ExeName = "ClaudeAccountSwitcher.exe";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ClaudeAccountSwitcher";

    private static string InstallDir => Path.Combine(
        Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? throw new InvalidOperationException("LOCALAPPDATA is not set."),
        "Programs", AppName);

    private static string InstalledExe => Path.Combine(InstallDir, ExeName);

    private static string Shortcut => Path.Combine(
        Environment.GetEnvironmentVariable("APPDATA") ?? throw new InvalidOperationException("APPDATA is not set."),
        @"Microsoft\Windows\Start Menu\Programs", $"{AppName}.lnk");

    public static bool IsRunningInstalled =>
        string.Equals(Environment.ProcessPath, InstalledExe, StringComparison.OrdinalIgnoreCase);

    // Answers the installed exe.
    public static string Install()
    {
        var source = Environment.ProcessPath ?? throw new InvalidOperationException("Cannot tell where this program is.");
        Directory.CreateDirectory(InstallDir);
        File.Copy(source, InstalledExe, overwrite: true);

        // WScript.Shell is the one built-in way to write a .lnk.
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!)!;
        dynamic link = shell.CreateShortcut(Shortcut);
        link.TargetPath = InstalledExe;
        link.WorkingDirectory = InstallDir;
        link.Description = "Switch between saved Claude accounts";
        link.Save();

        using var key = Registry.CurrentUser.CreateSubKey(UninstallKey);
        key.SetValue("DisplayName", AppName);
        key.SetValue("DisplayVersion", Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.1.0");
        key.SetValue("Publisher", "account-switcher");
        key.SetValue("DisplayIcon", InstalledExe);
        key.SetValue("InstallLocation", InstallDir);
        key.SetValue("UninstallString", $"\"{InstalledExe}\" --uninstall");
        key.SetValue("EstimatedSize", (int)(new FileInfo(InstalledExe).Length / 1024), RegistryValueKind.DWord);
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);

        return InstalledExe;
    }

    public static void Uninstall()
    {
        File.Delete(Shortcut);
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, throwOnMissingSubKey: false);

        // A running exe can't delete itself, so a shell does once this one exits.
        if (!Directory.Exists(InstallDir)) return;
        Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"{InstallDir}\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            // Not the folder being removed.
            WorkingDirectory = Path.GetTempPath(),
        });
    }
}
