"""Visible-information discard safety ranking and defensive decision labels."""

from collections import Counter
from dataclasses import dataclass
import re

from app.analysis.ukeire import action_tile, normalize_tile
from app.models.game_state import GameState, Meld


@dataclass(frozen=True)
class TileSafety:
    tile: str
    rank: int
    label: str
    guaranteed: bool


def _is_open(meld: Meld) -> bool:
    return meld.called_from is not None or meld.kind.lower() not in {"ankan", "concealed_kan"}


def threatening_seats(state: GameState) -> tuple[int, ...]:
    return tuple(
        player.seat
        for player in state.players
        if player.seat != state.analyzed_player
        and (player.riichi or sum(_is_open(meld) for meld in player.melds) >= 3)
    )


def _visible_counts(state: GameState) -> Counter[str]:
    visible: Counter[str] = Counter()
    for tile in state.concealed_hand:
        visible[normalize_tile(tile)] += 1
    if state.drawn_tile:
        visible[normalize_tile(state.drawn_tile)] += 1
    for player in state.players:
        visible.update(normalize_tile(tile) for tile in player.discards)
        for meld in player.melds:
            visible.update(normalize_tile(tile) for tile in meld.tiles)
    visible.update(normalize_tile(tile) for tile in state.dora_indicators)
    return visible


def _is_suji(tile: str, discards: list[str]) -> bool:
    if not re.fullmatch(r"[1-9][mps]", tile):
        return False
    rank = int(tile[0])
    suji_targets = {
        1: {4}, 2: {5}, 3: {6}, 4: {1, 7}, 5: {2, 8},
        6: {3, 9}, 7: {4}, 8: {5}, 9: {6},
    }
    return any(
        re.fullmatch(r"[1-9][mps]", value)
        and value[1] == tile[1]
        and rank in suji_targets[int(value[0])]
        for value in map(normalize_tile, discards)
    )


def _kabe_strength(tile: str, visible: Counter[str]) -> int:
    if not re.fullmatch(r"[1-9][mps]", tile):
        return 0
    rank = int(tile[0])
    suit = tile[1]
    # For a candidate tile to complete a two-sided wait, it can be either end
    # of one of these sequences. A fully visible companion tile blocks that
    # particular wait shape; even both blocked does not rule out other waits.
    waits = []
    low_wait = (rank + 1, rank + 2)
    high_wait = (rank - 2, rank - 1)
    for companions in (low_wait, high_wait):
        if all(1 <= companion <= 9 for companion in companions):
            waits.append(any(visible[f"{companion}{suit}"] >= 4 for companion in companions))
    return sum(waits)


def _heuristic_rank(tile: str, discards: list[str], visible: Counter[str]) -> tuple[int, str]:
    """Lower rank means safer; tiers are ordering heuristics, not probabilities."""
    suji = _is_suji(tile, discards)
    kabe_strength = _kabe_strength(tile, visible)
    if kabe_strength == 2 and suji:
        return 1, "kabe + suji"
    if kabe_strength == 2:
        return 2, "kabe"
    if suji:
        number = int(tile[0])
        if number in {1, 9}:
            return 3, "suji terminal"
        if number in {2, 8}:
            return 4, "suji 2/8"
        if number in {3, 7}:
            return 5, "suji 3/7"
        return 6, "suji middle"
    if kabe_strength == 1:
        return 6, "partial kabe"
    if tile.endswith("z"):
        return 7, "unpassed honor"
    number = int(tile[0])
    if number in {1, 9}:
        return 8, "unconnected terminal"
    if number in {2, 8}:
        return 9, "unconnected 2/8"
    return 10, "unconnected middle"


def rank_discard_safety(state: GameState, tile: str, threats: tuple[int, ...] | None = None) -> TileSafety:
    """Rank a discard against every active threat, using worst-case safety."""
    threats = threatening_seats(state) if threats is None else threats
    canonical = normalize_tile(tile)
    if not threats:
        return TileSafety(canonical, 99, "no active threat", False)
    players = {player.seat: player for player in state.players}
    # Genbutsu against every threatening opponent is the top, guaranteed tier.
    if all(canonical in {normalize_tile(value) for value in players[seat].discards} for seat in threats):
        return TileSafety(canonical, 0, "genbutsu", True)

    visible = _visible_counts(state)
    orphan_tiles = {"1m", "9m", "1p", "9p", "1s", "9s", "1z", "2z", "3z", "4z", "5z", "6z", "7z"}
    kokushi_impossible = all(
        any(_is_open(meld) for meld in players[seat].melds)
        or any(visible[orphan] >= 4 for orphan in orphan_tiles - {canonical})
        for seat in threats
    )
    if canonical.endswith("z") and visible[canonical] >= 4 and kokushi_impossible:
        return TileSafety(canonical, 0, "fourth honor; kokushi impossible", True)
    ranks = [_heuristic_rank(canonical, players[seat].discards, visible) for seat in threats]
    # Use the least safe opponent matchup. Average safety can hide a live risk.
    worst = max(ranks, key=lambda item: item[0])
    return TileSafety(canonical, worst[0], worst[1], False)


