"""`sellbird connect`: put Sellbird into every agent on this machine in one step.

It finds Claude Code, Claude desktop and Codex (the Codex CLI and the Codex
app share ~/.codex/config.toml), shows what it will add to each, and adds them
all on one yes. `sellbird connect claude-desktop` (or `claude`, `codex`) does
one; `--remove` takes Sellbird out again.

The writing is `mcp_install`'s: the same merge, backup, refusal of a Sellbird
entry this command didn't write, re-read and verify. No entry holds a token:
the MCP server reads the agent token from the home folder at runtime, and the
entry names that folder (SELLBIRD_HOME).

ChatGPT and claude.ai's "Add custom connector" connect from the provider's
cloud, so they can't reach a server on this machine. That's said plainly
rather than worked around.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Callable, Mapping

from sellbird import mcp_install as mi
from sellbird.paths import HOME_ENV, PROJECT_ROOT
from sellbird.workspace_home import NotOnHosted, require_self_hosted

TARGETS = ("claude", "claude_desktop", "codex")
NONE_FOUND = ("No agent found on this machine: no Claude Code, no Claude desktop, no Codex.\n"
              "Install one, then run sellbird connect again. To add Sellbird by hand, "
              "sellbird mcp install --print shows the entry.")
CHATGPT_NOTE = ("ChatGPT and claude.ai in a browser can't reach Sellbird on this machine. "
                "Use Codex: it comes with a ChatGPT plan.")
AFTER = {
    "claude": "In Claude Code, start a new session and ask: \"Open Sellbird\".",
    "claude_desktop": ("In Claude desktop, quit it completely and open it again, then ask: "
                       "\"Open Sellbird\"."),
    "codex": "In Codex, start a new session and ask: \"Open Sellbird\".",
}


def detect(*, home: Path, env: Mapping[str, str], which=shutil.which,
           platform: str = sys.platform) -> list[str]:
    """Which agents are on this machine, in the order they're shown."""
    found = []
    if which("claude") or (Path(home) / ".claude.json").exists():
        found.append("claude")
    if mi.desktop_detected(env=env, home=home, platform=platform):
        found.append("claude_desktop")
    if mi._codex_detected(which, env, home):
        found.append("codex")
    return found


def plan(target: str, remove: bool, *, home: Path, env: Mapping[str, str],
         which=shutil.which, runner=subprocess.run,
         platform: str = sys.platform) -> mi.PlannedChange:
    if target == "claude":
        fn = mi.plan_uninstall_claude if remove else mi.plan_claude
        return fn(home=home, which=which, runner=runner)
    if target == "claude_desktop":
        fn = mi.plan_uninstall_claude_desktop if remove else mi.plan_claude_desktop
        return fn(env=env, home=home, platform=platform)
    fn = mi.plan_uninstall_codex if remove else mi.plan_codex
    return fn(env=env, home=home)


def other_home(change: mi.PlannedChange) -> str:
    """The folder an entry being replaced used, when it isn't this one's."""
    try:
        old = json.loads(change.old_json) if change.old_json else None
    except ValueError:
        return ""
    if not isinstance(old, dict) or not isinstance(old.get("env"), dict):
        return ""
    home = str(old["env"].get(HOME_ENV) or "")
    return home if home and home != str(mi.server_entry()["env"][HOME_ENV]) else ""


def install_gone(change: mi.PlannedChange) -> bool:
    """The entry being replaced starts a program that is no longer there:
    that Sellbird was moved or deleted, so Reconnect is the fix."""
    try:
        old = json.loads(change.old_json) if change.old_json else None
    except ValueError:
        return False
    command = str((old or {}).get("command") or "") if isinstance(old, dict) else ""
    looks_absolute = command.startswith(("/", "\\")) or (len(command) > 2 and command[1] == ":")
    return looks_absolute and not Path(command).exists()


def _keep_other_install(change: mi.PlannedChange) -> mi.PlannedChange:
    elsewhere = other_home(change) if change.action in ("remove", "cli") else ""
    if not elsewhere:
        return change
    agent = change.client.replace("_", "-")
    return mi.PlannedChange(change.client, "none", change.path, "",
                            f"left alone: it uses a Sellbird with another folder ({elsewhere}). "
                            f"To remove it anyway: sellbird connect {agent} --remove")


