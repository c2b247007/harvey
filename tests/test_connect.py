"""`sellbird connect` and the Claude desktop target.

Every test points the home folder, APPDATA, CODEX_HOME and `which` into
tmp_path and uses a fake runner, so nothing here can touch a real agent config.
"""

import json
import tomllib
from datetime import datetime
from pathlib import Path

import pytest

from sellbird import connect
from sellbird import mcp_install as mi

NOW = datetime(2026, 11, 24, 9, 30, 0)


def no_cli(_name):
    return None


def never_run(argv, **kwargs):
    raise AssertionError(f"ran {argv}")


def desktop_file(home: Path) -> Path:
    return home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"


def make_desktop(home: Path, doc=None) -> Path:
    path = desktop_file(home)
    path.parent.mkdir(parents=True)
    if doc is not None:
        path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def backups(folder: Path):
    return sorted(p.name for p in folder.iterdir() if ".sellbird-backup-" in p.name)


def run(home, *, answer="y", yes=False, target=None, remove=False, tty=True, which=no_cli):
    lines = []
    code = connect.run_command(target, remove=remove, yes=yes, home=home,
                               env={"CODEX_HOME": str(home / ".codex")}, which=which,
                               runner=never_run, platform="darwin", isatty=lambda: tty,
                               ask=lambda q: answer, out=lines.append, now=NOW)
    return code, "\n".join(lines)


# ── Claude desktop target ──

def test_desktop_path_per_platform(tmp_path):
    assert mi.desktop_config_path(env={}, home=tmp_path, platform="darwin") == desktop_file(tmp_path)
    assert mi.desktop_config_path(env={"APPDATA": str(tmp_path / "Roaming")}, home=tmp_path,
                                  platform="win32") == \
        tmp_path / "Roaming" / "Claude" / "claude_desktop_config.json"
    assert mi.desktop_config_path(env={}, home=tmp_path, platform="linux") == \
        tmp_path / ".config" / "Claude" / "claude_desktop_config.json"


def test_desktop_merge_keeps_other_servers_and_settings(tmp_path):
    other = {"command": "/Applications/Other.app/bin/other", "args": ["--mcp"],
             "env": {"OTHER_KEY": "keep-me"}}
    path = make_desktop(tmp_path, {"mcpServers": {"other": other},
                                   "preferences": {"theme": "dark"}})
    change = mi.plan_claude_desktop(env={}, home=tmp_path, platform="darwin")
    assert change.action == "add"
    assert all(line.startswith("+") for line in change.preview.splitlines())

    message = mi.apply_change(change, now=NOW)
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["preferences"] == {"theme": "dark"}
    assert doc["mcpServers"]["other"] == other
    assert doc["mcpServers"]["sellbird"] == mi.server_entry()
    assert backups(path.parent) == ["claude_desktop_config.json.sellbird-backup-20261124093000"]
    assert "Quit Claude desktop completely" in message


def test_desktop_without_a_config_file_gets_one(tmp_path):
    path = make_desktop(tmp_path)
    change = mi.plan_claude_desktop(env={}, home=tmp_path, platform="darwin")
    assert change.action == "add"
    mi.apply_change(change, now=NOW)
    assert json.loads(path.read_text(encoding="utf-8")) == \
        {"mcpServers": {"sellbird": mi.server_entry()}}
    assert backups(path.parent) == []


def test_desktop_not_installed_is_refused(tmp_path):
    change = mi.plan_claude_desktop(env={}, home=tmp_path, platform="darwin")
    assert change.action == "refuse"
    assert change.reason == mi.REFUSE_NO_DESKTOP
    assert not desktop_file(tmp_path).parent.exists()


def test_desktop_foreign_sellbird_is_refused(tmp_path):
    hosted = {"command": "npx", "args": ["mcp-remote", "https://app.example.com/mcp"]}
    path = make_desktop(tmp_path, {"mcpServers": {"sellbird": hosted}})
    before = path.read_bytes()
    change = mi.plan_claude_desktop(env={}, home=tmp_path, platform="darwin")
    assert change.action == "refuse"
    assert change.reason == mi.REFUSE_FOREIGN_DESKTOP
    uninstall = mi.plan_uninstall_claude_desktop(env={}, home=tmp_path, platform="darwin")
    assert uninstall.action == "refuse"
    assert path.read_bytes() == before
    assert backups(path.parent) == []


