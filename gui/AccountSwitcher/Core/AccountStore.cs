using System.ComponentModel;
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

// The Windows port of the mod's hooks (hooks/register.tsx and hooks/accounts.ts).
// It reads and writes the same files in the same shapes, so this app and the
// Claude Code mod can share one store.

public sealed record Paths(string Credentials, string GlobalConfig, string Store, string? DesktopData);

// Whose login it is: Uuid is the account, Id the key of its saved copy, which is
// `<account>.<organization>` for a CLI login to a second organization of the
// same account. IsGuess where only the profile the CLI wrote beside it names it.
public sealed record Identity(
    string Id,
    string Uuid,
    string? Email = null,
    string? OrgName = null,
    string? OrgUuid = null,
    bool IsGuess = false);

public sealed record AccountRow(
    string Id,
    string Name,
    string? Email,
    string? OrgName,
    bool HasCli,
    bool HasDesktop,
    bool IsCliActive,
    bool IsDesktopActive)
{
    // The name, with the organization where another row has the same name.
    public string Title { get; init; } = Name;
}

public sealed record SwitcherView(
    IReadOnlyList<AccountRow> Rows,
    bool CanSwitchDesktop,
    string? DesktopName,
    string? CliName,
    // The CLI holds a login, even where its account can't be told.
    bool IsCliSignedIn);

public sealed record SwapResult(bool Ok, string? Error, int ChatsCopied = 0);

// Ok where the CLI now holds the login; Problem says what failed, or what was
// left undone beside a switch that happened.
public sealed record CliSwitchResult(bool Ok, string? Problem = null);

public sealed partial class AccountStore
{
    private const string Uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

    [GeneratedRegex("^" + Uuid + "$", RegexOptions.IgnoreCase)]
    private static partial Regex AccountIdPattern();

    // One account can belong to several organizations, and a CLI login belongs
    // to one of them: a second organization's login is saved as `<account>.<org>`.
    [GeneratedRegex("^" + Uuid + @"\." + Uuid + "$", RegexOptions.IgnoreCase)]
    private static partial Regex OrgLoginPattern();

    // A CLI login saved while its account could not be told (offline, token expired).
    [GeneratedRegex(@"^unidentified-(\d+)$")]
    private static partial Regex UnidentifiedPattern();