def run_command(target: str | None = None, *, remove: bool = False, yes: bool = False,
                home: Path | None = None, env: Mapping[str, str] | None = None,
                which=shutil.which, runner=subprocess.run, platform: str = sys.platform,
                isatty: Callable[[], bool] | None = None,
                ask: Callable[[str], str] = input, out: Callable[[str], None] = print,
                now: datetime | None = None) -> int:
    """`sellbird connect [claude|claude-desktop|codex] [--remove] [--yes]`.

    0: everything asked for is in place (or nothing needed doing).
    1: something was refused or failed, or the person said no.
    2: changes are waiting and there's no terminal to ask in (use --yes).
    """
    try:
        require_self_hosted("mcp_install")  # a server has no agent to connect
    except NotOnHosted as e:
        out(e.payload["message"])
        return 1
    home = Path.home() if home is None else Path(home)
    env = os.environ if env is None else env
    isatty = isatty or sys.stdin.isatty
    now = now or datetime.now()

    if target:
        targets = [target.replace("-", "_")]
    else:
        targets = detect(home=home, env=env, which=which, platform=platform)
        if not targets:
            out(NONE_FOUND)
            return 1

    changes = [plan(t, remove, home=home, env=env, which=which, runner=runner,
                    platform=platform) for t in targets]
    if remove and not target:
        # Removing from every agent takes out only the entries for this
        # Sellbird: another install's entry stays unless that agent is named.
        changes = [_keep_other_install(c) for c in changes]
    todo = [c for c in changes if c.action not in ("none", "refuse")]

    verb = "Remove Sellbird from" if remove else "Connect Sellbird to"
    names = ", ".join(mi.CLIENT_NAMES[c.client] for c in changes)
    out(f"{verb}: {names}")
    if not remove:
        out(f"Sellbird's folder: {PROJECT_ROOT} (passed as {HOME_ENV}; no key or token "
            "goes into any config).")
    for c in changes:
        name = mi.CLIENT_NAMES[c.client]
        out("")
        if c.action == "refuse":
            out(f"{name}: skipped. {c.reason}")
        elif c.action == "none":
            out(f"{name}: {c.reason or 'already connected.'}")
        else:
            where = "this will run" if c.action == "cli" else str(c.path)
            out(f"{name}: {where}")
            elsewhere = other_home(c)
            if elsewhere:
                out(f"Note: {name} uses a Sellbird with another folder ({elsewhere}). "
                    "This points it at this one instead.")
            out(c.preview)

    failed = any(c.action == "refuse" for c in changes)
    if not todo:
        if not remove and not failed:
            out("")
            out("Everything here is connected already.")
        return 1 if failed else 0

    out("")
    if not yes:
        if not isatty():
            out(mi.NOT_TTY)
            return 2
        question = ("Remove these? [y/N] " if remove else
                    ("Add Sellbird to these? [y/N] " if len(todo) > 1 else
                     f"Add Sellbird to {mi.CLIENT_NAMES[todo[0].client]}? [y/N] "))
        if ask(question).strip().lower() not in ("y", "yes"):
            out("Nothing was changed.")
            return 1

    done = []
    for c in todo:
        try:
            out(mi.apply_change(c, runner=runner, now=now))
            done.append(c.client)
        except mi.InstallError as e:
            out(f"{mi.CLIENT_NAMES[c.client]}: {e}")
            failed = True

    if done and not remove:
        out("")
        out("Next:")
        for client in done:
            out(f"  {AFTER[client]}")
        out(f"  {CHATGPT_NOTE}")
        out("  To take it out again: sellbird connect --remove")
    return 1 if failed else 0


def offer(*, out: Callable[[str], None] = print, **kwargs) -> int | None:
    """The setup wizard's last step: show what connecting would add to the
    agents found here and ask once. None when no agent is found."""
    found = detect(home=kwargs.get("home") or Path.home(), env=kwargs.get("env") or os.environ,
                   which=kwargs.get("which", shutil.which),
                   platform=kwargs.get("platform", sys.platform))
    if not found:
        return None
    out("Sellbird works best inside your agent: ask it to open the dashboard, show what "
        "needs you, or draft a reply.")
    code = run_command(out=out, **kwargs)
    if code != 0:
        out("Later: sellbird connect")
    return code


# ── The dashboard's Connect buttons (Set up, Your agent) ──

LABELS = {"connected": "Connected", "not_connected": "Not connected",
          "elsewhere": "Points at another Sellbird folder", "moved": "Points at an older copy",
          "blocked": "Can't connect"}
BUTTON = {"connected": "remove", "not_connected": "connect", "elsewhere": "reconnect",
          "moved": "reconnect", "blocked": ""}


def agent_states(*, home: Path | None = None, env: Mapping[str, str] | None = None,
                 which=shutil.which, runner=subprocess.run,
                 platform: str = sys.platform) -> list[dict]:
    """One row per agent found here: its state and the one thing to do."""
    home = Path.home() if home is None else Path(home)
    env = os.environ if env is None else env
    rows = []
    for t in detect(home=home, env=env, which=which, platform=platform):
        c = plan(t, False, home=home, env=env, which=which, runner=runner, platform=platform)
        detail = ""
        if c.action == "none":
            state = "connected"
        elif c.action == "refuse":
            state, detail = "blocked", c.reason
        elif c.old_json:
            elsewhere = "" if install_gone(c) else other_home(c)
            state = "elsewhere" if elsewhere else "moved"
            detail = elsewhere
        else:
            state = "not_connected"
        rows.append({"agent": t.replace("_", "-"), "name": mi.CLIENT_NAMES[t], "state": state,
                     "label": LABELS[state], "detail": detail, "action": BUTTON[state],
                     "next": AFTER[t]})
    return rows


def apply_one(agent: str, action: str, *, home: Path | None = None,
              env: Mapping[str, str] | None = None, which=shutil.which,
              runner=subprocess.run, platform: str = sys.platform,
              now: datetime | None = None) -> dict:
    """What a Connect, Reconnect or Remove click does: plan that one change
    and make it with mcp_install's own code. Never raises InstallError."""
    target = agent.replace("-", "_")
    if target not in TARGETS or action not in ("connect", "reconnect", "remove"):
        return {"success": False, "message": "Unknown agent or action."}
    home = Path.home() if home is None else Path(home)
    env = os.environ if env is None else env
    c = plan(target, action == "remove", home=home, env=env, which=which, runner=runner,
             platform=platform)
    name = mi.CLIENT_NAMES[target]
    if c.action == "refuse":
        return {"success": False, "message": c.reason}
    if c.action == "none":
        return {"success": True, "message": c.reason or f"{name} is connected already.",
                "next": "" if action == "remove" else AFTER[target]}
    try:
        message = mi.apply_change(c, runner=runner, now=now or datetime.now())
    except mi.InstallError as e:
        return {"success": False, "message": str(e)}
    nxt = {"claude": "Start a new Claude Code session.",
           "claude_desktop": "Quit Claude desktop completely and open it again.",
           "codex": "Start a new Codex session."}[target]
    return {"success": True, "message": message, "next": nxt}
