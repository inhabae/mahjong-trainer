"""Compare app replay snapshots with RiichiEnv on the known hatsu-pon bug.

Run from ``backend/``. Install the external tools first:

    # RiichiEnv Python package
    pip install riichienv
    # Build mjai-reviewer (including its convlog converter) from upstream
    git clone https://github.com/Equim-chan/mjai-reviewer.git /tmp/mjai-reviewer
    cd /tmp/mjai-reviewer && cargo build --release
    cd /path/to/mahjong-trainer/backend
    MJAI_REVIEWER_BIN=/tmp/mjai-reviewer/target/release/mjai-reviewer \
      .venv/bin/python scripts/compare_riichienv_replay.py

The script extracts the embedded Tenhou game log for kyoku-4-2, passes that
round through mjai-reviewer's own ``--no-review --mjai-out`` conversion, and
applies the resulting MJAI events one by one. Snapshots use the public
``RiichiEnv`` properties and ``get_observation(player_id)``; ``env.state`` is
an opaque ``GameState`` in the Python binding. Tile IDs are 136-format IDs in
RiichiEnv; only tile type is compared after converting to MPSZ notation, so
red-five identity is omitted.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from app.analysis.reconstruction import reconstruct_report
from app.analysis.tenhou_replay import replay_round
from app.analysis.ukeire import action_tile
from app.parsers.mjai_reviewer import parse_mjai_reviewer_html


FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "65ac5c6e62f357b5.html"
ROUND_ID = "kyoku-4-2"
CALLER = 2
SOURCE = 0
CALLED_TILE = "6z"  # Hatsu in this app's MPSZ notation.
RELEVANT = {"dahai", "reach", "chi", "pon", "daiminkan", "ankan", "kakan"}


def tile_id_to_mpsz(tile_id: int) -> str:
    """Normalize RiichiEnv's 0..135 physical tile ID to app MPSZ notation."""
    tile_type = tile_id // 4
    if not 0 <= tile_type < 34:
        raise ValueError(f"RiichiEnv returned invalid tile id {tile_id}")
    if tile_type < 9:
        return f"{tile_type + 1}m"
    if tile_type < 18:
        return f"{tile_type - 8}p"
    if tile_type < 27:
        return f"{tile_type - 17}s"
    return f"{tile_type - 26}z"


def app_meld(meld: Any) -> dict[str, Any]:
    return {
        "kind": meld.kind,
        "tiles": [normalize_app_tile(tile) for tile in meld.tiles],
        "called_from": meld.called_from,
        "called_tile": normalize_app_tile(meld.called_tile) if meld.called_tile else None,
        "called_index": meld.called_index,
    }


def normalize_app_tile(tile: str) -> str:
    """Normalize report tile glyphs (f/w/c) to the replay's MPSZ names."""
    return {"f": "6z", "w": "7z", "c": "5z"}.get(tile, tile)


def normalize_mjai_tile(tile: str | None) -> str | None:
    """Normalize MJAI's honor initials and red fives to app MPSZ notation."""
    if tile is None:
        return None
    return {"E": "1z", "S": "2z", "W": "3z", "N": "4z",
            "P": "5z", "F": "6z", "C": "7z",
            "5mr": "5m", "5pr": "5p", "5sr": "5s"}.get(tile, tile)


def app_snapshot(players, *, current_actor: int | None, turn: int | None) -> dict[str, Any]:
    return {
        "current_actor": current_actor,
        "turn": turn,
        "players": [
            {
                "seat": player.seat,
                "river": [normalize_app_tile(tile) for tile in player.discards],
                "melds": [app_meld(meld) for meld in player.melds],
                "riichi": player.riichi,
                "riichi_discard_indices": list(player.riichi_discard_indices),
            }
            for player in players
        ],
    }


