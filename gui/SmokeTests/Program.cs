// Runs the account logic and the real swap script against a throwaway profile.
// Nothing here touches the real Claude app or your real logins: every path is
// under a temp folder, and the script only closes executables matching a
// pattern nothing matches.

using System.Text.Json.Nodes;
using AccountSwitcher.Core;

const string A = "11111111-1111-4111-8111-111111111111";
const string B = "22222222-2222-4222-8222-222222222222";
const string D = "44444444-4444-4444-8444-444444444444";
const string Home = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const string Work = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

Environment.SetEnvironmentVariable("ACCOUNT_SWITCHER_TEST_APP_LIKE", @"*\no-such-folder\no-such-app.exe");

var root = Directory.CreateTempSubdirectory("account-switcher-test").FullName;
var failed = 0;

void Check(string what, bool ok)
{
    Console.WriteLine($"{(ok ? "ok  " : "FAIL")} {what}");
    if (!ok) failed++;
}

JsonObject Read(string path) => (JsonObject)JsonNode.Parse(File.ReadAllText(path))!;

void Write(string path, string text)
{
    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    File.WriteAllText(path, text);
}

// Expired, so nothing here ever reaches the account server.
string Tokens(string who, long expiresAt = 1000) =>
    $$"""{ "accessToken": "access-{{who}}", "refreshToken": "refresh-{{who}}", "expiresAt": {{expiresAt}} }""";
string Profile(string id, string email, string? org = null, string? orgName = null) =>
    org is null
        ? $$"""{ "accountUuid": "{{id}}", "emailAddress": "{{email}}", "organizationName": "{{email}} org" }"""
        : $$"""{ "accountUuid": "{{id}}", "emailAddress": "{{email}}", "organizationUuid": "{{org}}", "organizationName": "{{orgName}}" }""";
string Snapshot(string who, string id, string email) => $$"""{ "claudeAiOauth": {{Tokens(who)}}, "oauthAccount": {{Profile(id, email)}}, "savedAt": 1 }""";
string RefreshIn(string path) => Read(path)["claudeAiOauth"]!["refreshToken"]!.GetValue<string>();

var data = Path.Combine(root, "desktop-data");
var store = Path.Combine(root, ".claude", "account-switcher");
var paths = new Paths(Path.Combine(root, ".claude", ".credentials.json"), Path.Combine(root, ".claude.json"), store, data);
var config = Path.Combine(data, "config.json");
var cookies = Path.Combine(data, "Network", "Cookies");
string Cli(string id) => Path.Combine(store, "cli", $"{id}.json");

Write(paths.Credentials, $$"""{ "claudeAiOauth": {{Tokens("A")}}, "mcpOAuth": { "server": "keep-me" } }""");
Write(paths.GlobalConfig, $$"""{ "theme": "dark", "note": "é → kept", "oauthAccount": {{Profile(A, "a@example.com")}} }""");
Write(Cli(A), Snapshot("A", A, "a@example.com"));
Write(Cli(B), Snapshot("B", B, "b@example.com"));
Write(Path.Combine(store, "accounts.json"), $$"""{ "accounts": { "{{A}}": { "email": "a@example.com" }, "{{B}}": { "email": "b@example.com" } } }""");
Write(config, $$"""{ "locale": "en", "oauth:tokenCache": "enc-A", "lastKnownAccountUuid": "{{A}}" }""");
Write(cookies, "cookies-of-A");
Write(Path.Combine(store, "desktop", B, "auth.json"), $$"""{ "savedAt": 1, "oauth:tokenCache": "enc-B", "lastKnownAccountUuid": "{{B}}" }""");
Write(Path.Combine(store, "desktop", B, "Cookies"), "cookies-of-B");

var accounts = new AccountStore(paths);

var view = await accounts.LoadView();
Check("lists both accounts", view.Rows.Count == 2);
Check("sees who the app and CLI are on", view.DesktopName == "a@example.com" && view.CliName == "a@example.com");
Check("the account in use comes first", view.Rows[0].Id == A && view.Rows[0].IsCliActive && view.Rows[0].IsDesktopActive);
Check("the other account can be switched to", view.Rows[1].HasCli && view.Rows[1].HasDesktop);

// A token refresh since the last save must survive the switch.
Write(paths.Credentials, $$"""{ "claudeAiOauth": { "accessToken": "access-A2", "refreshToken": "refresh-A", "expiresAt": 1000 }, "mcpOAuth": { "server": "keep-me" } }""");
var cliSwitch = await accounts.SwitchCli(B);
Check("CLI switch reports no problem", cliSwitch.Ok && cliSwitch.Problem is null);
var credentials = Read(paths.Credentials);
Check("CLI login is B's", RefreshIn(paths.Credentials) == "refresh-B");
Check("MCP tokens stay", credentials["mcpOAuth"]!["server"]!.GetValue<string>() == "keep-me");
var global = Read(paths.GlobalConfig);
Check("CLI profile is B's", global["oauthAccount"]!["accountUuid"]!.GetValue<string>() == B);
Check("other settings stay", global["theme"]!.GetValue<string>() == "dark");
Check("non-ASCII text stays readable", File.ReadAllText(paths.GlobalConfig).Contains("é → kept"));
Check("A's newest tokens are saved", Read(Cli(A))["claudeAiOauth"]!["accessToken"]!.GetValue<string>() == "access-A2");

