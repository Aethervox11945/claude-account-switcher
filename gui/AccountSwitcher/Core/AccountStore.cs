using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AccountSwitcher.Core;

// The Windows port of hooks/accounts.ts. It reads and writes the same files in
// the same shapes, so this app and the Claude Code mod can share one store.

public sealed record Paths(string Credentials, string GlobalConfig, string Store, string? DesktopData);

public sealed record Identity(string Uuid, string? Email = null, string? OrgName = null);

public sealed record AccountRow(
    string Uuid,
    string Name,
    string? Email,
    string? OrgName,
    bool HasCli,
    bool HasDesktop,
    bool IsCliActive,
    bool IsDesktopActive);

public sealed record SwitcherView(
    IReadOnlyList<AccountRow> Rows,
    bool CanSwitchDesktop,
    string? DesktopName,
    string? CliName);

public sealed record SwapResult(bool Ok, string? Error, int ChatsCopied = 0);

public sealed partial class AccountStore
{
    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.IgnoreCase)]
    private static partial Regex AccountIdPattern();

    // A CLI login saved while its account could not be told (offline, token expired).
    [GeneratedRegex(@"^unidentified-\d+$")]
    private static partial Regex UnidentifiedPattern();

    private const string ProfileUrl = "https://api.anthropic.com/api/oauth/profile";
    private static readonly string[] DesktopAuthKeys = ["oauth:tokenCache", "oauth:tokenCacheV2"];
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(6) };

    private static readonly JsonSerializerOptions Pretty = new()
    {
        WriteIndented = true,
        IndentSize = 2,
        // Leave the other tools' text as they wrote it.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public Paths Paths { get; }

    public AccountStore(Paths paths) => Paths = paths;

    public static bool IsAccountId(string id) => AccountIdPattern().IsMatch(id) || UnidentifiedPattern().IsMatch(id);

    private static bool IsRealId(string? id) => id is not null && AccountIdPattern().IsMatch(id);

    public static string ShortId(string id) =>
        UnidentifiedPattern().IsMatch(id) ? "Unidentified CLI login" : $"Account {id[..8]}";

    // ---- Where things live ------------------------------------------------

    public static Paths ResolvePaths()
    {
        var home = Environment.GetEnvironmentVariable("USERPROFILE")
            ?? Environment.GetEnvironmentVariable("HOME")
            ?? throw new InvalidOperationException("Neither USERPROFILE nor HOME is set.");
        var configured = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
        var configDir = string.IsNullOrEmpty(configured) ? Path.Combine(home, ".claude") : configured;

        return new Paths(
            Path.Combine(configDir, ".credentials.json"),
            string.IsNullOrEmpty(configured) ? Path.Combine(home, ".claude.json") : Path.Combine(configured, ".claude.json"),
            Path.Combine(configDir, "account-switcher"),
            FindDesktopData());
    }

    // The packaged app keeps its data in %LOCALAPPDATA%\Claude-Data\claude_<id>,
    // the per-user install in %APPDATA%\Claude. A folder that holds a sign-in wins.
    private static string? FindDesktopData()
    {
        var candidates = new List<string>();
        var localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        var appData = Environment.GetEnvironmentVariable("APPDATA");
        if (localAppData is not null)
        {
            var root = Path.Combine(localAppData, "Claude-Data");
            if (Directory.Exists(root)) candidates.AddRange(Directory.GetDirectories(root, "claude*"));
        }
        if (appData is not null) candidates.Add(Path.Combine(appData, "Claude"));

        string? fallback = null;
        foreach (var dir in candidates)
        {
            var config = ReadObject(Path.Combine(dir, "config.json"));
            if (config is null) continue;
            if (config.ContainsKey("lastKnownAccountUuid") || DesktopAuthKeys.Any(config.ContainsKey)) return dir;
            fallback ??= dir;
        }

        return fallback;
    }

    private string CliDir => Path.Combine(Paths.Store, "cli");
    private string DesktopDir => Path.Combine(Paths.Store, "desktop");
    private string IndexPath => Path.Combine(Paths.Store, "accounts.json");
    private string LabelsPath => Path.Combine(Paths.Store, "labels.json");
    private string SettingsPath => Path.Combine(Paths.Store, "settings.json");
    private string CliPath(string id) => Path.Combine(CliDir, $"{id}.json");
    private string DesktopAuthPath(string id) => Path.Combine(DesktopDir, id, "auth.json");

    // ---- JSON files -------------------------------------------------------

    private static JsonObject? ReadObject(string path)
    {
        try
        {
            // The app and the CLI may hold these open while they run.
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);

            return JsonNode.Parse(reader.ReadToEnd()) as JsonObject;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    // Written beside the target and moved over it, so a crash can't leave half a file.
    private static void WriteObject(string path, JsonNode value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = $"{path}.{Environment.ProcessId}.tmp";
        File.WriteAllText(temporary, value.ToJsonString(Pretty) + "\n", new UTF8Encoding(false));
        File.Move(temporary, path, overwrite: true);
    }

    private static string? Text(JsonNode? parent, string key) =>
        parent is JsonObject o && o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static string? Refresh(JsonNode? tokens) => Text(tokens, "refreshToken");
    private static string? Access(JsonNode? tokens) => Text(tokens, "accessToken");

    private static IEnumerable<string> SavedCliIds(string dir) =>
        Directory.Exists(dir)
            ? Directory.GetFiles(dir, "*.json").Select(f => Path.GetFileNameWithoutExtension(f)!).Where(IsAccountId)
            : [];

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    // ---- The index and the names people give accounts ---------------------

    private JsonObject ReadAccounts() => ReadObject(IndexPath)?["accounts"]?.DeepClone() as JsonObject ?? [];

    private void WriteAccounts(JsonObject accounts) => WriteObject(IndexPath, new JsonObject { ["accounts"] = accounts });

    private void Remember(Identity? who)
    {
        if (who is null) return;
        var accounts = ReadAccounts();
        var known = accounts[who.Uuid];
        var email = who.Email ?? Text(known, "email");
        var org = who.OrgName ?? Text(known, "orgName");
        if (known is not null && email == Text(known, "email") && org == Text(known, "orgName")) return;
        accounts[who.Uuid] = new JsonObject { ["email"] = email, ["orgName"] = org };
        WriteAccounts(accounts);
    }

    public void SetLabel(string id, string? label)
    {
        var labels = ReadObject(LabelsPath) ?? [];
        if (string.IsNullOrWhiteSpace(label)) labels.Remove(id);
        else labels[id] = label.Trim();
        WriteObject(LabelsPath, labels);
    }

    // Whether an app switch brings Code tab chats along. On unless turned off.
    public bool SyncChats
    {
        get => ReadObject(SettingsPath)?["syncChats"] is not JsonValue v || !v.TryGetValue<bool>(out var on) || on;
        set
        {
            var settings = ReadObject(SettingsPath) ?? [];
            settings["syncChats"] = value;
            WriteObject(SettingsPath, settings);
        }
    }

    // ---- The CLI ----------------------------------------------------------

    private JsonNode? ReadCliTokens() => ReadObject(Paths.Credentials)?["claudeAiOauth"];

    // Whose CLI login this is: the account a saved copy of the same token names,
    // else the one the account server answers for it while it is fresh.
    private async Task<Identity?> IdentifyCli(JsonNode tokens)
    {
        var refresh = Refresh(tokens);
        if (refresh is not null)
        {
            foreach (var id in SavedCliIds(CliDir).Where(IsRealId))
            {
                var saved = ReadObject(CliPath(id));
                if (Refresh(saved?["claudeAiOauth"]) == refresh)
                    return new Identity(id, Text(saved?["oauthAccount"], "emailAddress"));
            }
        }

        var access = Access(tokens);
        var expiresAt = tokens["expiresAt"] is JsonValue v && v.TryGetValue<long>(out var ms) ? ms : 0;
        if (access is null || expiresAt <= Now() + 60_000) return null;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, ProfileUrl);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
            using var answer = await Http.SendAsync(request);
            if (!answer.IsSuccessStatusCode) return null;
            var profile = JsonNode.Parse(await answer.Content.ReadAsStringAsync());
            var uuid = Text(profile?["account"], "uuid");

            return IsRealId(uuid)
                ? new Identity(uuid!, Text(profile?["account"], "email"), Text(profile?["organization"], "name"))
                : null;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            return null;
        }
    }

    private void SaveCli(string id, JsonNode tokens, Identity? who)
    {
        var profile = ReadObject(Paths.GlobalConfig)?["oauthAccount"];
        var saved = ReadObject(CliPath(id));
        JsonNode? oauthAccount = Text(profile, "accountUuid") == id
            ? profile
            : saved?["oauthAccount"] ?? (who is null ? null : new JsonObject
            {
                ["accountUuid"] = id,
                ["emailAddress"] = who.Email,
                ["organizationName"] = who.OrgName,
            });
        WriteObject(CliPath(id), new JsonObject
        {
            ["claudeAiOauth"] = tokens.DeepClone(),
            ["oauthAccount"] = oauthAccount?.DeepClone(),
            ["savedAt"] = Now(),
        });
    }

    // Keeps the saved copy of the CLI's live login current (a refresh replaces
    // its tokens), and answers whose it is.
    private async Task<Identity?> SyncCli()
    {
        var tokens = ReadCliTokens();
        if (Refresh(tokens) is null && Access(tokens) is null) return null;
        var who = await IdentifyCli(tokens!);
        if (who is null) return null;
        var saved = ReadObject(CliPath(who.Uuid))?["claudeAiOauth"];
        if (Refresh(saved) != Refresh(tokens) || Access(saved) != Access(tokens)) SaveCli(who.Uuid, tokens!, who);

        return who;
    }

    // Saves the CLI's live login, under its account where that can be told and
    // under a placeholder otherwise, so a switch never loses or misfiles one.
    public async Task<string?> SaveCurrentCli()
    {
        var tokens = ReadCliTokens();
        if (Refresh(tokens) is null && Access(tokens) is null) return null;
        var who = await IdentifyCli(tokens!);
        if (who is null)
        {
            // The same unknown login needs only one placeholder.
            var copy = SavedCliIds(CliDir).FirstOrDefault(id =>
                !IsRealId(id) && Refresh(ReadObject(CliPath(id))?["claudeAiOauth"]) == Refresh(tokens));
            if (copy is not null) return copy;
        }
        var saveAs = who?.Uuid ?? $"unidentified-{Now()}";
        SaveCli(saveAs, tokens!, who);
        Remember(who);

        return saveAs;
    }

    public async Task<string?> SwitchCli(string id)
    {
        var target = ReadObject(CliPath(id));
        var tokens = target?["claudeAiOauth"];
        if (tokens is null) return "No CLI login is saved for that account.";
        await SaveCurrentCli();

        // Only the Claude login changes: the MCP servers' tokens beside it stay.
        var credentials = ReadObject(Paths.Credentials) ?? [];
        credentials["claudeAiOauth"] = tokens.DeepClone();
        WriteObject(Paths.Credentials, credentials);

        var global = ReadObject(Paths.GlobalConfig);
        var profile = target?["oauthAccount"];
        if (global is not null && profile is not null)
        {
            global["oauthAccount"] = profile.DeepClone();
            WriteObject(Paths.GlobalConfig, global);
        }

        return null;
    }

    // ---- The desktop app --------------------------------------------------

    private Identity? DesktopCurrent()
    {
        if (Paths.DesktopData is null) return null;
        var config = ReadObject(Path.Combine(Paths.DesktopData, "config.json"));
        var uuid = Text(config, "lastKnownAccountUuid");
        var isSignedIn = config is not null && DesktopAuthKeys.Any(config.ContainsKey);

        return isSignedIn && IsRealId(uuid) ? new Identity(uuid!) : null;
    }

    // Runs scripts/desktop-swap.ps1 and waits for it. It closes the app, swaps
    // the sign-in, rolls back if a step fails, and starts the app again.
    public async Task<SwapResult> SwapDesktop(string mode, string? id = null)
    {
        if (Paths.DesktopData is null) return new SwapResult(false, "No Claude desktop app data was found on this computer.");
        if (mode == "switch" && !IsRealId(id)) return new SwapResult(false, "That account has no saved app sign-in.");

        var script = Path.Combine(Paths.Store, "gui", "desktop-swap.ps1");
        Directory.CreateDirectory(Path.GetDirectoryName(script)!);
        using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("desktop-swap.ps1")!)
        using (var file = File.Create(script)) await resource.CopyToAsync(file);

        var windows = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
        var start = new ProcessStartInfo(Path.Combine(windows, @"System32\WindowsPowerShell\v1.0\powershell.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
        {
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
            "-DataDir", Paths.DesktopData, "-StoreDir", Paths.Store, "-Mode", mode, "-DelayMs", "0",
        }) start.ArgumentList.Add(arg);
        if (id is not null)
        {
            start.ArgumentList.Add("-To");
            start.ArgumentList.Add(id);
        }
        if (SyncChats) start.ArgumentList.Add("-SyncChats");
        // Keeps a test away from the real app: only what matches this is closed.
        var testApp = Environment.GetEnvironmentVariable("ACCOUNT_SWITCHER_TEST_APP_LIKE");
        if (!string.IsNullOrEmpty(testApp))
        {
            start.ArgumentList.Add("-AppPathLike");
            start.ArgumentList.Add(testApp);
            start.ArgumentList.Add("-NoRelaunch");
        }

        var startedAt = Now();
        using var process = Process.Start(start) ?? throw new InvalidOperationException("PowerShell did not start.");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            return new SwapResult(false, $"The switch is taking too long. See {Path.Combine(Paths.Store, "swap.log")}.");
        }

        var last = ReadObject(Path.Combine(Paths.Store, "last-swap.json"));
        var at = last?["at"] is JsonValue v && v.TryGetValue<long>(out var ms) ? ms : 0;
        if (last is null || at < startedAt)
            return new SwapResult(false, $"The switch stopped early (exit {process.ExitCode}). See {Path.Combine(Paths.Store, "swap.log")}.");
        var ok = last["ok"] is JsonValue okValue && okValue.TryGetValue<bool>(out var isOk) && isOk;

        var chats = last["chats"] is JsonValue c && c.TryGetValue<int>(out var count) ? count : 0;

        return new SwapResult(ok, ok ? null : Text(last, "error") ?? "Unknown error.", chats);
    }

    // ---- What the window shows --------------------------------------------

    public async Task<SwitcherView> LoadView()
    {
        var cli = await SyncCli();
        var desktop = DesktopCurrent();

        // The CLI's profile names the desktop account where the two match.
        var profile = ReadObject(Paths.GlobalConfig)?["oauthAccount"];
        if (desktop is not null && Text(profile, "accountUuid") == desktop.Uuid)
            desktop = desktop with { Email = Text(profile, "emailAddress"), OrgName = Text(profile, "organizationName") };
        Remember(cli);
        Remember(desktop);

        var accounts = ReadAccounts();
        var labels = ReadObject(LabelsPath) ?? [];
        var savedCli = SavedCliIds(CliDir).ToHashSet();
        var savedDesktop = Directory.Exists(DesktopDir)
            ? Directory.GetDirectories(DesktopDir).Select(d => Path.GetFileName(d)!)
                .Where(id => IsRealId(id) && File.Exists(DesktopAuthPath(id))).ToHashSet()
            : [];

        var ids = accounts.Select(a => a.Key).Concat(savedCli).Concat(savedDesktop).Where(IsAccountId).ToHashSet();
        if (cli is not null) ids.Add(cli.Uuid);
        if (desktop is not null) ids.Add(desktop.Uuid);

        string NameOf(string id) => Text(labels, id) ?? Text(accounts[id], "email") ?? ShortId(id);

        var rows = ids.Select(id => new AccountRow(
                id,
                NameOf(id),
                Text(accounts[id], "email"),
                Text(accounts[id], "orgName"),
                savedCli.Contains(id) || cli?.Uuid == id,
                savedDesktop.Contains(id) || desktop?.Uuid == id,
                cli?.Uuid == id,
                desktop?.Uuid == id))
            .OrderBy(r => r.IsDesktopActive || r.IsCliActive ? 0 : 1)
            .ThenBy(r => r.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return new SwitcherView(
            rows,
            Paths.DesktopData is not null,
            desktop is null ? null : NameOf(desktop.Uuid),
            cli is null ? null : NameOf(cli.Uuid));
    }

    public void Forget(string id)
    {
        if (!IsAccountId(id)) return;
        File.Delete(CliPath(id));
        var desktop = Path.Combine(DesktopDir, id);
        if (Directory.Exists(desktop)) Directory.Delete(desktop, recursive: true);
        var accounts = ReadAccounts();
        if (accounts.Remove(id)) WriteAccounts(accounts);
        SetLabel(id, null);
    }

    // ---- Signing in to the CLI --------------------------------------------

    // The CLI on PATH, else the usual install, else the newest copy the desktop
    // app carries for its own sessions.
    public string? FindClaudeCli()
    {
        var names = new[] { "claude.exe", "claude.cmd" };
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var name in names)
            {
                try
                {
                    var path = Path.Combine(dir.Trim(), name);
                    if (File.Exists(path) && !path.Contains(@"\WindowsApps\", StringComparison.OrdinalIgnoreCase)) return path;
                }
                catch (ArgumentException)
                {
                    // A malformed PATH entry.
                }
            }
        }

        var home = Environment.GetEnvironmentVariable("USERPROFILE");
        if (home is not null)
        {
            var local = Path.Combine(home, ".local", "bin", "claude.exe");
            if (File.Exists(local)) return local;
        }

        if (Paths.DesktopData is null) return null;
        var bundled = Path.Combine(Paths.DesktopData, "claude-code");
        if (!Directory.Exists(bundled)) return null;

        return Directory.GetFiles(bundled, "claude.exe", SearchOption.AllDirectories)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();
    }
}
