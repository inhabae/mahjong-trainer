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