// Code tab chats: one record each, per account and organization.
var chatsOfA = Path.Combine(data, "claude-code-sessions", A, "org-a");
var chatsOfB = Path.Combine(data, "claude-code-sessions", B, "org-b");
void Chat(string dir, string name, string text, int daysAgo)
{
    var path = Path.Combine(dir, name);
    Write(path, text);
    File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddDays(-daysAgo));
}
Chat(chatsOfA, "local_only-a.json", "from A", 3);
Chat(chatsOfA, "local_newer-in-a.json", "newer", 1);
Chat(chatsOfB, "local_newer-in-a.json", "older", 5);
Chat(chatsOfA, "local_newer-in-b.json", "older", 5);
Chat(chatsOfB, "local_newer-in-b.json", "newer", 1);
Chat(chatsOfA, "scheduled-tasks.json", "of A", 1);
Chat(chatsOfB, "scheduled-tasks.json", "of B", 9);

Check("bringing chats along is off by default", !accounts.SyncChats);
accounts.SyncChats = true;
var swap = await accounts.SwapDesktop("switch", B);
Check($"app switch succeeds ({swap.Error})", swap.Ok);
Check("a chat only A had comes across", File.ReadAllText(Path.Combine(chatsOfB, "local_only-a.json")) == "from A");
Check("a newer copy replaces an older one", File.ReadAllText(Path.Combine(chatsOfB, "local_newer-in-a.json")) == "newer");
Check("an older copy replaces nothing", File.ReadAllText(Path.Combine(chatsOfB, "local_newer-in-b.json")) == "newer");
Check("the replaced copy is backed up", Directory.GetFiles(Path.Combine(store, "chat-backups"), "*local_newer-in-a.json", SearchOption.AllDirectories).Length == 1);
Check("the originals stay", File.Exists(Path.Combine(chatsOfA, "local_only-a.json")));
Check("only chats are copied", File.ReadAllText(Path.Combine(chatsOfB, "scheduled-tasks.json")) == "of B");
Check("the switch counts them", swap.ChatsCopied == 2);
var after = Read(config);
Check("app sign-in is B's", after["lastKnownAccountUuid"]!.GetValue<string>() == B && after["oauth:tokenCache"]!.GetValue<string>() == "enc-B");
Check("other app settings stay", after["locale"]!.GetValue<string>() == "en");
Check("app cookies are B's", File.ReadAllText(cookies) == "cookies-of-B");
Check("A's app sign-in is saved", File.Exists(Path.Combine(store, "desktop", A, "auth.json")) && File.ReadAllText(Path.Combine(store, "desktop", A, "Cookies")) == "cookies-of-A");

view = await accounts.LoadView();
Check("the view follows the switch", view.DesktopName == "b@example.com" && view.CliName == "b@example.com");

accounts.SyncChats = false;
Chat(chatsOfA, "local_while-off.json", "from A", 1);
swap = await accounts.SwapDesktop("switch", B);
Check("turned off, a switch copies no chats", swap.Ok && !File.Exists(Path.Combine(chatsOfB, "local_while-off.json")));
accounts.SyncChats = true;
swap = await accounts.SwapDesktop("switch", B);
Check("a second pass copies only what's new", swap.Ok && swap.ChatsCopied == 1);
File.Delete(Path.Combine(chatsOfB, "local_only-a.json"));
swap = await accounts.SwapDesktop("switch", B);
Check("a chat deleted after it came across is not copied back", swap.Ok && !File.Exists(Path.Combine(chatsOfB, "local_only-a.json")));

var missing = "33333333-3333-4333-8333-333333333333";
var before = File.ReadAllText(config);
swap = await accounts.SwapDesktop("switch", missing);
Check("switching to an unsaved account fails", !swap.Ok && swap.Error is not null);
Check("and leaves the app alone", File.ReadAllText(config) == before);

await accounts.SetLabel(A, "Work");
view = await accounts.LoadView();
Check("a name replaces the email", view.Rows.Any(r => r.Id == A && r.Name == "Work" && r.Email == "a@example.com"));
await accounts.SetLabel(A, "");
view = await accounts.LoadView();
Check("an empty name goes back to the email", view.Rows.Any(r => r.Id == A && r.Name == "a@example.com"));