def test_desktop_bad_json_is_left_alone(tmp_path):
    path = make_desktop(tmp_path)
    path.write_bytes(b'{"mcpServers": {oops')
    change = mi.plan_claude_desktop(env={}, home=tmp_path, platform="darwin")
    assert change.action == "refuse"
    assert change.reason == mi.REFUSE_BAD_DESKTOP_JSON
    assert path.read_bytes() == b'{"mcpServers": {oops'


def test_desktop_symlink_is_left_alone(tmp_path):
    real = tmp_path / "elsewhere.json"
    real.write_text("{}", encoding="utf-8")
    path = make_desktop(tmp_path)
    path.symlink_to(real)
    change = mi.plan_claude_desktop(env={}, home=tmp_path, platform="darwin")
    assert change.action == "refuse"
    assert "symlink" in change.reason
    assert real.read_text(encoding="utf-8") == "{}"


def test_desktop_remove_takes_only_ours(tmp_path):
    other = {"command": "node", "args": ["x.js"]}
    path = make_desktop(tmp_path, {"mcpServers": {"other": other, "sellbird": mi.server_entry()}})
    change = mi.plan_uninstall_claude_desktop(env={}, home=tmp_path, platform="darwin")
    assert change.action == "remove"
    assert "Removed Sellbird from Claude desktop." in mi.apply_change(change, now=NOW)
    assert json.loads(path.read_text(encoding="utf-8")) == {"mcpServers": {"other": other}}


def test_desktop_failed_verify_restores_original(tmp_path, monkeypatch):
    path = make_desktop(tmp_path, {"mcpServers": {"other": {"command": "x"}}})
    before = path.read_bytes()
    change = mi.plan_claude_desktop(env={}, home=tmp_path, platform="darwin")
    monkeypatch.setattr(mi, "_claude_parts", lambda text: ({"changed": True}, None))
    with pytest.raises(mi.InstallVerifyFailed):
        mi.apply_change(change, now=NOW)
    assert path.read_bytes() == before


def test_desktop_entry_holds_no_token_and_names_the_home(tmp_path):
    path = make_desktop(tmp_path, {})
    mi.apply_change(mi.plan_claude_desktop(env={}, home=tmp_path, platform="darwin"), now=NOW)
    text = path.read_text(encoding="utf-8")
    entry = json.loads(text)["mcpServers"]["sellbird"]
    assert "token" not in text.lower()
    assert entry["env"] == {"SELLBIRD_HOME": str(mi.PROJECT_ROOT)}


def test_sellbird_home_is_written_into_every_entry(tmp_path, monkeypatch):
    elsewhere = tmp_path / "demo-home"
    monkeypatch.setattr(mi, "PROJECT_ROOT", elsewhere)
    make_desktop(tmp_path, {})
    code, _ = run(tmp_path, yes=True, target="claude-desktop")
    assert code == 0
    entry = json.loads(desktop_file(tmp_path).read_text(encoding="utf-8"))["mcpServers"]["sellbird"]
    assert entry["env"]["SELLBIRD_HOME"] == str(elsewhere)