def riichienv_snapshot(env: Any, analyzed_player: int) -> dict[str, Any]:
    """Read the installed binding's public environment and observation API."""
    # GameState is an opaque pyclass (dir(env.state) is empty). RiichiEnv
    # provides these state properties; the observation API provides the
    # analyzed player's visible hand and a second public state view.
    observation = env.get_observation(analyzed_player)
    discards = env.discards
    melds = env.melds
    riichi_declared = env.riichi_declared
    riichi_stage = env.riichi_stage
    discard_is_riichi = env.discard_is_riichi
    observation_riichi_sutehais = observation.riichi_sutehais
    result_players = []
    for seat, river_ids in enumerate(discards):
        seat_melds = melds[seat]
        result_players.append({
            "seat": seat,
            "river": [tile_id_to_mpsz(int(tile_id)) for tile_id in river_ids],
            "melds": [
                {
                    "kind": str(meld.meld_type).lower().split(".")[-1],
                    "tiles": [tile_id_to_mpsz(int(tile_id)) for tile_id in meld.tiles],
                    "called_from": int(meld.from_who) if meld.from_who >= 0 else None,
                    "called_tile": tile_id_to_mpsz(int(meld.called_tile)) if meld.called_tile is not None else None,
                }
                for meld in seat_melds
            ],
            "riichi": bool(riichi_declared[seat] or riichi_stage[seat]),
            "riichi_declared": bool(riichi_declared[seat]),
            "riichi_stage": bool(riichi_stage[seat]),
            "riichi_discard_indices": [
                index for index, marked in enumerate(discard_is_riichi[seat]) if marked
            ],
            "riichi_discard_markers": list(discard_is_riichi[seat]),
            "riichi_sutehai": (
                tile_id_to_mpsz(int(observation_riichi_sutehais[seat]))
                if observation_riichi_sutehais[seat] is not None else None
            ),
        })
    visible_hand = [tile_id_to_mpsz(int(tile_id)) for tile_id in observation.hand]
    return {
        "current_actor": int(env.current_player),
        "turn": int(env.turn_count),
        "scores": list(observation.scores),
        "dora_indicators": [tile_id_to_mpsz(int(tile_id)) for tile_id in observation.dora_indicators],
        "analyzed_player": int(analyzed_player),
        "visible_hand": visible_hand,
        "players": result_players,
    }


def app_event_label(event: Any) -> tuple[int, str, str | None] | None:
    if event.kind not in {"discard", "riichi", "chi", "pon", "daiminkan", "ankan", "kakan"}:
        return None
    return event.seat, event.kind, event.tile


def mjai_event_label(event: dict[str, Any]) -> tuple[int, str, str | None] | None:
    kind = event.get("type")
    if kind not in RELEVANT:
        return None
    actor = event.get("actor")
    tile = event.get("pai")
    if kind == "reach":
        # The actual declaration discard precedes Reach in convlog. Treat the
        # reach marker as state-relevant but do not count it as a new river tile.
        tile = None
    return int(actor), str(kind), normalize_mjai_tile(str(tile) if tile is not None else None)


