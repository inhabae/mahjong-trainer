from app.analysis.tenhou_replay import replay_round
from app.parsers.mjai_reviewer import parse_mjai_reviewer_html


def test_replays_public_discards_and_dora_from_real_fixture() -> None:
    report = parse_mjai_reviewer_html(open("tests/fixtures/mjai-reviewer-demo.html", "rb").read())
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
    report = parse_mjai_reviewer_html(open("tests/fixtures/mjai-reviewer-demo.html", "rb").read())
    replays = [replay_round(round_.original_game_log) for round_ in report.rounds]
    events = [event for replay in replays for event in replay.events]

    assert any(event.kind == "chi" for event in events)
    assert any(event.kind == "pon" for event in events)
    assert any(event.kind == "kan" for event in events)
    assert any(event.kind == "riichi" for event in events)