def test_mcp_install_claude_desktop_shares_the_code(tmp_path):
    # `sellbird mcp install` looks where Claude desktop keeps its settings on this
    # computer, so the test puts the file there, on Mac, Windows and Linux alike.
    env = {"CODEX_HOME": str(tmp_path / ".codex")}
    path = mi.desktop_config_path(env=env, home=tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text("{}", encoding="utf-8")
    lines = []
    code = mi.run_command("install", "claude-desktop", yes=True, home=tmp_path,
                          env=env, which=no_cli,
                          runner=never_run, out=lines.append, now=NOW)
    assert code == 0
    assert "Added Sellbird to Claude desktop." in "\n".join(lines)


# ── sellbird connect ──

def test_detect_finds_each_agent(tmp_path):
    env = {"CODEX_HOME": str(tmp_path / ".codex")}
    assert connect.detect(home=tmp_path, env=env, which=no_cli, platform="darwin") == []
    (tmp_path / ".claude.json").write_text("{}", encoding="utf-8")
    make_desktop(tmp_path)
    (tmp_path / ".codex").mkdir()
    assert connect.detect(home=tmp_path, env=env, which=no_cli, platform="darwin") == \
        ["claude", "claude_desktop", "codex"]


def test_nothing_found_changes_nothing(tmp_path):
    code, text = run(tmp_path)
    assert code == 1
    assert "No agent found" in text
    assert list(tmp_path.iterdir()) == []


def test_connect_adds_all_on_one_yes(tmp_path):
    (tmp_path / ".claude.json").write_text(json.dumps({"mcpServers": {"x": {"command": "x"}}}),
                                           encoding="utf-8")
    desktop = make_desktop(tmp_path, {"mcpServers": {"y": {"command": "y"}}})
    (tmp_path / ".codex").mkdir()
    (tmp_path / ".codex" / "config.toml").write_text('model = "m"\n', encoding="utf-8")
    asked = []

    lines = []
    code = connect.run_command(None, home=tmp_path, env={"CODEX_HOME": str(tmp_path / ".codex")},
                               which=no_cli, runner=never_run, platform="darwin",
                               isatty=lambda: True, ask=lambda q: asked.append(q) or "y",
                               out=lines.append, now=NOW)
    text = "\n".join(lines)
    assert code == 0
    assert asked == ["Add Sellbird to these? [y/N] "]
    assert "Connect Sellbird to: Claude Code, Claude desktop, Codex" in text
    assert "no key or token goes into any config" in text
    claude = json.loads((tmp_path / ".claude.json").read_text(encoding="utf-8"))
    assert claude["mcpServers"] == {"x": {"command": "x"}, "sellbird": mi.server_entry()}
    assert json.loads(desktop.read_text(encoding="utf-8"))["mcpServers"]["sellbird"] == \
        mi.server_entry()
    codex = tomllib.loads((tmp_path / ".codex" / "config.toml").read_text(encoding="utf-8"))
    assert codex["model"] == "m" and codex["mcp_servers"]["sellbird"] == mi.server_entry()
    assert "Claude desktop, quit it completely" in text
    assert "Use Codex" in text and "sellbird connect --remove" in text

    # Again: nothing to do, nothing asked, no new backups.
    before = backups(tmp_path)
    code, text = run(tmp_path)
    assert code == 0
    assert "connected already" in text
    assert backups(tmp_path) == before


def test_a_no_changes_nothing(tmp_path):
    path = make_desktop(tmp_path, {"mcpServers": {}})
    before = path.read_bytes()
    code, text = run(tmp_path, answer="n")
    assert code == 1
    assert "Nothing was changed." in text
    assert path.read_bytes() == before
    assert backups(path.parent) == []


def test_no_terminal_needs_yes(tmp_path):
    path = make_desktop(tmp_path, {})
    code, text = run(tmp_path, tty=False)
    assert code == 2
    assert mi.NOT_TTY in text
    assert json.loads(path.read_text(encoding="utf-8")) == {}


def test_a_foreign_entry_in_one_agent_does_not_stop_the_others(tmp_path):
    hosted = {"type": "http", "url": "https://app.example.com/mcp"}
    (tmp_path / ".claude.json").write_text(json.dumps({"mcpServers": {"sellbird": hosted}}),
                                           encoding="utf-8")
    desktop = make_desktop(tmp_path, {})
    code, text = run(tmp_path)
    assert code == 1                                   # something was skipped: say so
    assert "Claude Code: skipped." in text
    assert json.loads((tmp_path / ".claude.json").read_text(encoding="utf-8")) == \
        {"mcpServers": {"sellbird": hosted}}
    assert json.loads(desktop.read_text(encoding="utf-8"))["mcpServers"]["sellbird"] == \
        mi.server_entry()


def test_one_agent_by_name(tmp_path):
    (tmp_path / ".claude.json").write_text("{}", encoding="utf-8")
    desktop = make_desktop(tmp_path, {})
    code, text = run(tmp_path, target="claude-desktop", yes=True)
    assert code == 0
    assert "Connect Sellbird to: Claude desktop" in text
    assert json.loads((tmp_path / ".claude.json").read_text(encoding="utf-8")) == {}
    assert "sellbird" in json.loads(desktop.read_text(encoding="utf-8"))["mcpServers"]


def test_remove_takes_it_out_everywhere(tmp_path):
    desktop = make_desktop(tmp_path, {"mcpServers": {"other": {"command": "o"}}})
    (tmp_path / ".codex").mkdir()
    run(tmp_path, yes=True)
    code, text = run(tmp_path, remove=True, yes=True)
    assert code == 0
    assert "Remove Sellbird from: Claude desktop, Codex" in text
    assert json.loads(desktop.read_text(encoding="utf-8")) == \
        {"mcpServers": {"other": {"command": "o"}}}
    codex = tomllib.loads((tmp_path / ".codex" / "config.toml").read_text(encoding="utf-8"))
    assert "sellbird" not in codex.get("mcp_servers", {})


def test_setup_offer_is_silent_without_agents(tmp_path):
    lines = []
    assert connect.offer(out=lines.append, home=tmp_path,
                         env={"CODEX_HOME": str(tmp_path / ".codex")}, which=no_cli,
                         platform="darwin") is None
    assert lines == []


def test_setup_offer_shows_the_change_and_asks(tmp_path):
    desktop = make_desktop(tmp_path, {})
    lines, asked = [], []
    code = connect.offer(out=lines.append, home=tmp_path,
                         env={"CODEX_HOME": str(tmp_path / ".codex")}, which=no_cli,
                         runner=never_run, platform="darwin", isatty=lambda: True,
                         ask=lambda q: asked.append(q) or "n", now=NOW)
    assert code == 1
    assert asked == ["Add Sellbird to Claude desktop? [y/N] "]
    assert "+ " in "\n".join(lines)
    assert "Later: sellbird connect" in lines
    assert json.loads(desktop.read_text(encoding="utf-8")) == {}


def test_replacing_a_sellbird_with_another_folder_says_so(tmp_path):
    theirs = {**mi.server_entry(), "env": {"SELLBIRD_HOME": str(tmp_path / "real-home")}}
    path = make_desktop(tmp_path, {"mcpServers": {"sellbird": theirs}})
    code, text = run(tmp_path, answer="n")
    assert code == 1
    assert f"uses a Sellbird with another folder ({tmp_path / 'real-home'})" in text
    assert json.loads(path.read_text(encoding="utf-8"))["mcpServers"]["sellbird"] == theirs


def test_remove_everywhere_leaves_another_install_alone(tmp_path):
    theirs = {**mi.server_entry(), "env": {"SELLBIRD_HOME": str(tmp_path / "real-home")}}
    (tmp_path / ".claude.json").write_text(json.dumps({"mcpServers": {"sellbird": theirs}}),
                                           encoding="utf-8")
    desktop = make_desktop(tmp_path, {"mcpServers": {"sellbird": mi.server_entry()}})
    code, text = run(tmp_path, remove=True, yes=True)
    assert code == 0
    assert "Claude Code: left alone: it uses a Sellbird with another folder" in text
    assert json.loads((tmp_path / ".claude.json").read_text(encoding="utf-8")) == \
        {"mcpServers": {"sellbird": theirs}}
    assert json.loads(desktop.read_text(encoding="utf-8")) == {"mcpServers": {}}

    # Named, it goes.
    code, _ = run(tmp_path, target="claude", remove=True, yes=True)
    assert code == 0
    assert json.loads((tmp_path / ".claude.json").read_text(encoding="utf-8")) == {"mcpServers": {}}


# ── The dashboard's buttons ──

def states(home):
    return connect.agent_states(home=home, env={"CODEX_HOME": str(home / ".codex")},
                                which=no_cli, runner=never_run, platform="darwin")


def click(home, agent, action):
    return connect.apply_one(agent, action, home=home, env={"CODEX_HOME": str(home / ".codex")},
                             which=no_cli, runner=never_run, platform="darwin", now=NOW)


def test_rows_show_each_state_and_one_button(tmp_path):
    theirs = {**mi.server_entry(), "env": {"SELLBIRD_HOME": str(tmp_path / "real-home")}}
    (tmp_path / ".claude.json").write_text(json.dumps({"mcpServers": {"sellbird": theirs}}),
                                           encoding="utf-8")
    make_desktop(tmp_path, {})
    (tmp_path / ".codex").mkdir()
    got = {r["agent"]: (r["state"], r["action"]) for r in states(tmp_path)}
    assert got == {"claude": ("elsewhere", "reconnect"),
                   "claude-desktop": ("not_connected", "connect"),
                   "codex": ("not_connected", "connect")}

    done = click(tmp_path, "claude-desktop", "connect")
    assert done["success"] and "Quit Claude desktop" in done["next"]
    assert {r["agent"]: r["state"] for r in states(tmp_path)}["claude-desktop"] == "connected"
    assert click(tmp_path, "claude-desktop", "remove")["success"]
    assert json.loads(desktop_file(tmp_path).read_text(encoding="utf-8")) == {"mcpServers": {}}


def test_a_moved_install_reconnects(tmp_path):
    old = {**mi.server_entry(), "command": "/old/place/bin/python"}
    path = make_desktop(tmp_path, {"mcpServers": {"sellbird": old}})
    [row] = states(tmp_path)
    assert (row["state"], row["action"]) == ("moved", "reconnect")
    assert click(tmp_path, "claude-desktop", "reconnect")["success"]
    assert json.loads(path.read_text(encoding="utf-8"))["mcpServers"]["sellbird"] == mi.server_entry()


def test_a_foreign_entry_shows_why_and_no_button(tmp_path):
    hosted = {"type": "http", "url": "https://app.example.com/mcp"}
    path = make_desktop(tmp_path, {"mcpServers": {"sellbird": hosted}})
    [row] = states(tmp_path)
    assert (row["state"], row["action"]) == ("blocked", "")
    assert row["detail"] == mi.REFUSE_FOREIGN_DESKTOP
    assert click(tmp_path, "claude-desktop", "connect") == \
        {"success": False, "message": mi.REFUSE_FOREIGN_DESKTOP}
    assert json.loads(path.read_text(encoding="utf-8"))["mcpServers"]["sellbird"] == hosted


def test_unknown_agent_or_action_does_nothing(tmp_path):
    assert not click(tmp_path, "cursor", "connect")["success"]
    assert not click(tmp_path, "codex", "delete")["success"]


def test_a_moved_folder_is_reconnect_not_another_install(tmp_path):
    gone = {"command": str(tmp_path / "old-copy" / ".venv" / "bin" / "python"),
            "args": ["-P", "-m", "sellbird", "mcp"],
            "env": {"SELLBIRD_HOME": str(tmp_path / "old-copy")}}
    make_desktop(tmp_path, {"mcpServers": {"sellbird": gone}})
    [row] = states(tmp_path)
    assert (row["state"], row["action"]) == ("moved", "reconnect")


# ── Windows, tested on any OS ──

WIN_PY = "C:\\Users\\Sam O'Neil\\Projects\\sellbird\\.venv\\Scripts\\python.exe"
WIN_HOME = "C:\\Users\\Sam O'Neil\\Projects\\sellbird"


@pytest.fixture
def windows_entry(monkeypatch):
    entry = {"command": WIN_PY, "args": ["-P", "-m", "sellbird", "mcp"],
             "env": {"SELLBIRD_HOME": WIN_HOME}}
    monkeypatch.setattr(mi, "server_entry", lambda: json.loads(json.dumps(entry)))
    return entry


def test_windows_desktop_path_store_build_and_classic(tmp_path):
    env = {"APPDATA": str(tmp_path / "Roaming"), "LOCALAPPDATA": str(tmp_path / "Local")}
    classic = tmp_path / "Roaming" / "Claude" / "claude_desktop_config.json"
    assert mi.desktop_config_path(env=env, home=tmp_path, platform="win32") == classic
    store = tmp_path / "Local" / "Packages" / "Claude_pzs8sxrjxfjjc" / "LocalCache" / "Roaming" / "Claude"
    store.mkdir(parents=True)
    assert mi.desktop_config_path(env=env, home=tmp_path, platform="win32") == \
        store / "claude_desktop_config.json"
    assert mi.desktop_detected(env=env, home=tmp_path, platform="win32")
    # Two store packages: don't guess, use the classic place.
    (tmp_path / "Local" / "Packages" / "Claude_other" / "LocalCache" / "Roaming" / "Claude").mkdir(parents=True)
    assert mi.desktop_config_path(env=env, home=tmp_path, platform="win32") == classic


def test_windows_npm_cmd_shim_edits_the_file_not_through_cmd(tmp_path):
    (tmp_path / ".claude.json").write_text("{}", encoding="utf-8")
    shim = lambda name: "C:\\Users\\Sam\\AppData\\Roaming\\npm\\claude.cmd"  # noqa: E731
    change = mi.plan_claude(home=tmp_path, which=shim, runner=never_run)
    assert change.action == "add" and change.argv == ()
    mi.apply_change(change, runner=never_run, now=NOW)
    assert json.loads((tmp_path / ".claude.json").read_text(encoding="utf-8"))["mcpServers"]["sellbird"] == \
        mi.server_entry()
    # An .exe takes the argument as is: the CLI is used.
    exe = mi.plan_claude(home=tmp_path, which=lambda n: "C:\\tools\\claude.exe", runner=never_run)
    assert exe.action == "none"


def test_windows_paths_survive_json_and_toml(tmp_path, windows_entry):
    desktop = make_desktop(tmp_path, {})
    (tmp_path / ".codex").mkdir()
    code, _ = run(tmp_path, yes=True)
    assert code == 0
    assert json.loads(desktop.read_text(encoding="utf-8"))["mcpServers"]["sellbird"] == windows_entry
    codex = tomllib.loads((tmp_path / ".codex" / "config.toml").read_text(encoding="utf-8"))
    assert codex["mcp_servers"]["sellbird"] == windows_entry
    assert states(tmp_path)[0]["state"] == "connected"


def test_windows_line_endings_and_byte_order_mark_are_kept(tmp_path):
    desktop = make_desktop(tmp_path)
    desktop.write_bytes(b'\xef\xbb\xbf{\r\n  "mcpServers": {\r\n    "other": {"command": "o"}\r\n  }\r\n}\r\n')
    (tmp_path / ".codex").mkdir()
    toml = tmp_path / ".codex" / "config.toml"
    toml.write_bytes(b'model = "m"\r\n\r\n[mcp_servers.other]\r\ncommand = "o"\r\n')
    code, _ = run(tmp_path, yes=True)
    assert code == 0
    for path in (desktop, toml):
        data = path.read_bytes()
        assert b"\n" not in data.replace(b"\r\n", b""), path.name     # CRLF only
    assert desktop.read_bytes().startswith(b"\xef\xbb\xbf")
    assert not toml.read_bytes().startswith(b"\xef\xbb\xbf")
    doc = json.loads(desktop.read_bytes().decode("utf-8-sig"))
    assert doc["mcpServers"]["other"] == {"command": "o"}
    # And it reads back as connected, then comes out cleanly.
    assert {r["agent"]: r["state"] for r in states(tmp_path)} == \
        {"claude-desktop": "connected", "codex": "connected"}
    code, _ = run(tmp_path, remove=True, yes=True)
    assert code == 0
    assert tomllib.loads(toml.read_bytes().decode("utf-8")) == \
        {"model": "m", "mcp_servers": {"other": {"command": "o"}}}


def test_a_file_held_open_by_another_app_is_left_as_it_was(tmp_path, monkeypatch):
    desktop = make_desktop(tmp_path, {"mcpServers": {"other": {"command": "o"}}})
    before = desktop.read_bytes()

    def locked(src, dst):
        raise PermissionError(13, "The process cannot access the file")
    monkeypatch.setattr(mi.os, "replace", locked)
    monkeypatch.setattr("time.sleep", lambda s: None)
    result = click(tmp_path, "claude-desktop", "connect")
    assert not result["success"]
    assert "open in another app" in result["message"] and "Nothing was changed" in result["message"]
    assert desktop.read_bytes() == before
    assert [p.name for p in desktop.parent.iterdir() if p.name.endswith(".tmp")] == []


def test_replace_retries_then_says_it_is_locked(tmp_path, monkeypatch):
    target = tmp_path / "f.json"
    target.write_text("{}", encoding="utf-8")
    tmp = tmp_path / "t"
    tmp.write_text("{}", encoding="utf-8")
    tries = []

    def locked(src, dst):
        tries.append(1)
        raise PermissionError(13, "locked")
    monkeypatch.setattr(mi.os, "replace", locked)
    with pytest.raises(mi.FileLocked):
        mi._replace(str(tmp), target, tries=3, wait=0)
    assert len(tries) == 3
