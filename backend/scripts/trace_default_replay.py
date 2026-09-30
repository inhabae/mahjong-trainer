"""Print the raw/default replay data around a suspicious event window.

This is diagnostic only; it does not modify replay parsing or application state.
Run from backend/ with: .venv/bin/python scripts/trace_default_replay.py
"""

from pathlib import Path

from app.analysis.tenhou_replay import _player_tables, replay_round
from app.parsers.mjai_reviewer import parse_mjai_reviewer_html


DEFAULT_REPORT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "e417343c4d3491e7.html"
TARGET = ["4p", "2p", "8m", "9s", "6z", "6z"]


def find_subsequence(values: list[str | None], target: list[str]) -> tuple[int, int] | None:
    cursor = 0
    first = None
    for index, value in enumerate(values):
        if value != target[cursor]:
            continue
        if first is None:
            first = index
        cursor += 1
        if cursor == len(target):
            return first, index
    return None


def main() -> None:
    parsed = parse_mjai_reviewer_html(DEFAULT_REPORT.read_bytes())

    for round_index, round_ in enumerate(parsed.rounds):
        if round_.id != "kyoku-0-0":
            continue
        if not round_.original_game_log:
            continue

        record = round_.original_game_log["log"][0]
        tables = _player_tables(record)
        replay = replay_round(round_.original_game_log, parsed.metadata.analyzed_player)
        discard_events = [
            (index, event)
            for index, event in enumerate(replay.events)
            if event.kind in {"discard", "riichi"}
        ]
        emitted = [event.tile for _, event in discard_events]
        match = find_subsequence(emitted, TARGET)

        print(f"\n=== round {round_index} ({round_.id}) ===")
        print("seat 2 takes:", tables[2][0])
        print("seat 2 discards:", tables[2][1])
        print("all emitted discards:", emitted)
        print("seat 2 emitted discards:", [event.tile for event in replay.events if event.seat == 2 and event.kind in {"discard", "riichi"}])
        print("raw take/discard lengths:", [(len(t), len(d)) for t, d in tables])
        if match is None:
            print("target not found:", TARGET)
            print("complete emitted event stream:")
            for index, event in enumerate(replay.events, start=1):
                print(f"{index:4} actor={event.seat} action={event.kind:<14} tile={event.tile!s:<3} raw={event.raw!r}")
            continue

        first_match, second_match = match
        start_event = max(0, discard_events[first_match][0] - 10)
        end_event = min(len(replay.events), discard_events[second_match][0] + 11)
        print(f"TARGET FOUND in chronological discard sequence positions {first_match}..{second_match}")
        print(f"chronological events {start_event + 1}..{end_event}:")

        for index in range(start_event, end_event):
            event = replay.events[index]
            snapshot = replay.event_snapshots[index]
            print(
                f"{index + 1:4} actor={event.seat} action={event.kind:<14} "
                f"tile={event.tile!s:<3} raw={event.raw!r} "
                f"ponds={[player.discards for player in snapshot]}"
            )
        print("all raw takes:", [takes for takes, _ in tables])
        print("all raw discards:", [discards for _, discards in tables])


if __name__ == "__main__":
    main()