def _candidate_discards(
    state: GameState, actions: list[str], actual: str | None, mortal: str | None
) -> list[str]:
    candidates = [action_tile(action) for action in actions]
    candidates.extend(action_tile(action) for action in (actual, mortal) if action)
    hand = list(state.concealed_hand) + ([state.drawn_tile] if state.drawn_tile else [])
    if len(hand) == 14 - 3 * len(state.players[state.analyzed_player].melds if state.players else []):
        candidates.extend(hand)
    in_hand = Counter(normalize_tile(tile) for tile in hand)
    result: list[str] = []
    for tile in candidates:
        if tile is None:
            continue
        canonical = normalize_tile(tile)
        if in_hand[canonical] and canonical not in result:
            result.append(canonical)
    return result


def _shanten_loss(state: GameState, tile: str, candidates: list[str]) -> bool:
    from app.analysis.ukeire import analyze_discard

    options = []
    for candidate in candidates:
        try:
            options.append((candidate, analyze_discard(state, f"discard {candidate}")["shanten"]))
        except (AssertionError, ValueError, IndexError):
            continue
    chosen = next((value for candidate, value in options if candidate == normalize_tile(tile)), None)
    return chosen is not None and bool(options) and chosen > min(value for _, value in options)


def classify_decisions(
    decisions: list[tuple[GameState, str | None, str | None, list[str]]]
) -> list[dict]:
    """Classify review decisions, preserving the fold transition per round."""
    output: list[dict] = []
    fold_active = False
    prior_round: str | None = None
    prior_threats: tuple[int, ...] = ()
    for state, actual, mortal, actions in decisions:
        safety: list[TileSafety] = []
        if state.round_id != prior_round:
            fold_active = False
            prior_round = state.round_id
        threats = threatening_seats(state)
        if threats != prior_threats:
            fold_active = False
            prior_threats = threats

        action_names = [action.lower() for action in actions]
        has_call = any(re.match(r"^(chi|chii|pon|kan|minkan|daiminkan|ron|チー|ポン|カン|ロン)(?:\b|\s|$)", action) for action in action_names)
        has_pass = any(re.match(r"^(pass|skip|スルー|見送る)(?:\b|\s|$)", action) for action in action_names)
        if has_call and has_pass:
            category = "CALL_DECISION"
            fold_active = False
        elif any("riichi" in action or "reach" in action or "リーチ" in action for action in action_names):
            category = "RIICHI_DECISION"
            fold_active = False
        elif not threats:
            category = "TILE_EFFICIENCY"
            fold_active = False
        else:
            candidates = _candidate_discards(state, actions, actual, mortal)
            safety = [rank_discard_safety(state, tile, threats) for tile in candidates]
            top_rank = min((item.rank for item in safety), default=None)
            player_tile = action_tile(actual)
            mortal_tile = action_tile(mortal)
            player_choice = next((item for item in safety if item.tile == normalize_tile(player_tile or "")), None)
            mortal_choice = next((item for item in safety if item.tile == normalize_tile(mortal_tile or "")), None)
            player_defends = player_choice is not None and player_choice.rank == top_rank
            mortal_defends = mortal_choice is not None and mortal_choice.rank == top_rank
            losing = bool(player_tile and _shanten_loss(state, player_tile, candidates))

            if player_defends != mortal_defends:
                category = "PUSH_FOLD"
            elif not player_defends:
                category = "TILE_EFFICIENCY"
            elif fold_active:
                category = "BETAORI"
            elif losing:
                # The first shanten-losing safest discard is the transition
                # into folding. Betaori starts only on a later safe choice.
                category = "PUSH_FOLD"
            else:
                category = "TILE_EFFICIENCY"

            if player_defends and losing:
                fold_active = True
            elif not player_defends:
                fold_active = False

        output.append({
            "category": category,
            "threatening_seats": list(threats),
            "safety": [
                {"tile": item.tile, "rank": item.rank, "label": item.label,
                 "guaranteed": item.guaranteed}
                for item in sorted(safety if threats else [], key=lambda item: (item.rank, item.tile))
            ],
        })
    return output