def convert_round_with_convlog(game_log: dict[str, Any]) -> list[dict[str, Any]]:
    binary = os.environ.get("MJAI_REVIEWER_BIN") or shutil.which("mjai-reviewer")
    if not binary:
        raise RuntimeError("mjai-reviewer binary not found; set MJAI_REVIEWER_BIN to its executable")
    binary = str(Path(binary).expanduser().resolve())
    with tempfile.TemporaryDirectory(prefix="mjai-pon-replay-") as directory:
        input_path = Path(directory) / "round.json"
        output_path = Path(directory) / "events.jsonl"
        # The embedded report object is convlog's expected enclosing Tenhou log.
        input_path.write_text(json.dumps(game_log, ensure_ascii=False), encoding="utf-8")
        subprocess.run(
            [binary, "--no-review", "-i", str(input_path), "--mjai-out", str(output_path)],
            check=True,
        )
        events = [
            json.loads(line)
            for line in output_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    # Retain exactly the target kyoku and convlog's start_game event. The
    # fixture embeds a one-round Tenhou log identified by East/South labels.
    selected: list[dict[str, Any]] = []
    in_target = False
    for event in events:
        if event.get("type") == "start_kyoku":
            in_target = (event.get("bakaze") == "S" and event.get("kyoku") == 1
                         and event.get("honba") == 2 and event.get("oya") == 0)
            if in_target:
                selected.append(event)
            continue
        if event.get("type") == "start_game":
            selected.append(event)
            continue
        if in_target:
            selected.append(event)
            if event.get("type") in {"end_kyoku", "ryukyoku", "hora"}:
                in_target = False
    if not any(event.get("type") == "start_kyoku" for event in selected):
        raise RuntimeError(f"convlog output did not contain target round {ROUND_ID}")
    return selected


def current_app_timeline(round_, analyzed_player: int) -> list[dict[str, Any]]:
    replay = replay_round(round_.original_game_log, analyzed_player)
    timeline = []
    for index, event in enumerate(replay.events):
        if event.kind not in {"discard", "riichi", "chi", "pon", "daiminkan", "ankan", "kakan"}:
            continue
        timeline.append({
            "index": index,
            "label": {"actor": event.seat, "action": event.kind, "tile": event.tile},
            "state": app_snapshot(
                replay.event_snapshots[index],
                current_actor=(event.seat if event.kind in {"chi", "pon", "daiminkan"}
                               else (event.seat + 1) % 4),
                turn=sum(item.kind in {"discard", "riichi"} for item in replay.events[:index + 1]),
            ),
        })
    return timeline


def app_report_decision_state(report, round_id: str) -> dict[str, Any] | None:
    """Pick the current app's next reported decision state after the pon."""
    decisions = [item for item in reconstruct_report(report).decisions if item.round_id == round_id]
    target = next((i for i, item in enumerate(decisions)
                   if item.actual_action and item.actual_action.lower().startswith("pon ")
                   and item.state.call_tile in {CALLED_TILE, "f"}), None)
    if target is None:
        return None
    next_decision = next((item for item in decisions[target + 1:]
                          if item.actual_action and item.actual_action.lower().startswith("discard ")), None)
    if next_decision is None:
        return None
    return {
        "turn": next_decision.state.turn,
        "action": next_decision.actual_action,
        "state": app_snapshot(next_decision.state.players,
                              current_actor=next_decision.state.analyzed_player,
                              turn=next_decision.state.turn),
    }


def riichienv_timeline(events: list[dict[str, Any]], analyzed_player: int) -> list[dict[str, Any]]:
    try:
        from riichienv import GameRule, RiichiEnv
    except ImportError as error:
        raise RuntimeError("RiichiEnv is not installed; run `pip install riichienv`") from error

    # Tenhou's 4-player preset matches the checked fixture's source.
    env = RiichiEnv(game_mode="4p-red-half", rule=GameRule.default_tenhou())
    timeline = []
    for index, event in enumerate(events):
        env.apply_event(event)
        label = mjai_event_label(event)
        if label is None:
            continue
        timeline.append({"index": index, "label": {
            "actor": label[0], "action": label[1], "tile": label[2]
        }, "state": riichienv_snapshot(env, analyzed_player)})
    return timeline


def pair_timelines(app_timeline: list[dict[str, Any]], env_timeline: list[dict[str, Any]]) -> list[tuple[dict[str, Any] | None, dict[str, Any] | None]]:
    """Align by actor/action/tile labels and discard duplicate reach markers."""
    app_by_label: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for row in app_timeline:
        label = row["label"]
        key = (label["actor"], label["action"], label["tile"])
        app_by_label.setdefault(key, []).append(row)
    pairs = []
    for row in env_timeline:
        label = row["label"]
        key = (label["actor"], label["action"], label["tile"])
        candidates = app_by_label.get(key, [])
        pairs.append((candidates.pop(0) if candidates else None, row))
    return pairs


def state_diff(app_state: dict[str, Any] | None, env_state: dict[str, Any] | None) -> dict[str, Any]:
    if app_state is None or env_state is None:
        return {"app_state_available": app_state is not None, "riichienv_state_available": env_state is not None}
    differences = []
    for app_player, env_player in zip(app_state["players"], env_state["players"]):
        seat = app_player["seat"]
        if app_player["river"] != env_player["river"]:
            differences.append({"seat": seat, "field": "river", "app": app_player["river"], "riichienv": env_player["river"]})
        if app_player["melds"] != env_player["melds"]:
            differences.append({"seat": seat, "field": "melds", "app": app_player["melds"], "riichienv": env_player["melds"]})
        if app_player["riichi"] != env_player["riichi"]:
            differences.append({"seat": seat, "field": "riichi", "app": app_player["riichi"], "riichienv": env_player["riichi"]})
    if app_state["current_actor"] != env_state["current_actor"]:
        differences.append({"field": "current_actor", "app": app_state["current_actor"], "riichienv": env_state["current_actor"]})
    return {"differences": differences}


def main() -> None:
    report = parse_mjai_reviewer_html(FIXTURE.read_bytes())
    round_ = next(item for item in report.rounds if item.id == ROUND_ID)
    if not round_.original_game_log:
        raise RuntimeError(f"{ROUND_ID} has no embedded game log")

    # Compute the current app timeline independently from the exact round log;
    # RiichiEnv consumes the selected round's events emitted by convlog.
    events = convert_round_with_convlog(round_.original_game_log)
    app_timeline = current_app_timeline(round_, report.metadata.analyzed_player)
    env_timeline = riichienv_timeline(events, report.metadata.analyzed_player)
    # Align relevant action streams in order, allowing MJAI aliases (reach)
    # and app call labels without a tile. The app labels omit call tile data.
    pairs = []
    app_cursor = 0
    for env_row in env_timeline:
        label = env_row["label"]
        match = next((j for j in range(app_cursor, len(app_timeline))
                      if app_timeline[j]["label"]["actor"] == label["actor"]
                      and app_timeline[j]["label"]["action"] in
                      ({"reach", "discard"} if label["action"] == "reach" else {label["action"]})
                      and (app_timeline[j]["label"]["action"] not in {"discard", "riichi"}
                           or app_timeline[j]["label"]["tile"] == label["tile"])), None)
        if match is None:
            pairs.append((None, env_row))
        else:
            pairs.append((app_timeline[match], env_row))
            app_cursor = match + 1

    pon_pair_index = next((i for i, (_, env) in enumerate(pairs)
                           if env and env["label"]["actor"] == CALLER
                           and env["label"]["action"] == "pon"
                           and env["label"]["tile"] == CALLED_TILE), None)
    if pon_pair_index is None:
        raise RuntimeError("Could not align the exact actor=2 hatsu pon in both replay streams")
    next_decision = app_report_decision_state(report, ROUND_ID)
    # Called tile is source seat 0's 6z discard immediately before actor 2's pon.
    called_discard_index = next((i for i, (_, row) in enumerate(pairs[:pon_pair_index])
                                 if row and row["label"] == {"actor": SOURCE, "action": "dahai", "tile": CALLED_TILE}), None)
    if called_discard_index is None:
        raise RuntimeError("Could not find source seat's called 6z discard before the pon")
    before_index = called_discard_index
    focus_indices = {before_index, pon_pair_index}
    if next_decision:
        next_pair_index = next((i for i, (_, env_row) in enumerate(pairs)
                                if env_row and env_row["label"]["actor"] == report.metadata.analyzed_player
                                and env_row["label"]["action"] == "dahai"
                                and env_row["label"]["tile"] == action_tile(next_decision["action"])
                                and i > pon_pair_index), None)
        if next_pair_index is not None:
            focus_indices.add(next_pair_index)

    print(f"fixture={FIXTURE.name} round={ROUND_ID} mjai_events={len(events)}")
    print("state_sources: RiichiEnv public properties + get_observation(analyzed_player); current app replay_round event snapshots")
    print("tile_normalization: RiichiEnv 136-ID // 4 -> 34 tile types -> MPSZ; red-five identity intentionally ignored")
    print("\n=== Side-by-side relevant snapshots ===")
    for i, (app_row, env_row) in enumerate(pairs):
        if i not in focus_indices:
            continue
        label = env_row["label"] if env_row else app_row["label"]
        print(f"\n--- event={i} actor={label['actor']} action={label['action']} tile={label['tile']} ---")
        print("current_app:")
        app_state = app_row["state"] if app_row else None
        # Pon labels in the app have no tile field; align its target pon with
        # the normalized MJAI event by actor/action after locating the called
        # discard immediately before it.
        if app_state is None and i == pon_pair_index:
            app_pon = next((row for row in app_timeline
                            if row["label"]["actor"] == CALLER and row["label"]["action"] == "pon"
                            and row["state"]["players"][CALLER]["melds"]
                            and row["state"]["players"][CALLER]["melds"][-1]["called_tile"] == CALLED_TILE), None)
            app_state = app_pon["state"] if app_pon else None
        if next_decision and i in focus_indices and i not in {pon_pair_index, before_index}:
            app_state = {"turn": next_decision["turn"], "action": next_decision["action"], **next_decision["state"]}
        print(json.dumps(app_state, ensure_ascii=False, indent=2))
        print("riichienv:")
        print(json.dumps(env_row["state"] if env_row else None, ensure_ascii=False, indent=2))
        print("diff:")
        print(json.dumps(state_diff(app_state,
                                   env_row["state"] if env_row else None), ensure_ascii=False, indent=2))

    before = pairs[before_index] if before_index >= 0 else (None, None)
    after = pairs[pon_pair_index]
    source_river_before = before[1]["state"]["players"][SOURCE]["river"] if before[1] else []
    source_river_after = after[1]["state"]["players"][SOURCE]["river"] if after[1] else []
    app_after_state = next((row["state"] for row in app_timeline
                            if row["label"]["actor"] == CALLER and row["label"]["action"] == "pon"
                            and row["state"]["players"][CALLER]["melds"]
                            and row["state"]["players"][CALLER]["melds"][-1]["called_tile"] == CALLED_TILE), None)
    app_river_after = app_after_state["players"][SOURCE]["river"] if app_after_state else []
    next_env = next((env for _, env in pairs if next_decision and env
                     and env["label"]["actor"] == report.metadata.analyzed_player
                     and env["label"]["action"] == "dahai"
                     and env["label"]["tile"] == action_tile(next_decision["action"])
                     and env["index"] > after[1]["index"]), None)
    print("\n=== Answer: kyoku-4-2 hatsu pon ===")
    print(json.dumps({
        "called_discard_event_source_river_has_called_6z": CALLED_TILE in source_river_before,
        "riichienv_after_pon_source_river_has_called_6z": CALLED_TILE in source_river_after,
        "current_app_after_pon_source_river_has_called_6z": CALLED_TILE in app_river_after,
        "riichienv_next_analyzed_decision_source_river_has_called_6z": (
            CALLED_TILE in next_env["state"]["players"][SOURCE]["river"] if next_env else None
        ),
        "current_app_next_analyzed_decision": next_decision,
        "riichienv_removes_called_discard": CALLED_TILE in source_river_before and CALLED_TILE not in source_river_after,
        "comparison_after_pon": state_diff(app_after_state, after[1]["state"] if after[1] else None),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
