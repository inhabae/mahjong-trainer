from app.analysis.ukeire import analyze_discard, calculate_effective_tiles, calculate_shanten, compare_actions
from app.models.game_state import GameState, Meld, PlayerState


def state(hand: list[str], **kwargs) -> GameState:
    return GameState(round_id="test", analyzed_player=0, concealed_hand=hand, **kwargs)


def test_standard_hand_and_effective_tiles() -> None:
    hand = ["1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1p", "1p", "2s", "3s"]
    assert calculate_shanten(hand) == 0
    effective = calculate_effective_tiles(state(hand), hand)
    assert set(effective) == {"1s", "4s"}


def test_chiitoitsu_and_kokushi_are_supported() -> None:
    chiitoi = ["1m", "1m", "2p", "2p", "3s", "3s", "4m", "4m", "5p", "5p", "6s", "6s", "7m"]
    kokushi = ["1m", "9m", "1p", "9p", "1s", "9s", "1z", "2z", "3z", "4z", "5z", "6z", "7z"]
    assert calculate_shanten(chiitoi) == 0
    assert calculate_shanten(kokushi) == 0


def test_red_fives_are_five_copies() -> None:
    hand = ["1m", "2m", "3m", "4m", "0m", "6m", "7m", "8m", "9m", "1p", "1p", "2s", "3s"]
    assert calculate_shanten(hand) == 0
    result = analyze_discard(state(hand, drawn_tile="4s"), "Discard 4s")
    assert result["shanten"] == 0


def test_visible_discards_melds_and_dora_reduce_ukeire() -> None:
    hand = ["1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1p", "1p", "2s", "3s"]
    visible = state(
        hand,
        dora_indicators=["1s"],
        players=[PlayerState(seat=0, discards=["1s"]), PlayerState(seat=1, melds=[Meld(kind="pon", tiles=["4s", "4s", "4s"])])],
    )
    effective = calculate_effective_tiles(visible, hand)
    assert effective["1s"] == 2
    assert effective["4s"] == 1


def test_mismatch_comparison_and_deltas() -> None:
    hand = ["1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1p", "1p", "2s", "3s"]
    result = compare_actions(state(hand, drawn_tile="4s"), "Discard 1p", "Discard 9m")
    assert result["mortal_mismatch"] is True
    assert result["player_analysis"] is not None
    assert result["difference"]["ukeire_delta"] == result["player_analysis"]["ukeire"] - result["mortal_analysis"]["ukeire"]


def test_matching_decision_is_not_analyzed() -> None:
    result = compare_actions(state(["1m"]), "Discard 1m", "Discard 1m")
    assert result == {"mortal_mismatch": False, "player_action": "Discard 1m", "mortal_action": "Discard 1m"}
