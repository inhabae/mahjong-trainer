"""Replay the public portion of mjai-reviewer's Tenhou JSON kyoku records."""

from dataclasses import dataclass, field
import re
from typing import Any

from app.models.game_state import Meld, PlayerState


def tile_name(value: int) -> str:
    """Convert mjai-reviewer's Tenhou tile code (11..53) to tile notation."""
    if value in {51, 52, 53}:
        return {51: "0m", 52: "0p", 53: "0s"}[value]
    if 11 <= value <= 19:
        return f"{value - 10}m"
    if 21 <= value <= 29:
        return f"{value - 20}p"
    if 31 <= value <= 39:
        return f"{value - 30}s"
    if 41 <= value <= 44:
        return f"{value - 40}z"
    # The report's text protocol uses Haku/Hatsu/Chun in this order.
    if value == 45:
        return "7z"  # Haku
    if value == 46:
        return "6z"  # Hatsu
    if value == 47:
        return "5z"  # Chun
    raise ValueError(f"Unsupported Tenhou tile code: {value}")


def _item_tile(item: Any) -> str | None:
    return tile_name(item) if isinstance(item, int) and item != 60 else None


def _encoded_tiles(value: str) -> list[str]:
    return [tile_name(int(x)) for x in re.findall(r"\d{2}", value)]


def _call_kind(value: str) -> str | None:
    match = re.search(r"([cpka])", value)
    return match.group(1) if match else None


@dataclass
class PublicEvent:
    seat: int
    kind: str
    tile: str | None = None
    raw: Any = None


@dataclass
class PublicReplay:
    dealer: int
    honba: int
    kyotaku: int
    scores: list[int | None]
    dora_indicators: list[str]
    players: list[PlayerState]
    events: list[PublicEvent] = field(default_factory=list)
    event_snapshots: list[list[PlayerState]] = field(default_factory=list)
    snapshots_before_analyzed_discards: list[list[PlayerState]] = field(default_factory=list)
    analyzed_hand_snapshots: list[list[str]] = field(default_factory=list)


def _player_tables(record: list[Any]) -> list[tuple[list[Any], list[Any]]]:
    # [meta, scores, dora, ura, haipai, takes, discards] x 4, results
    tables = []
    cursor = 4
    for _ in range(4):
        takes = record[cursor + 1]  # haipai is concealed and never exposed
        discards = record[cursor + 2]
        tables.append((takes, discards))
        cursor += 3
    return tables


