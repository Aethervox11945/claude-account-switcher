// Runs the account logic and the real swap script against a throwaway profile.
// Nothing here touches the real Claude app or your real logins: every path is
// under a temp folder, and the script only closes executables matching a
// pattern nothing matches.

using System.Text.Json.Nodes;
using AccountSwitcher.Core;

const string A = "11111111-1111-4111-8111-111111111111";
const string B = "22222222-2222-4222-8222-222222222222";

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
string Tokens(string who) => $$"""{ "accessToken": "access-{{who}}", "refreshToken": "refresh-{{who}}", "expiresAt": 1000 }""";
string Profile(string id, string email) => $$"""{ "accountUuid": "{{id}}", "emailAddress": "{{email}}", "organizationName": "{{email}} org" }""";
string Snapshot(string who, string id, string email) => $$"""{ "claudeAiOauth": {{Tokens(who)}}, "oauthAccount": {{Profile(id, email)}}, "savedAt": 1 }""";

var data = Path.Combine(root, "desktop-data");
var store = Path.Combine(root, ".claude", "account-switcher");
var paths = new Paths(Path.Combine(root, ".claude", ".credentials.json"), Path.Combine(root, ".claude.json"), store, data);
var config = Path.Combine(data, "config.json");
var cookies = Path.Combine(data, "Network", "Cookies");

Write(paths.Credentials, $$"""{ "claudeAiOauth": {{Tokens("A")}}, "mcpOAuth": { "server": "keep-me" } }""");
Write(paths.GlobalConfig, $$"""{ "theme": "dark", "note": "é → kept", "oauthAccount": {{Profile(A, "a@example.com")}} }""");
Write(Path.Combine(store, "cli", $"{A}.json"), Snapshot("A", A, "a@example.com"));
Write(Path.Combine(store, "cli", $"{B}.json"), Snapshot("B", B, "b@example.com"));
Write(Path.Combine(store, "accounts.json"), $$"""{ "accounts": { "{{A}}": { "email": "a@example.com" }, "{{B}}": { "email": "b@example.com" } } }""");
Write(config, $$"""{ "locale": "en", "oauth:tokenCache": "enc-A", "lastKnownAccountUuid": "{{A}}" }""");
Write(cookies, "cookies-of-A");
Write(Path.Combine(store, "desktop", B, "auth.json"), $$"""{ "savedAt": 1, "oauth:tokenCache": "enc-B", "lastKnownAccountUuid": "{{B}}" }""");
Write(Path.Combine(store, "desktop", B, "Cookies"), "cookies-of-B");

var accounts = new AccountStore(paths);

var view = await accounts.LoadView();
Check("lists both accounts", view.Rows.Count == 2);
Check("sees who the app and CLI are on", view.DesktopName == "a@example.com" && view.CliName == "a@example.com");
Check("the account in use comes first", view.Rows[0].Uuid == A && view.Rows[0].IsCliActive && view.Rows[0].IsDesktopActive);
Check("the other account can be switched to", view.Rows[1].HasCli && view.Rows[1].HasDesktop);

// A token refresh since the last save must survive the switch.
Write(paths.Credentials, $$"""{ "claudeAiOauth": { "accessToken": "access-A2", "refreshToken": "refresh-A", "expiresAt": 1000 }, "mcpOAuth": { "server": "keep-me" } }""");
Check("CLI switch reports no problem", await accounts.SwitchCli(B) is null);
var credentials = Read(paths.Credentials);
Check("CLI login is B's", credentials["claudeAiOauth"]!["refreshToken"]!.GetValue<string>() == "refresh-B");
Check("MCP tokens stay", credentials["mcpOAuth"]!["server"]!.GetValue<string>() == "keep-me");
var global = Read(paths.GlobalConfig);
Check("CLI profile is B's", global["oauthAccount"]!["accountUuid"]!.GetValue<string>() == B);
Check("other settings stay", global["theme"]!.GetValue<string>() == "dark");
Check("non-ASCII text stays readable", File.ReadAllText(paths.GlobalConfig).Contains("é → kept"));
Check("A's newest tokens are saved", Read(Path.Combine(store, "cli", $"{A}.json"))["claudeAiOauth"]!["accessToken"]!.GetValue<string>() == "access-A2");

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

var swap = await accounts.SwapDesktop("switch", B);
Check($"app switch succeeds ({swap.Error})", swap.Ok);
Check("a chat only A had comes across", File.ReadAllText(Path.Combine(chatsOfB, "local_only-a.json")) == "from A");
Check("a newer copy replaces an older one", File.ReadAllText(Path.Combine(chatsOfB, "local_newer-in-a.json")) == "newer");
Check("an older copy replaces nothing", File.ReadAllText(Path.Combine(chatsOfB, "local_newer-in-b.json")) == "newer");
Check("the replaced copy is backed up", Directory.GetFiles(Path.Combine(store, "chat-backups"), "local_newer-in-a.json", SearchOption.AllDirectories).Length == 1);
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

Check("bringing chats along is on by default", accounts.SyncChats);
accounts.SyncChats = false;
Chat(chatsOfA, "local_while-off.json", "from A", 1);
swap = await accounts.SwapDesktop("switch", B);
Check("turned off, a switch copies no chats", swap.Ok && !File.Exists(Path.Combine(chatsOfB, "local_while-off.json")));
accounts.SyncChats = true;
swap = await accounts.SwapDesktop("switch", B);
Check("a second pass copies only what's new", swap.Ok && swap.ChatsCopied == 1);

var missing = "33333333-3333-4333-8333-333333333333";
var before = File.ReadAllText(config);
swap = await accounts.SwapDesktop("switch", missing);
Check("switching to an unsaved account fails", !swap.Ok && swap.Error is not null);
Check("and leaves the app alone", File.ReadAllText(config) == before);

accounts.SetLabel(A, "Work");
view = await accounts.LoadView();
Check("a name replaces the email", view.Rows.Any(r => r.Uuid == A && r.Name == "Work" && r.Email == "a@example.com"));
accounts.SetLabel(A, "");
view = await accounts.LoadView();
Check("an empty name goes back to the email", view.Rows.Any(r => r.Uuid == A && r.Name == "a@example.com"));

swap = await accounts.SwapDesktop("new");
Check("signing out for a new account succeeds", swap.Ok);
after = Read(config);
Check("no sign-in is left in the app", !after.ContainsKey("oauth:tokenCache") && !after.ContainsKey("lastKnownAccountUuid"));
Check("no cookies are left", !File.Exists(cookies));
view = await accounts.LoadView();
Check("the app shows as signed out", view.DesktopName is null && view.Rows.Any(r => r.Uuid == B && r.HasDesktop));

// A login no saved copy matches, with an expired token, can't be identified.
Write(paths.Credentials, $$"""{ "claudeAiOauth": {{Tokens("C")}} }""");
var first = await accounts.SaveCurrentCli();
var second = await accounts.SaveCurrentCli();
Check("an unknown login gets a placeholder", first?.StartsWith("unidentified-") == true);
Check("only one", first == second);

accounts.Forget(A);
view = await accounts.LoadView();
Check("removing deletes the saved logins", !File.Exists(Path.Combine(store, "cli", $"{A}.json")) && !Directory.Exists(Path.Combine(store, "desktop", A)));
Check("and the row", view.Rows.All(r => r.Uuid != A));

Directory.Delete(root, recursive: true);
Console.WriteLine(failed == 0 ? "All passed." : $"{failed} failed.");

return failed == 0 ? 0 : 1;
