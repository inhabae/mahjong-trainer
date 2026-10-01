"""Pure V1 shanten and ukeire analysis over normalized game states."""

from collections import Counter
import re

from mahjong.shanten import Shanten

from app.models.game_state import GameState, Meld

TILES = [f"{n}{s}" for s in "mps" for n in range(1, 10)] + [f"{n}z" for n in range(1, 8)]
TILE_INDEX = {tile: i for i, tile in enumerate(TILES)}
_SHANTEN = Shanten()


def normalize_tile(tile: str) -> str:
    value = tile.strip().lower().replace("pai-", "")
    value = value.replace("0m", "5m").replace("0p", "5p").replace("0s", "5s")
    value = re.sub(r"r$", "", value)
    honor_aliases = {"e": "1z", "s": "2z", "w": "3z", "n": "4z", "p": "7z", "f": "6z", "c": "5z"}
    legacy_honors = {str(number): f"{number}z" for number in range(1, 8)}
    return honor_aliases.get(value, legacy_honors.get(value, value))


def action_tile(action: str | None) -> str | None:
    if not action:
        return None
    matches = re.findall(r"(?:[0-9][mps]r?|[1-7]z|[neswpfch])", action.lower())
    for match in reversed(matches):
        candidate = normalize_tile(match.replace(" ", ""))
        if candidate in TILE_INDEX:
            return candidate
    return None


def _counts(tiles: list[str]) -> list[int]:
    result = [0] * 34
    for tile in tiles:
        canonical = normalize_tile(tile)
        if canonical in TILE_INDEX:
            result[TILE_INDEX[canonical]] += 1
    return result


def _meld_count(melds: list[Meld]) -> int:
    return len(melds)


def calculate_shanten(hand: list[str], melds: list[Meld] | None = None) -> int:
    """Return minimum standard/chiitoitsu/kokushi shanten.

    The upstream library handles the three hand families. Open meld tiles are
    excluded from the concealed input and their fixed-set count is accounted
    for by the normal 13-tile representation used by the report state.
    """
    melds = melds or []
    counts = _counts(hand)
    # Shanten.calculate_shanten already interprets a short concealed hand as
    # having the remaining groups supplied by fixed melds. Subtracting for
    # melds here would count those groups twice and can turn tenpai into agari.
    return _SHANTEN.calculate_shanten(counts)


def _visible_counts(state: GameState) -> Counter[str]:
    visible: Counter[str] = Counter(normalize_tile(tile) for tile in state.concealed_hand)
    if state.drawn_tile:
        visible[normalize_tile(state.drawn_tile)] += 1
    for player in state.players:
        visible.update(normalize_tile(tile) for tile in player.discards)
        for meld in player.melds:
            visible.update(normalize_tile(tile) for tile in meld.tiles)
    visible.update(normalize_tile(tile) for tile in state.dora_indicators)
    return visible


def calculate_effective_tiles(state: GameState, hand: list[str], melds: list[Meld] | None = None) -> dict[str, int]:
    melds = melds or []
    current = calculate_shanten(hand, melds)
    visible = _visible_counts(state)
    effective: dict[str, int] = {}
    for tile in TILES:
        trial = list(hand) + [tile]
        if calculate_shanten(trial, melds) < current:
            effective[tile] = max(0, 4 - visible[tile])
    return effective


def _after_discard(state: GameState, discard: str) -> tuple[list[str], list[Meld]]:
    hand = [normalize_tile(tile) for tile in state.concealed_hand]
    if state.drawn_tile:
        hand.append(normalize_tile(state.drawn_tile))
    tile = action_tile(discard)
    if tile in hand:
        hand.remove(tile)
    return hand, state.players[state.analyzed_player].melds if state.players else []


def analyze_discard(state: GameState, discard: str) -> dict:
    hand, melds = _after_discard(state, discard)
    shanten = calculate_shanten(hand, melds)
    effective = calculate_effective_tiles(state, hand, melds)
    return {
        "shanten": shanten,
        "effective_tile_types": len(effective),
        "effective_tiles": [
            {"tile": tile, "visible_copies": 4 - remaining, "remaining": remaining}
            for tile, remaining in effective.items()
        ],
        "ukeire": sum(effective.values()),
    }


def compare_actions(state: GameState, player_action: str | None, mortal_action: str | None) -> dict:
    mismatch = player_action != mortal_action
    result: dict = {"mortal_mismatch": mismatch, "player_action": player_action, "mortal_action": mortal_action}
    if not mismatch:
        return result
    try:
        player = analyze_discard(state, player_action or "") if action_tile(player_action) else None
    except (AssertionError, ValueError):
        player = None
    try:
        mortal = analyze_discard(state, mortal_action or "") if action_tile(mortal_action) else None
    except (AssertionError, ValueError):
        mortal = None
    result["player_analysis"] = player
    result["mortal_analysis"] = mortal
    if player and mortal:
        result["difference"] = {
            "shanten_delta": player["shanten"] - mortal["shanten"],
            "ukeire_delta": player["ukeire"] - mortal["ukeire"],
            "ukeire_ratio": player["ukeire"] / mortal["ukeire"] if mortal["ukeire"] else None,
            "effective_tile_type_delta": player["effective_tile_types"] - mortal["effective_tile_types"],
        }
    return result