swap = await accounts.SwapDesktop("new");
Check("signing out for a new account succeeds", swap.Ok);
after = Read(config);
Check("no sign-in is left in the app", !after.ContainsKey("oauth:tokenCache") && !after.ContainsKey("lastKnownAccountUuid"));
Check("no cookies are left", !File.Exists(cookies));
view = await accounts.LoadView();
Check("the app shows as signed out", view.DesktopName is null && view.Rows.Any(r => r.Id == B && r.HasDesktop));

// One switch at a time: a second one while the first holds the lock does nothing.
before = File.ReadAllText(config);
using (new FileStream(Path.Combine(store, "swap.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
{
    swap = await accounts.SwapDesktop("switch", B);
}
Check("a switch while another runs is refused", !swap.Ok && swap.Error?.Contains("Another switch") == true);
Check("and changes nothing", File.ReadAllText(config) == before);

// A sign-in the app holds without naming its account can't be saved, so it stays.
Write(config, """{ "locale": "en", "oauth:tokenCacheV2": "enc-X" }""");
before = File.ReadAllText(config);
swap = await accounts.SwapDesktop("switch", B);
Check("an app sign-in with no account id stops the switch", !swap.Ok && swap.Error?.Contains("names no account") == true);
Check("and keeps that sign-in", File.ReadAllText(config) == before);

// A login no saved copy matches, with an expired token, can't be identified.
Write(paths.Credentials, $$"""{ "claudeAiOauth": {{Tokens("C")}} }""");
var first = await accounts.SaveCurrentCli();
var second = await accounts.SaveCurrentCli();
Check("an unknown login gets a placeholder", first?.StartsWith("unidentified-") == true);
Check("only one", first == second);
view = await accounts.LoadView();
Check("the CLI shows as signed in all the same", view.IsCliSignedIn && view.CliName is null);

// The CLI refreshed B's login while nothing watched, and its token has since
// expired: the profile the CLI wrote beside it names it.
Write(paths.Credentials, $$"""{ "claudeAiOauth": {{Tokens("B2", 5000)}} }""");
view = await accounts.LoadView();
Check("a refreshed login is filed under its account", view.CliName == "b@example.com" && RefreshIn(Cli(B)) == "refresh-B2");
Check("the copy it replaced is kept aside", RefreshIn(Path.Combine(store, "replaced", $"{B}.json")) == "refresh-B");

// One account in two organizations keeps a CLI login for each.
Write(Cli(D), $$"""{ "claudeAiOauth": {{Tokens("D1")}}, "oauthAccount": {{Profile(D, "d@example.com", Home, "Home")}}, "savedAt": 1 }""");
Write(paths.Credentials, $$"""{ "claudeAiOauth": {{Tokens("D2", 5000)}}, "mcpOAuth": { "server": "keep-me" } }""");
Write(paths.GlobalConfig, $$"""{ "theme": "dark", "oauthAccount": {{Profile(D, "d@example.com", Work, "Work")}} }""");
view = await accounts.LoadView();
Check("the second organization's login is saved beside the first", RefreshIn(Cli($"{D}.{Work}")) == "refresh-D2" && RefreshIn(Cli(D)) == "refresh-D1");
Check("both are listed, told apart by organization", view.CliName == "d@example.com (Work)" && view.Rows.Any(r => r.Id == D && r.Title == "d@example.com (Home)"));
cliSwitch = await accounts.SwitchCli(D);
Check("switching between them works", cliSwitch.Ok && RefreshIn(paths.Credentials) == "refresh-D1"
    && Read(paths.GlobalConfig)["oauthAccount"]!["organizationUuid"]!.GetValue<string>() == Home);
Check("and keeps the other", RefreshIn(Cli($"{D}.{Work}")) == "refresh-D2");

// A login file another program holds is left alone.
before = File.ReadAllText(paths.Credentials);
using (new FileStream(paths.Credentials, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
{
    cliSwitch = await accounts.SwitchCli(B);
}
Check("a CLI switch with an unreadable login file is refused", !cliSwitch.Ok && cliSwitch.Problem?.Contains("could not be read") == true);
Check("and writes nothing", File.ReadAllText(paths.Credentials) == before);

// A placeholder for a login with no profile beside it holds none, rather than
// a null the mod would copy into .claude.json.
Write(paths.GlobalConfig, """{ "theme": "dark" }""");
Write(paths.Credentials, $$"""{ "claudeAiOauth": {{Tokens("E")}} }""");
var placeholder = await accounts.SaveCurrentCli();
Check("a placeholder with no profile has no profile key", placeholder is not null && !Read(Cli(placeholder)).ContainsKey("oauthAccount"));

Check("removing reports no problem", await accounts.Forget(A) is null);
view = await accounts.LoadView();
Check("removing deletes the saved logins", !File.Exists(Cli(A)) && !Directory.Exists(Path.Combine(store, "desktop", A)));
Check("and the row", view.Rows.All(r => r.Id != A));

Directory.Delete(root, recursive: true);
Console.WriteLine(failed == 0 ? "All passed." : $"{failed} failed.");

return failed == 0 ? 0 : 1;