    private const string ProfileUrl = "https://api.anthropic.com/api/oauth/profile";
    private static readonly string[] DesktopAuthKeys = ["oauth:tokenCache", "oauth:tokenCacheV2"];
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(6) };

    // Exit code of the swap script when another switch holds its lock.
    private const int SwapBusy = 3;

    private static readonly JsonSerializerOptions Pretty = new()
    {
        WriteIndented = true,
        IndentSize = 2,
        // Leave the other tools' text as they wrote it.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public Paths Paths { get; }

    public AccountStore(Paths paths) => Paths = paths;

    public static bool IsAccountId(string? id) => id is not null && AccountIdPattern().IsMatch(id);

    private static bool IsUnidentified(string id) => UnidentifiedPattern().IsMatch(id);

    private static bool IsIdentified(string id) => AccountIdPattern().IsMatch(id) || OrgLoginPattern().IsMatch(id);

    private static bool IsCliId(string id) => IsIdentified(id) || IsUnidentified(id);

    private static string AccountOf(string id) => id.Split('.')[0];

    // What a row is called when nobody named it and its email is unknown.
    public static string FallbackName(string id)
    {
        var unidentified = UnidentifiedPattern().Match(id);
        if (!unidentified.Success) return $"Account {id[..8]}";

        return long.TryParse(unidentified.Groups[1].Value, out var ms) && ms is > 0 and < 253_402_300_800_000
            ? $"Unidentified CLI login (saved {DateTimeOffset.FromUnixTimeMilliseconds(ms):yyyy-MM-dd HH:mm} UTC)"
            : "Unidentified CLI login";
    }

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
    // the per-user install in %APPDATA%\Claude. Either can be left over from an
    // earlier install, so the folder whose config.json the app wrote last wins.
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

        return candidates
            .Select(dir => (dir, config: new FileInfo(Path.Combine(dir, "config.json"))))
            .Where(c => c.config.Exists)
            .OrderByDescending(c => c.config.LastWriteTimeUtc)
            .Select(c => c.dir)
            .FirstOrDefault();
    }

    private string CliDir => Path.Combine(Paths.Store, "cli");
    private string DesktopDir => Path.Combine(Paths.Store, "desktop");
    private string IndexPath => Path.Combine(Paths.Store, "accounts.json");
    private string LabelsPath => Path.Combine(Paths.Store, "labels.json");
    private string SettingsPath => Path.Combine(Paths.Store, "settings.json");
    private string LastSwapPath => Path.Combine(Paths.Store, "last-swap.json");
    private string SwapLogPath => Path.Combine(Paths.Store, "swap.log");
    private string CliPath(string id) => Path.Combine(CliDir, $"{id}.json");
    private string ReplacedPath(string id) => Path.Combine(Paths.Store, "replaced", $"{id}.json");
    private string DesktopAuthPath(string id) => Path.Combine(DesktopDir, id, "auth.json");

    // ---- JSON files -------------------------------------------------------

    private static string ReadText(string path)
    {
        // The app and the CLI may hold these open while they run.
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        return reader.ReadToEnd();
    }

    private static JsonObject? Parse(string text)
    {
        var value = JsonNode.Parse(text) as JsonObject;
        // Its keys are read lazily, and a repeated one throws only then.
        _ = value?.Count;

        return value;
    }

    private static bool IsUnreadable(Exception e) =>
        e is IOException or UnauthorizedAccessException or JsonException or ArgumentException;

    // A file that can't be read reads as missing: for what is only shown.
    private static JsonObject? ReadObject(string path)
    {
        try
        {
            return Parse(ReadText(path));
        }
        catch (Exception e) when (IsUnreadable(e))
        {
            return null;
        }
    }

    // Tells a file that isn't there (nothing in it to keep) from one that can't
    // be read right now (another program holds it, or is half way through
    // writing it), which must not be written over. Tries a few times first.
    private static async Task<(JsonObject? Value, string? Error)> ReadStrict(string path)
    {
        for (var attempt = 1; ; attempt++)
        {
            if (!File.Exists(path)) return (null, null);
            try
            {
                var value = Parse(ReadText(path));

                return value is null ? (null, "it holds no JSON object") : (value, null);
            }
            catch (Exception e) when (IsUnreadable(e))
            {
                if (attempt == 3) return (null, e.Message);
                await Task.Delay(150);
            }
        }
    }

    // Throws InvalidOperationException for text JSON can't carry (a lone
    // surrogate), before anything is written.
    private static string Serialize(JsonNode value) => value.ToJsonString(Pretty) + "\n";

    // Written beside the target and moved over it, so a crash can't leave half a file.
    private static void WriteText(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = $"{path}.{Environment.ProcessId}.tmp";
        File.WriteAllText(temporary, text, new UTF8Encoding(false));
        File.Move(temporary, path, overwrite: true);
    }

    private static void WriteObject(string path, JsonNode value) => WriteText(path, Serialize(value));

    private static string? Text(JsonNode? parent, string key) =>
        parent is JsonObject o && o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static string? Refresh(JsonNode? tokens) => Text(tokens, "refreshToken");
    private static string? Access(JsonNode? tokens) => Text(tokens, "accessToken");
    private static bool HasLogin(JsonNode? tokens) => Refresh(tokens) is not null || Access(tokens) is not null;

    private static long ExpiresAt(JsonNode? tokens) =>
        tokens is JsonObject o && o["expiresAt"] is JsonValue v && v.TryGetValue<long>(out var ms) ? ms : 0;

    // A JSON object of the values that are set.
    private static JsonObject Fields(params (string Key, string? Value)[] fields)
    {
        var o = new JsonObject();
        foreach (var (key, value) in fields)
        {
            if (value is not null) o[key] = value;
        }

        return o;
    }

    private IEnumerable<string> SavedCliIds() =>
        Directory.Exists(CliDir)
            ? Directory.GetFiles(CliDir, "*.json").Select(f => Path.GetFileNameWithoutExtension(f)!).Where(IsCliId)
            : [];

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    // ---- The index and the names people give accounts ---------------------

    private JsonObject ReadAccounts() => ReadObject(IndexPath)?["accounts"]?.DeepClone() as JsonObject ?? [];

    private void WriteAccounts(JsonObject accounts) => WriteObject(IndexPath, new JsonObject { ["accounts"] = accounts });

    private async Task Remember(Identity? who)
    {
        if (who is null) return;
        // An index caught half written is left for the next look, not rewritten from nothing.
        var (index, error) = await ReadStrict(IndexPath);
        if (error is not null) return;
        var accounts = index?["accounts"]?.DeepClone() as JsonObject ?? [];
        var known = accounts[who.Id];
        var email = who.Email ?? Text(known, "email");
        var org = who.OrgName ?? Text(known, "orgName");
        if (known is not null && email == Text(known, "email") && org == Text(known, "orgName")) return;
        accounts[who.Id] = Fields(("email", email), ("orgName", org));
        WriteAccounts(accounts);
    }

    public async Task SetLabel(string id, string? label)
    {
        var (labels, error) = await ReadStrict(LabelsPath);
        if (error is not null) throw new IOException($"labels.json could not be read ({error}).");
        labels ??= [];
        if (string.IsNullOrWhiteSpace(label)) labels.Remove(id);
        else labels[id] = label.Trim();
        WriteObject(LabelsPath, labels);
    }

    // Whether an app switch brings Code tab chats along. Off unless turned on:
    // a chat's record carries what it saw in its organization.
    public bool SyncChats
    {
        get => ReadObject(SettingsPath)?["syncChats"] is JsonValue v && v.TryGetValue<bool>(out var on) && on;
        set
        {
            var settings = ReadObject(SettingsPath) ?? [];
            settings["syncChats"] = value;
            WriteObject(SettingsPath, settings);
        }
    }

    // ---- The CLI ----------------------------------------------------------

    private JsonNode? ReadCliTokens() => ReadObject(Paths.Credentials)?["claudeAiOauth"];

    private JsonObject? ReadSnapshot(string id) => ReadObject(CliPath(id));

    private static Identity IdentityOf(string id, JsonNode? profile) =>
        new(id, AccountOf(id), Text(profile, "emailAddress"), Text(profile, "organizationName"), Text(profile, "organizationUuid"));

    // Where a login to this organization of the account is saved: under the
    // account, unless the account's saved login belongs to another organization.
    private string CliIdFor(string uuid, string? orgUuid)
    {
        if (orgUuid is null) return uuid;
        var second = $"{uuid}.{orgUuid}";
        if (File.Exists(CliPath(second))) return second;
        var savedOrg = Text(ReadSnapshot(uuid)?["oauthAccount"], "organizationUuid");

        return savedOrg is null || savedOrg == orgUuid ? uuid : second;
    }

    private Identity Placed(Identity who) => who with { Id = CliIdFor(who.Uuid, who.OrgUuid) };

    // Whose CLI login this is: the account a saved copy of the same token names;
    // else the one the account server answers for it while it is fresh; else the
    // profile the CLI wrote beside it, where this login is a newer copy of that
    // account's saved one (a refresh replaced its tokens) or the first.
    private async Task<Identity?> IdentifyCli(JsonNode tokens)
    {
        if (Refresh(tokens) is { } refresh)
        {
            foreach (var id in SavedCliIds().Where(IsIdentified))
            {
                var saved = ReadSnapshot(id);
                if (Refresh(saved?["claudeAiOauth"]) == refresh) return IdentityOf(id, saved?["oauthAccount"]);
            }
        }

        var access = Access(tokens);
        if (access is not null && ExpiresAt(tokens) > Now() + 60_000)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, ProfileUrl);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
                using var answer = await Http.SendAsync(request);
                if (answer.IsSuccessStatusCode)
                {
                    var profile = JsonNode.Parse(await answer.Content.ReadAsStringAsync());
                    var uuid = Text(profile?["account"], "uuid");
                    if (IsAccountId(uuid))
                    {
                        return Placed(new Identity(
                            uuid!,
                            uuid!,
                            Text(profile?["account"], "email"),
                            Text(profile?["organization"], "name"),
                            Text(profile?["organization"], "uuid")));
                    }
                }
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
            {
                // Offline, or the server answered something else: try the profile.
            }
        }

        var hint = ReadObject(Paths.GlobalConfig)?["oauthAccount"];
        var hinted = Text(hint, "accountUuid");
        if (!IsAccountId(hinted)) return null;
        var who = Placed(IdentityOf(hinted!, hint));
        var savedTokens = ReadSnapshot(who.Id)?["claudeAiOauth"];

        return savedTokens is null || ExpiresAt(tokens) > ExpiresAt(savedTokens) ? who with { IsGuess = true } : null;
    }

    // Before a guessed login replaces an account's saved one, the saved one is
    // kept aside (one copy per account), in case the guess was wrong.
    private void KeepReplaced(Identity who, JsonNode tokens)
    {
        if (!who.IsGuess) return;
        var saved = ReadSnapshot(who.Id);
        if (saved is not null && Refresh(saved["claudeAiOauth"]) != Refresh(tokens)) WriteObject(ReplacedPath(who.Id), saved);
    }

    private void SaveCli(string id, JsonNode tokens, Identity? who)
    {
        var profile = ReadObject(Paths.GlobalConfig)?["oauthAccount"] as JsonObject;
        var saved = ReadSnapshot(id)?["oauthAccount"] as JsonObject;
        var isTheirs = who is not null
            && Text(profile, "accountUuid") == who.Uuid
            && (who.OrgUuid is null || Text(profile, "organizationUuid") == who.OrgUuid);
        // A login that can't be told keeps the profile the CLI showed beside it,
        // so switching back to it puts both back as they were.
        var oauthAccount = who is null
            ? saved ?? profile
            : isTheirs
                ? profile
                : saved ?? Fields(
                    ("accountUuid", who.Uuid),
                    ("emailAddress", who.Email),
                    ("organizationUuid", who.OrgUuid),
                    ("organizationName", who.OrgName));
        var snapshot = new JsonObject { ["claudeAiOauth"] = tokens.DeepClone() };
        // The mod copies a profile into .claude.json, so none is written as none.
        if (oauthAccount is not null) snapshot["oauthAccount"] = oauthAccount.DeepClone();
        snapshot["savedAt"] = Now();
        WriteObject(CliPath(id), snapshot);
    }

    // Once a login is filed under its account, a placeholder copy of it goes.
    private void DropUnidentifiedCopies(string? refresh)
    {
        if (refresh is null) return;
        foreach (var id in SavedCliIds().Where(IsUnidentified).ToList())
        {
            if (Refresh(ReadSnapshot(id)?["claudeAiOauth"]) != refresh) continue;
            try
            {
                File.Delete(CliPath(id));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Left for the next look.
            }
        }
    }

    // Keeps the saved copy of the CLI's live login current (a refresh replaces
    // its tokens), and answers whose it is.
    private async Task<(bool IsSignedIn, Identity? Who)> SyncCli()
    {
        var tokens = ReadCliTokens();
        if (!HasLogin(tokens)) return (false, null);
        var who = await IdentifyCli(tokens!);
        if (who is null) return (true, null);
        var saved = ReadSnapshot(who.Id)?["claudeAiOauth"];
        if (Refresh(saved) != Refresh(tokens) || Access(saved) != Access(tokens))
        {
            KeepReplaced(who, tokens!);
            SaveCli(who.Id, tokens!, who);
            DropUnidentifiedCopies(Refresh(tokens));
        }

        return (true, who);
    }

    // Saves the CLI's live login (or the one given), under its account where
    // that can be told and under a placeholder otherwise, so a switch never
    // loses or misfiles one. Answers the id it was saved under.
    public async Task<string?> SaveCurrentCli(JsonNode? given = null)
    {
        var tokens = given ?? ReadCliTokens();
        if (!HasLogin(tokens)) return null;
        var who = await IdentifyCli(tokens!);
        if (who is null && Refresh(tokens) is { } refresh)
        {
            // The same unknown login needs only one placeholder.
            var copy = SavedCliIds().FirstOrDefault(id =>
                IsUnidentified(id) && Refresh(ReadSnapshot(id)?["claudeAiOauth"]) == refresh);
            if (copy is not null) return copy;
        }
        var saveAs = who?.Id ?? $"unidentified-{Now()}";
        if (who is not null) KeepReplaced(who, tokens!);
        SaveCli(saveAs, tokens!, who);
        if (who is not null)
        {
            await Remember(who);
            DropUnidentifiedCopies(Refresh(tokens));
        }

        return saveAs;
    }

    public async Task<CliSwitchResult> SwitchCli(string id)
    {
        var target = ReadSnapshot(id);
        var tokens = target?["claudeAiOauth"];
        if (!HasLogin(tokens)) return new(false, "No CLI login is saved for that account.");
        var before = await ReadStrict(Paths.Credentials);
        if (before.Error is not null) return new(false, $"The CLI was not switched: its login file could not be read ({before.Error}).");
        var global = await ReadStrict(Paths.GlobalConfig);
        if (global.Error is not null) return new(false, $"The CLI was not switched: .claude.json could not be read ({global.Error}).");
        await SaveCurrentCli(before.Value?["claudeAiOauth"]);

        // Another session may have refreshed the login meanwhile: that one is kept too.
        var now = await ReadStrict(Paths.Credentials);
        if (now.Error is not null) return new(false, $"The CLI was not switched: its login file could not be read ({now.Error}).");
        if (Refresh(now.Value?["claudeAiOauth"]) != Refresh(before.Value?["claudeAiOauth"]))
            await SaveCurrentCli(now.Value?["claudeAiOauth"]);

        // Only the Claude login changes: the MCP servers' tokens beside it stay.
        // Both files are put into words before either is written, so one that
        // can't be leaves neither half switched.
        var credentials = now.Value ?? [];
        credentials["claudeAiOauth"] = tokens!.DeepClone();
        string credentialsText;
        try
        {
            credentialsText = Serialize(credentials);
        }
        catch (InvalidOperationException e)
        {
            return new(false, $"The CLI was not switched: its login file could not be written back ({e.Message}).");
        }

        string? globalText = null;
        string? problem = null;
        if (target!["oauthAccount"] is JsonObject profile)
        {
            var latest = await ReadStrict(Paths.GlobalConfig);
            if (latest.Error is not null)
            {
                problem = $".claude.json could not be updated ({latest.Error}), so the CLI may show the previous account's name.";
            }
            else if (latest.Value is not null)
            {
                latest.Value["oauthAccount"] = profile.DeepClone();
                try
                {
                    globalText = Serialize(latest.Value);
                }
                catch (InvalidOperationException e)
                {
                    return new(false, $"The CLI was not switched: .claude.json holds text that can't be written back ({e.Message}).");
                }
            }
        }
        WriteText(Paths.Credentials, credentialsText);
        if (globalText is not null) WriteText(Paths.GlobalConfig, globalText);

        return new(true, problem);
    }

    // ---- The desktop app --------------------------------------------------

    private Identity? DesktopCurrent()
    {
        if (Paths.DesktopData is null) return null;
        var config = ReadObject(Path.Combine(Paths.DesktopData, "config.json"));
        var uuid = Text(config, "lastKnownAccountUuid");
        var isSignedIn = config is not null && DesktopAuthKeys.Any(config.ContainsKey);

        return isSignedIn && IsAccountId(uuid) ? new Identity(uuid!, uuid!) : null;
    }

    private static string Quote(string arg) => $"\"{arg.TrimEnd('\\')}\"";

    private static string Literal(string text) => $"'{text.Replace("'", "''")}'";

    // Runs scripts/desktop-swap.ps1 and waits for it. It closes the app, swaps
    // the sign-in, rolls back if a step fails, and starts the app again.
    public async Task<SwapResult> SwapDesktop(string mode, string? id = null)
    {
        if (Paths.DesktopData is null) return new SwapResult(false, "No Claude desktop app data was found on this computer.");
        if (mode == "switch" && !IsAccountId(id)) return new SwapResult(false, "That account has no saved app sign-in.");

        var script = Path.Combine(Paths.Store, "gui", "desktop-swap.ps1");
        Directory.CreateDirectory(Path.GetDirectoryName(script)!);
        using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("desktop-swap.ps1")!)
        using (var file = File.Create(script)) await resource.CopyToAsync(file);

        var windows = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
        var powershell = Path.Combine(windows, @"System32\WindowsPowerShell\v1.0\powershell.exe");
        var args = new List<string>
        {
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
            "-DataDir", Paths.DesktopData, "-StoreDir", Paths.Store, "-Mode", mode, "-DelayMs", "0",
        };
        if (id is not null) args.AddRange(["-To", id]);
        if (SyncChats) args.Add("-SyncChats");
        // Keeps a test away from the real app: only what matches this is closed.
        var testApp = Environment.GetEnvironmentVariable("ACCOUNT_SWITCHER_TEST_APP_LIKE");
        if (!string.IsNullOrEmpty(testApp)) args.AddRange(["-AppPathLike", testApp, "-NoRelaunch"]);

        var startedAt = Now();
        var (isStarted, outside) = await StartOutsideTree(powershell, args);
        using var helper = isStarted ? outside : StartChild(powershell, args);
        if (helper is not null)
        {
            // A first switch that carries many chats can take a while.
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(10));
            try
            {
                await helper.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                return new SwapResult(false, $"The switch is still running after 10 minutes. See {SwapLogPath}.");
            }
            if (ExitCodeOf(helper) == SwapBusy)
                return new SwapResult(false, "Another switch is under way. Try again once it has finished.");
        }

        var last = ReadObject(LastSwapPath);
        var at = last?["at"] is JsonValue v && v.TryGetValue<long>(out var ms) ? ms : 0;
        if (last is null || at < startedAt) return new SwapResult(false, $"The switch stopped early. See {SwapLogPath}.");
        var ok = last["ok"] is JsonValue okValue && okValue.TryGetValue<bool>(out var isOk) && isOk;
        var chats = last["chats"] is JsonValue c && c.TryGetValue<int>(out var count) ? count : 0;

        return new SwapResult(ok, ok ? null : Text(last, "error") ?? "Unknown error.", chats);
    }

    // Starts the helper through WMI, as the mod does, so it runs outside this
    // app's process tree: where this app was started from inside Claude, closing
    // Claude can't take the helper with it. Answers whether it started, and the
    // helper unless it had already finished.
    private static async Task<(bool IsStarted, Process? Helper)> StartOutsideTree(string powershell, IEnumerable<string> args)
    {
        var commandLine = string.Join(" ", new[] { Quote(powershell) }.Concat(args.Select(a => a.StartsWith('-') ? a : Quote(a))));
        var launcher = string.Join("; ",
            "$ProgressPreference = 'SilentlyContinue'",
            "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
            $"$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{ CommandLine = {Literal(commandLine)}; ProcessStartupInformation = $si }}",
            "if ($r.ReturnValue -eq 0) { [Console]::Out.Write($r.ProcessId) }",
            "exit [int]$r.ReturnValue");
        var start = new ProcessStartInfo(powershell)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
        };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(launcher)) })
            start.ArgumentList.Add(arg);
        int pid;
        try
        {
            using var launch = Process.Start(start);
            if (launch is null) return (false, null);
            var output = await launch.StandardOutput.ReadToEndAsync();
            await launch.WaitForExitAsync();
            if (launch.ExitCode != 0 || !int.TryParse(output.Trim(), out pid)) return (false, null);
        }
        catch (Win32Exception)
        {
            return (false, null);
        }

        Process? helper = null;
        try
        {
            helper = Process.GetProcessById(pid);
            // Opened now, so its exit code can be read once it is gone.
            _ = helper.Handle;

            return (true, helper);
        }
        catch (Exception e) when (e is ArgumentException or Win32Exception or InvalidOperationException)
        {
            // Already finished: last-swap.json tells how it went.
            helper?.Dispose();

            return (true, null);
        }
    }

    private static Process? StartChild(string powershell, IEnumerable<string> args)
    {
        var start = new ProcessStartInfo(powershell) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var arg in args) start.ArgumentList.Add(arg);

        return Process.Start(start) ?? throw new InvalidOperationException("PowerShell did not start.");
    }

    private static int? ExitCodeOf(Process process)
    {
        try
        {
            return process.ExitCode;
        }
        catch (Exception e) when (e is InvalidOperationException or Win32Exception)
        {
            return null;
        }
    }

    // ---- What the window shows --------------------------------------------

    public async Task<SwitcherView> LoadView()
    {
        var (isCliSignedIn, cli) = await SyncCli();
        var desktop = DesktopCurrent();

        // The CLI's profile names the desktop account's email where the two match.
        var profile = ReadObject(Paths.GlobalConfig)?["oauthAccount"];
        if (desktop is not null && Text(profile, "accountUuid") == desktop.Uuid)
            desktop = desktop with { Email = Text(profile, "emailAddress") };
        await Remember(cli);
        await Remember(desktop);

        var accounts = ReadAccounts();
        var labels = ReadObject(LabelsPath) ?? [];
        var savedCli = SavedCliIds().ToHashSet();
        var savedDesktop = Directory.Exists(DesktopDir)
            ? Directory.GetDirectories(DesktopDir).Select(d => Path.GetFileName(d)!)
                .Where(id => IsAccountId(id) && File.Exists(DesktopAuthPath(id))).ToHashSet()
            : [];

        var ids = accounts.Select(a => a.Key).Where(IsIdentified).Concat(savedCli).Concat(savedDesktop).ToHashSet();
        if (cli is not null) ids.Add(cli.Id);
        if (desktop is not null) ids.Add(desktop.Id);

        // A placeholder goes by the profile the CLI showed when it was saved, as
        // does the organization of a login an older index never named one for.
        var saved = ids
            .Where(id => IsUnidentified(id) || (savedCli.Contains(id) && Text(accounts[id], "orgName") is null))
            .ToDictionary(id => id, id => ReadSnapshot(id)?["oauthAccount"]);

        string NameOf(string id)
        {
            var label = Text(labels, id);
            if (!string.IsNullOrWhiteSpace(label)) return label.Trim();
            if (Text(accounts[id], "email") is { } email) return email;
            if (Text(saved.GetValueOrDefault(id), "emailAddress") is not { } shown) return FallbackName(id);

            return IsUnidentified(id) ? $"{shown} (unverified)" : shown;
        }

        var rows = ids.Select(id => new AccountRow(
                id,
                NameOf(id),
                Text(accounts[id], "email"),
                Text(accounts[id], "orgName") ?? Text(saved.GetValueOrDefault(id), "organizationName"),
                savedCli.Contains(id) || cli?.Id == id,
                savedDesktop.Contains(id) || desktop?.Id == id,
                cli?.Id == id,
                desktop?.Id == id))
            .ToList();
        rows = rows
            .Select(row => rows.Any(other => other.Id != row.Id && other.Name == row.Name) && row.OrgName is not null
                ? row with { Title = $"{row.Name} ({row.OrgName})" }
                : row)
            .OrderBy(r => r.IsDesktopActive || r.IsCliActive ? 0 : 1)
            .ThenBy(r => r.Title, StringComparer.OrdinalIgnoreCase)
            .ToList();
        string? TitleOf(Identity? who) => who is null ? null : rows.First(r => r.Id == who.Id).Title;

        return new SwitcherView(rows, Paths.DesktopData is not null, TitleOf(desktop), TitleOf(cli), isCliSignedIn);
    }

    // Answers what could not be removed, or null.
    public async Task<string?> Forget(string id)
    {
        if (!IsCliId(id)) return "That is not a saved account.";
        try
        {
            File.Delete(CliPath(id));
            File.Delete(ReplacedPath(id));
            var desktop = Path.Combine(DesktopDir, id);
            if (IsAccountId(id) && Directory.Exists(desktop)) Directory.Delete(desktop, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return $"Its saved login could not be removed ({e.Message}).";
        }
        var (index, error) = await ReadStrict(IndexPath);
        if (error is null && index?["accounts"] is JsonObject accounts && accounts.Remove(id)) WriteObject(IndexPath, index);
        try
        {
            await SetLabel(id, null);
        }
        catch (IOException e)
        {
            error ??= e.Message;
        }

        return error is null
            ? null
            : "Its saved login was removed, but the list of accounts could not be read to take it off. Try again shortly.";
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
