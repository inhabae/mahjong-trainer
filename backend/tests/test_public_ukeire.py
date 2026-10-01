from pathlib import Path

from app.analysis.reconstruction import reconstruct_report
from app.parsers.mjai_reviewer import parse_mjai_reviewer_html

FIXTURE = Path(__file__).parent / "fixtures" / "mjai-reviewer-demo.html"

def test_real_snapshot_reduces_ukeire_for_opponent_discard() -> None:
    report = parse_mjai_reviewer_html(FIXTURE.read_bytes())
    reconstructed = reconstruct_report(report)

    # This is East 1, analyzed-player decision 2. 1p is an effective tile
    # for the Mortal line and one copy has already appeared in an opponent pond.
    decision = reconstructed.decisions[1]
    opponent_discards = [tile for player in decision.state.players if player.seat != decision.state.analyzed_player for tile in player.discards]
    assert opponent_discards.count("1p") == 1
    analysis = decision.analysis["mortal_analysis"]
    effective = next(item for item in analysis["effective_tiles"] if item["tile"] == "1p")
    assert effective["visible_copies"] == 2  # one opponent discard + one in hand
    assert effective["remaining"] == 2


def test_future_public_discards_are_not_counted() -> None:
    report = parse_mjai_reviewer_html(FIXTURE.read_bytes())
    reconstructed = reconstruct_report(report)
    decision = reconstructed.decisions[1]
    # A later 1p in an opponent pond must not retroactively reduce this state.
    later_count = sum(player.discards.count("1p") for player in reconstructed.decisions[2].state.players if player.seat != decision.state.analyzed_player)
    current_count = sum(player.discards.count("1p") for player in decision.state.players if player.seat != decision.state.analyzed_player)
    assert later_count >= current_count
    assert current_count == 1