def replay_round(original_game_log: dict[str, Any], analyzed_player: int | None = None) -> PublicReplay:
    records = original_game_log.get("log") if isinstance(original_game_log, dict) else None
    if not isinstance(records, list) or not records or not isinstance(records[0], list):
        raise ValueError("Round has no Tenhou kyoku record")
    record = records[0]
    meta, scores, dora, _ura = record[:4]
    players = [PlayerState(seat=i, score=scores[i] if i < len(scores) else None) for i in range(4)]
    # Header order is [dealer, honba, kyotaku, ...].
    replay = PublicReplay(int(meta[0]) % 4, int(meta[1]), int(meta[2]), list(scores), [tile_name(x) for x in dora], players)
    def emit(kind: str, seat: int, tile: str | None, raw: Any = None) -> None:
        for player in players:
            if kind == "win" and player.seat == seat and player.revealed_hand is not None:
                player.concealed_count = len(player.revealed_hand)
                player.has_drawn_tile = tile is not None
            else:
                hand_count = len(concealed_hands[player.seat])
                player.has_drawn_tile = kind == "draw" and player.seat == seat
                player.concealed_count = max(0, hand_count - (1 if player.has_drawn_tile else 0))
        replay.events.append(PublicEvent(seat, kind, tile, raw))
        replay.event_snapshots.append(public_player_copies(players))
        replay.analyzed_hand_snapshots.append(list(concealed_hands[analyzed_player]) if analyzed_player is not None else [])
    tables = _player_tables(record)
    # The three per-player tables are canonical streams. Their events must be
    # interleaved by actor, not by array position: calls can change the next
    # actor and riichi emits an extra discard.
    positions = [0] * 4
    takes_positions = [0] * 4
    last_draw: list[str | None] = [None] * 4
    riichi_marker_pending = [False] * 4
    last_discard_event: tuple[int, str] | None = None
    concealed_hands: list[list[str]] = [[] for _ in range(4)]
    cursor = 4
    for seat in range(4):
        haipai = record[cursor] if cursor < len(record) and isinstance(record[cursor], list) else []
        concealed_hands[seat] = [_item_tile(item) for item in haipai if _item_tile(item)]
        cursor += 3

    # The initial deal is a real replay state, not a review decision.
    if analyzed_player is not None:
        emit("initial_hands", analyzed_player, None)

    def remove_one(hand: list[str], tile: str) -> bool:
        try:
            hand.remove(tile)
            return True
        except ValueError:
            return False

    def append_discard(seat: int, tile: str, *, tsumogiri: bool = False) -> None:
        players[seat].discards.append(tile)
        if tsumogiri:
            players[seat].tsumogiri_discard_indices.append(len(players[seat].discards) - 1)
        if riichi_marker_pending[seat]:
            players[seat].riichi_discard_indices.append(len(players[seat].discards) - 1)
            riichi_marker_pending[seat] = False

    def record_meld(actor: int, kind: str, raw: str) -> None:
        nonlocal last_discard_event
        # A call consumes the previous discard; it does not give the caller a
        # normal draw.  Do not let a stale draw be reused by a following 60
        # placeholder.
        last_draw[actor] = None
        tiles = _encoded_tiles(raw)
        if kind == "kakan":
            added_tile = tiles[0] if tiles else None
            existing = next(
                (
                    meld for meld in players[actor].melds
                    if meld.kind == "pon"
                    and added_tile is not None
                    and added_tile in meld.tiles
                ),
                None,
            )
            if existing is None:
                raise ValueError(f"Kakan has no existing pon for actor {actor}: {raw}")
            if added_tile is not None:
                remove_one(concealed_hands[actor], added_tile)
            existing.kind = "kakan"
            existing.tiles = tiles
            return
        if kind == "ankan":
            for tile in tiles:
                remove_one(concealed_hands[actor], tile)
            players[actor].melds.append(Meld(kind="ankan", tiles=tiles, raw=raw))
            return
        called_from = None
        if last_discard_event and last_discard_event[0] != actor and last_discard_event[1] in tiles:
            called_from = last_discard_event[0]
            source_discards = players[called_from].discards
            for index in range(len(source_discards) - 1, -1, -1):
                if source_discards[index] == last_discard_event[1]:
                    source_discards.pop(index)
                    if index in players[called_from].riichi_discard_indices:
                        players[called_from].riichi_discard_indices.remove(index)
                        riichi_marker_pending[called_from] = True
                    players[called_from].riichi_discard_indices = [
                        marker - 1 if marker > index else marker
                        for marker in players[called_from].riichi_discard_indices
                    ]
                    players[called_from].tsumogiri_discard_indices = [
                        marker - 1 if marker > index else marker
                        for marker in players[called_from].tsumogiri_discard_indices
                        if marker != index
                    ]
                    break
        called_tile = last_discard_event[1] if called_from is not None else None
        called_index = tiles.index(called_tile) if called_tile in tiles else None
        if called_index is not None:
            for index, tile in enumerate(tiles):
                if index != called_index:
                    remove_one(concealed_hands[actor], tile)
        else:
            for tile in tiles:
                remove_one(concealed_hands[actor], tile)
        players[actor].melds.append(Meld(kind=kind, tiles=tiles, called_from=called_from, called_tile=called_tile, called_index=called_index, raw=raw))
    actor = replay.dealer
    steps = 0
    while steps < 512:
        steps += 1
        takes, discards = tables[actor]
        if positions[actor] >= len(discards):
            remaining = next(
                (candidate for candidate in range(4)
                 if positions[candidate] < len(tables[candidate][1])),
                None,
            )
            if remaining is None:
                break
            actor = remaining
            continue
        # Calls and riichi declarations can leave a final discard entry that
        # has no separate take entry in Tenhou's compact per-seat tables.
        # The discard stream is authoritative for continuing the round.
        take_item = None
        if takes_positions[actor] < len(takes):
            take_item = takes[takes_positions[actor]]
            takes_positions[actor] += 1
        take = _item_tile(take_item)
        if take:
            last_draw[actor] = take
            concealed_hands[actor].append(take)
            # A draw is its own replay action. Previously it was only an
            # internal mutation before the discard checkpoint, so the UI
            # could never step to it independently.
            emit("draw", actor, take, take_item)
        call = _call_kind(take_item) if isinstance(take_item, str) else None
        if call:
            kind = {"c": "chi", "p": "pon", "k": "kakan", "a": "ankan"}[call]
            record_meld(actor, kind, take_item)
            emit(kind, actor, None, take_item)

        def consume_discard(item: Any) -> tuple[str | None, bool]:
            nonlocal last_discard_event
            if isinstance(item, int) and item == 60:
                tile = last_draw[actor]
                if tile:
                    remove_one(concealed_hands[actor], tile)
                    append_discard(actor, tile, tsumogiri=True)
                    last_discard_event = (actor, tile)
                    last_draw[actor] = None
                    emit("discard", actor, tile, item)
                    return tile, True
                # Tenhou uses 60 as a discard of the just-drawn tile.  If
                # there is no current draw, it is only a compact-stream
                # placeholder (typically after a call), not a real discard.
                last_draw[actor] = None
                return None, False
            if isinstance(item, int):
                tile = tile_name(item)
                remove_one(concealed_hands[actor], tile)
                append_discard(actor, tile)
                last_discard_event = (actor, tile)
                last_draw[actor] = None
                emit("discard", actor, tile, item)
                return tile, True
            if isinstance(item, str) and item.startswith("r"):
                players[actor].riichi = True
                tile = (_encoded_tiles(item)[-1:] or [last_draw[actor]])[0]
                remove_one(concealed_hands[actor], tile)
                append_discard(actor, tile)
                if not riichi_marker_pending[actor]:
                    players[actor].riichi_discard_indices.append(len(players[actor].discards) - 1)
                last_discard_event = (actor, tile)
                last_draw[actor] = None
                emit("riichi", actor, tile, item)
                return tile, True
            if isinstance(item, str) and _call_kind(item):
                call_name = _call_kind(item)
                kind = {"c": "chi", "p": "pon", "k": "kakan", "a": "ankan"}[call_name]
                record_meld(actor, kind, item)
                emit(kind, actor, None, item)
                return None, False
            return None, False

        if analyzed_player == actor:
            replay.snapshots_before_analyzed_discards.append(public_player_copies(players))
        item = discards[positions[actor]]
        positions[actor] += 1
        last_discard, is_discard = consume_discard(item)
        # An rXX entry is itself the complete riichi discard entry.  The
        # following 60 values in this mjlog are later tsumogiri discards, so
        # they must remain in the discard stream and be consumed by later
        # turns normally.
        if not is_discard and isinstance(item, str) and _call_kind(item):
            actor = actor
            continue
        # A matching naki in the next take stream overrides normal shimocha.
        next_actor = None
        for candidate in range(4):
            if candidate == actor or takes_positions[candidate] >= len(tables[candidate][0]):
                continue
            next_item = tables[candidate][0][takes_positions[candidate]]
            # A pending call only changes turn order when it consumes the
            # discard that was just emitted.  Looking for any call anywhere
            # in the take streams can jump over the actual discarder and make
            # the called tile appear to be discarded again later.
            next_call = _call_kind(next_item) if isinstance(next_item, str) else None
            if (
                next_call
                and last_discard_event is not None
                and last_discard_event[1] in _encoded_tiles(next_item)
                # A chi can only be called from the immediately preceding
                # seat.  Without this constraint, a matching chi in another
                # player's take stream can claim the discard and corrupt
                # called_from/source direction metadata.
                and (next_call != "c" or candidate == (last_discard_event[0] + 1) % 4)
            ):
                next_actor = candidate
                break
        actor = next_actor if next_actor is not None else (actor + 1) % 4
    replay.players = players
    # Tenhou stores the kyoku result after the four player tables. Preserve it
    # as a chronological terminal event instead of ending on the last discard.
    result = record[-1] if record else None
    if result is not None:
        result_head = result[0] if isinstance(result, list) and result else ""
        draw_result_heads = {
            "流局", "RYUUKYOKU",
            "四槓散了", "SUUKAIKAN",
            "九種九牌", "KYUUSHUUKYUUHAI",
            "四家立直", "SUUCHAriichi",
            "四風連打", "SUUFONRENDA",
        }
        result_kind = "exhaustive_draw" if result_head in draw_result_heads else "win"
        winner = analyzed_player if analyzed_player is not None else actor
        winning_tile = None
        revealed_hand = None
        if result_kind == "win" and isinstance(result, list) and len(result) > 1 and isinstance(result[1], list):
            deltas = result[1]
            winner = max(range(min(4, len(deltas))), key=lambda seat: deltas[seat])
            if takes_positions[winner] < len(tables[winner][0]):
                # The final entry in the winner's take table is the tsumo
                # tile.  Compact Tenhou records may retain an intermediate
                # replacement/terminal take before it.
                final_take = tables[winner][0][-1]
                takes_positions[winner] = len(tables[winner][0])
                winning_tile = _item_tile(final_take)
                revealed_hand = list(concealed_hands[winner])
                if winning_tile:
                    concealed_hands[winner].append(winning_tile)
                    emit("draw", winner, winning_tile, final_take)
        if result_kind == "win":
            if revealed_hand is None:
                revealed_hand = list(concealed_hands[winner])
            players[winner].revealed_hand = revealed_hand
        elif result_kind == "exhaustive_draw":
            deltas = result[1] if isinstance(result, list) and len(result) > 1 and isinstance(result[1], list) else []
            for seat, player in enumerate(players):
                player.is_tenpai = seat < len(deltas) and isinstance(deltas[seat], (int, float)) and deltas[seat] > 0
                player.revealed_hand = list(concealed_hands[seat]) if player.is_tenpai else None
        emit(result_kind, winner, winning_tile, result)
    return replay


def public_player_copies(players: list[PlayerState]) -> list[PlayerState]:
    return [player.model_copy(deep=True) for player in players]
