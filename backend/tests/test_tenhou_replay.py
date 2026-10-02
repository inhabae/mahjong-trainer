from pathlib import Path

from app.analysis.tenhou_replay import replay_round
from app.analysis.reconstruction import reconstruct_report
from app.parsers.mjai_reviewer import parse_mjai_reviewer_html

FIXTURE = Path(__file__).parent / "fixtures" / "mjai-reviewer-demo.html"
CALL_FIXTURE = Path(__file__).parent / "fixtures" / "65ac5c6e62f357b5.html"

def test_replays_public_discards_and_dora_from_real_fixture() -> None:
    report = parse_mjai_reviewer_html(FIXTURE.read_bytes())
    first = replay_round(report.rounds[0].original_game_log, analyzed_player=1)

    assert first.dora_indicators == ["2m", "2p"]
    assert len(first.events) > 20
    assert all(len(player.discards) > 0 for player in first.players)
    assert len(first.snapshots_before_analyzed_discards) > 5
    # Opponent ponds are present before later decisions, not just the
    # analyzed player's own pond.
    snapshot = first.snapshots_before_analyzed_discards[5]
    assert sum(len(player.discards) for player in snapshot) > 5
    assert len(snapshot[0].discards) > 0
    assert len(snapshot[2].discards) > 0


def test_replay_decodes_public_calls_and_riichi() -> None:
    report = parse_mjai_reviewer_html(FIXTURE.read_bytes())
    replays = [replay_round(round_.original_game_log) for round_ in report.rounds]
    events = [event for replay in replays for event in replay.events]

    assert any(event.kind == "chi" for event in events)
    assert any(event.kind == "pon" for event in events)
    assert any(event.kind in {"ankan", "kakan"} for event in events)
    assert any(event.kind == "riichi" for event in events)


def test_tsumogiri_discards_are_marked_in_public_river_state() -> None:
    report = parse_mjai_reviewer_html(FIXTURE.read_bytes())
    replay = replay_round(report.rounds[0].original_game_log)

    tsumogiri_events = [event for event in replay.events if event.kind == "discard" and event.raw == 60]
    assert tsumogiri_events
    for event_index, event in enumerate(replay.events):
        if event.kind != "discard" or event.raw != 60:
            continue
        player_after_discard = replay.event_snapshots[event_index][event.seat]
        assert len(player_after_discard.discards) - 1 in player_after_discard.tsumogiri_discard_indices


def test_replays_hatsu_pon_encoded_with_called_tile_first() -> None:
    report = parse_mjai_reviewer_html(CALL_FIXTURE.read_bytes())
    round_ = next(round_ for round_ in report.rounds if round_.id == "kyoku-4-2")
    replay = replay_round(round_.original_game_log, analyzed_player=2)

    pon_index = next(
        index for index, event in enumerate(replay.events)
        if event.kind == "pon" and event.seat == 2 and event.raw == "46p4646"
    )
    called_state = replay.event_snapshots[pon_index]

    assert called_state[2].melds[-1].tiles == ["6z", "6z", "6z"]
    assert called_state[2].melds[-1].called_from == 0
    assert "6z" not in called_state[0].discards
    assert len(called_state[2].discards) == 3

    reconstructed = reconstruct_report(report)
    call_decision = next(
        item for item in reconstructed.decisions
        if item.round_id == round_.id and item.actual_action == "Pon f f"
    )
    assert call_decision.state.players[2].melds[-1].tiles == ["6z", "6z", "6z"]
    assert "6z" not in call_decision.state.players[0].discards


def test_called_discard_is_not_reused_by_a_later_meld() -> None:
    # Seat 0 discards 6z, which seat 1 calls. Seat 2 then makes a meld whose
    # encoded tiles also contain 6z; that later meld must not claim the same
    # discard or remove another 6z from seat 0's river.
    record = [
        [0, 0, 0, 0], [25000] * 4, [], [],
        [11, 12, 13], [], [46],
        [46, 46], ["46p4646"], [0],
        [46, 46], ["46p4646"], [0],
        [], [], [],
        ["流局", [0, 0, 0, 0]],
    ]
    replay = replay_round({"log": [record]})

    pons = [meld for player in replay.players for meld in player.melds]
    assert pons[0].called_from == 0
    assert pons[1].called_from is None
    assert replay.players[0].discards == []


def test_called_tile_is_absent_from_source_river_in_later_snapshot() -> None:
    # Seat 0 discards 6z; seat 1 calls it with a pon. The final draw event is
    # later than the call, so its snapshot verifies the persisted public state.
    record = [
        [0, 0, 0, 0], [25000] * 4, [], [],
        [11, 12, 13], [], [46],
        [46, 46], ["46p4646"], [0],
        [], [21], [0],
        [], [], [],
        ["流局", [0, 0, 0, 0]],
    ]
    replay = replay_round({"log": [record]})

    later_index = next(
        index for index, event in enumerate(replay.events)
        if event.kind == "draw" and event.seat == 2 and event.tile == "1p"
    )
    later_state = replay.event_snapshots[later_index]

    assert "6z" not in later_state[0].discards
    assert later_state[1].melds[-1].tiles == ["6z", "6z", "6z"]
    assert later_state[1].melds[-1].called_tile == "6z"
