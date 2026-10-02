from pathlib import Path

from app.analysis.reconstruction import reconstruct_report
from app.parsers.mjai_reviewer import parse_mjai_reviewer_html


FIXTURE = Path(__file__).parent / "fixtures" / "e417343c4d3491e7.html"


def test_duplicate_report_decision_does_not_advance_public_snapshot():
    report = parse_mjai_reviewer_html(FIXTURE.read_bytes())
    reconstructed = reconstruct_report(report)

    # This is the turn-5 decision where player 2 drew 7m and discarded 2s.
    decision = next(
        item for item in reconstructed.decisions
        if item.state.turn == 5 and item.actual_action == "打 2s"
    )

    assert decision.state.drawn_tile == "7m"
    assert decision.state.players[0].discards == ["9m", "2z", "1s", "3z", "9m"]
    assert decision.state.players[1].discards == ["7z", "7z", "4z", "2p", "1p"]
    assert "1m" not in decision.state.players[0].discards
    assert "7p" not in decision.state.players[1].discards


def test_reaction_snapshot_includes_offered_opponent_discard():
    report = parse_mjai_reviewer_html(FIXTURE.read_bytes())
    reconstructed = reconstruct_report(report)

    reaction = next(
        item for item in reconstructed.decisions
        if item.state.turn == 11 and item.actual_action == "スルー"
    )
    preceding_discard = next(
        item for item in reconstructed.decisions
        if item.state.turn == 11 and item.actual_action == "打 9s"
    )

    # The report's next event is seat 1's 8m discard. It is the offered tile,
    # while the reconstructed river is restored from the event-aligned state.
    assert reaction.state.call_tile == "8m"
    assert reaction.state.players[1].discards[-1] == "5s"
    assert reaction.state.players[2].discards[-1] == "9s"


def test_called_own_discard_stays_removed_from_later_decision_snapshot():
    report = parse_mjai_reviewer_html(FIXTURE.read_bytes())
    reconstructed = reconstruct_report(report)

    # In East 4, player 2's 2s discard on turn 5 is pon'ed by player 1.
    # At the following turn, reconstruction must not restore it from the
    # report's historical list of player 2's actions.
    later_decision = next(
        item for item in reconstructed.decisions
        if item.round_id == "kyoku-4-0" and item.state.turn == 6
    )

    assert "2s" not in later_decision.state.players[2].discards
    assert any(
        meld.kind == "pon" and meld.called_tile == "2s"
        for meld in later_decision.state.players[1].melds
    )
