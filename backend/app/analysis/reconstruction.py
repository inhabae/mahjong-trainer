"""Deterministic, visibility-safe reconstruction of report decisions."""

from app.models.game_state import GameState, PlayerState, ReplayStep, ReconstructedDecision, ReconstructedReport
from app.models.report import ParsedReport, Round
from app.analysis.ukeire import action_tile, compare_actions, normalize_tile
from app.analysis.safety import classify_decisions
from app.analysis.severity import severity_for_decision, temperature_warning
from app.analysis.tenhou_replay import replay_round


def _header(round_: Round) -> tuple[int | None, int | None, int | None, list[int | None]]:
    log = round_.original_game_log
    if not log or not isinstance(log.get("log"), list) or not log["log"]:
        return None, None, None, []
    record = log["log"][0]
    header = record[0] if isinstance(record, list) and record else []
    scores = record[1] if len(record) > 1 and isinstance(record[1], list) else []
    dealer = header[0] % 4 if len(header) > 0 and isinstance(header[0], int) else None
    # mjai-reviewer's Tenhou header is [dealer, honba, kyotaku, ...].
    # Keep these in the same order as PublicReplay and the center display.
    honba = header[1] if len(header) > 1 and isinstance(header[1], int) else None
    kyotaku = header[2] if len(header) > 2 and isinstance(header[2], int) else None
    return dealer, honba, kyotaku, [x if isinstance(x, int) else None for x in scores]


def _call_source_seat(call_from: str | None, analyzed_player: int) -> int | None:
    value = (call_from or "").lower()
    if "上家" in value or "kamicha" in value:
        return (analyzed_player - 1) % 4
    if "下家" in value or "shimocha" in value:
        return (analyzed_player + 1) % 4
    if "対面" in value or "toimen" in value:
        return (analyzed_player + 2) % 4
    return None


def _call_tile_is_riichi(public_replay, analyzed_player: int, turn: int | None,
                         call_tile: str | None, call_from: str | None) -> bool:
    """Identify the exact riichi declaration discard for a call decision."""
    source_seat = _call_source_seat(call_from, analyzed_player)
    if public_replay is None or source_seat is None or not call_tile:
        return False

    # A call decision occurs after the offered discard and before this turn's
    # discard. Bound the event lookup to that player's turn so an earlier
    # discard of the same tile cannot be mistaken for the offered tile.
    own_discard_events = [
        index for index, event in enumerate(public_replay.events)
        if event.seat == analyzed_player and event.kind in {"discard", "riichi"}
    ]
    target_turn = turn or max(1, len(own_discard_events))
    # Report call windows use the turn just completed by the analyzed player:
    # the offered discard falls after that discard and before their next one.
    if 0 < target_turn <= len(own_discard_events):
        previous_event_index = own_discard_events[target_turn - 1]
        target_event_index = own_discard_events[target_turn] if target_turn < len(own_discard_events) else len(public_replay.events)
    else:
        previous_event_index = own_discard_events[-1] if own_discard_events else -1
        target_event_index = len(public_replay.events)
    wanted_tile = normalize_tile(call_tile)
    matching_events = [
        event for event in public_replay.events[previous_event_index + 1:target_event_index]
        if event.seat == source_seat and event.tile and normalize_tile(event.tile) == wanted_tile
    ]
    return bool(matching_events and matching_events[-1].kind == "riichi")


def _reported_discard_tile(action: str | None) -> str | None:
    """Extract an own discard, excluding calls and other reaction actions."""
    value = (action or "").strip().lower()
    non_discard_prefixes = (
        "chi", "chii", "pon", "kan", "minkan", "daiminkan", "ankan", "kakan",
        "ron", "pass", "skip", "tsumo", "win", "チー", "ポン", "カン", "ロン",
        "スルー", "見送る", "ツモ", "和了",
    )
    if any(value == prefix or value.startswith(f"{prefix} ") for prefix in non_discard_prefixes):
        return None
    return action_tile(action)


def _reported_discard_event(public_replay, analyzed_player: int, turn: int | None, tile: str):
    """Find the public replay event for a reported own discard, if available."""
    if public_replay is None or turn is None or turn < 1:
        return None
    own_discards = [
        event for event in public_replay.events
        if event.seat == analyzed_player and event.kind in {"discard", "riichi"}
    ]
    if turn > len(own_discards):
        return None
    event = own_discards[turn - 1]
    return event if event.tile and normalize_tile(event.tile) == normalize_tile(tile) else None


def reconstruct_report(report: ParsedReport) -> ReconstructedReport:
    player = report.metadata.analyzed_player
    if player is None:
        raise ValueError("The report does not identify an analyzed player")
    output: list[ReconstructedDecision] = []
    replay_steps: list[ReplayStep] = []
    for round_number, round_ in enumerate(report.rounds):
        dealer, honba, kyotaku, scores = _header(round_)
        players = [PlayerState(seat=seat, score=scores[seat] if seat < len(scores) else None) for seat in range(4)]
        public_replay = replay_round(round_.original_game_log, player) if round_.original_game_log else None
        if round_number and public_replay:
            transition_state = GameState(
                round_id=round_.id, round_label=round_.label, dealer=dealer,
                honba=honba, kyotaku=kyotaku, scores=scores,
                analyzed_player=player, turn=0, tiles_remaining=70,
                concealed_hand=[], players=[item.model_copy(deep=True) for item in players],
                dora_indicators=public_replay.dora_indicators[:1], raw_event_index=-1,
            )
            replay_steps.append(ReplayStep(round_id=round_.id, step_index=-1, actor=player,
                                           action="round_transition", state=transition_state))
        if public_replay:
            normal_draws = 0
            tiles_remaining = 70
            kan_actions = {"kan", "ankan", "kakan"}
            for step_index, (event, snapshot) in enumerate(zip(public_replay.events, public_replay.event_snapshots)):
                analyzed_hand = (public_replay.analyzed_hand_snapshots[step_index]
                                 if step_index < len(public_replay.analyzed_hand_snapshots) else [])
                drawn_tile = event.tile if event.kind == "draw" and event.seat == player else None
                if drawn_tile and drawn_tile in analyzed_hand:
                    # The drawn tile has its own render slot. Remove one
                    # matching copy from the standing hand regardless of
                    # ordering in the source snapshot.
                    analyzed_hand = list(analyzed_hand)
                    analyzed_hand.pop(len(analyzed_hand) - 1 - analyzed_hand[::-1].index(drawn_tile))
                if event.kind == "draw" and (step_index == 0 or public_replay.events[step_index - 1].kind not in kan_actions):
                    normal_draws += 1
                    tiles_remaining = max(0, 70 - normal_draws)
                kan_count = sum(item.kind in kan_actions for item in public_replay.events[:step_index + 1])
                replay_state = GameState(
                    round_id=round_.id, round_label=round_.label, dealer=dealer,
                    honba=honba, kyotaku=event.kyotaku, scores=scores,
                    analyzed_player=player, turn=step_index + 1,
                    tiles_remaining=tiles_remaining,
                    concealed_hand=analyzed_hand,
                    drawn_tile=drawn_tile, players=snapshot,
                    winning_tile=event.tile if event.kind == "win" else None,
                    winner=event.seat if event.kind == "win" else None,
                    win_type=("tsumo" if event.tile is not None else "ron") if event.kind == "win" else None,
                    dora_indicators=public_replay.dora_indicators[:1 + kan_count],
                    raw_event_index=step_index,
                )
                replay_steps.append(ReplayStep(
                    round_id=round_.id, step_index=step_index,
                    actor=event.seat, action=event.kind, tile=event.tile, raw=event.raw,
                    state=replay_state,
                ))
        for index, decision in enumerate(round_.decisions):
            # The report gives the player's own visible hand exactly at this
            # point. Opponent hands are intentionally never copied from logs.
            # The report may contain multiple decisions for one turn (for
            # example a call/"skip" decision).  Replay snapshots are keyed
            # by the analyzed player's turn, not by the report decision
            # row, so indexing by ``index`` advances the public board one
            # turn too far after such a row.
            snapshot_index = decision.turn - 1 if decision.turn is not None else index
            replay_prefix = public_replay.events[:snapshot_index + 1] if public_replay else []
            kan_actions = {"kan", "ankan", "kakan"}
            normal_draw_count = sum(
                event.kind == "draw"
                and (event_index == 0 or replay_prefix[event_index - 1].kind not in kan_actions)
                for event_index, event in enumerate(replay_prefix)
            )
            replay_players = (
                public_replay.snapshots_before_analyzed_discards[snapshot_index]
                if public_replay and 0 <= snapshot_index < len(public_replay.snapshots_before_analyzed_discards)
                else [item.model_copy(deep=True) for item in players]
            )
            if public_replay and 0 <= snapshot_index < len(public_replay.snapshots_before_analyzed_discards):
                # A call decision can reuse the snapshot for the analyzed
                # player's turn, even though their preceding discard has
                # already happened by the time the call window opens. Reconcile
                # the report's known own discards into that snapshot, adding
                # only copies the replay river does not already contain.
                replay_players = [item.model_copy(deep=True) for item in replay_players]
                available_snapshot_indices: dict[str, list[int]] = {}
                for river_index, tile in enumerate(replay_players[player].discards):
                    available_snapshot_indices.setdefault(normalize_tile(tile), []).append(river_index)
                for reported_index, tile in enumerate(players[player].discards):
                    normalized = normalize_tile(tile)
                    matching_indices = available_snapshot_indices.get(normalized, [])
                    if matching_indices:
                        river_index = matching_indices.pop(0)
                    else:
                        river_index = len(replay_players[player].discards)
                        replay_players[player].discards.append(tile)
                    if reported_index in players[player].tsumogiri_discard_indices and river_index not in replay_players[player].tsumogiri_discard_indices:
                        replay_players[player].tsumogiri_discard_indices.append(river_index)
                    if reported_index in players[player].riichi_discard_indices and river_index not in replay_players[player].riichi_discard_indices:
                        replay_players[player].riichi_discard_indices.append(river_index)
            state = GameState(
                round_id=round_.id,
                round_label=round_.label,
                dealer=dealer,
                honba=honba,
                kyotaku=kyotaku,
                scores=scores,
                analyzed_player=player,
                turn=decision.turn,
                tiles_remaining=max(0, 70 - normal_draw_count) if public_replay else None,
                concealed_hand=decision.concealed_hand,
                drawn_tile=decision.drawn_tile,
                players=replay_players,
                call_tile_is_riichi=_call_tile_is_riichi(
                    public_replay, player, decision.turn, decision.call_tile, decision.call_from
                ),
                dora_indicators=(public_replay.dora_indicators[:1 + sum(item.kind in {"kan", "ankan", "kakan"} for item in public_replay.events[:snapshot_index + 1])] if public_replay else []),
                legal_actions=[item.action for item in decision.legal_actions],
                call_tile=decision.call_tile,
                call_from=decision.call_from,
                raw_event_index=index,
            )
            # Only the analyzed player's own action is known from this report
            # layer; no opponent discard or hidden tile is invented.
            reported_discard = _reported_discard_tile(decision.actual_action)
            if reported_discard:
                discard_index = len(players[player].discards)
                players[player].discards.append(reported_discard)
                discard_event = _reported_discard_event(public_replay, player, decision.turn, reported_discard)
                if discard_event and discard_event.kind == "discard" and discard_event.raw == 60:
                    players[player].tsumogiri_discard_indices.append(discard_index)
                if discard_event and discard_event.kind == "riichi":
                    players[player].riichi_discard_indices.append(discard_index)
            severity = severity_for_decision(decision)
            output.append(ReconstructedDecision(round_id=round_.id, decision_index=index,
                                                actual_action=decision.actual_action,
                                                mortal_action=decision.mortal_action, state=state,
                                                analysis=compare_actions(state, decision.actual_action, decision.mortal_action),
                                                severity=severity["severity"], mortal=severity["mortal"], actions=severity["actions"]))
    classifications = classify_decisions([
        (item.state, item.actual_action, item.mortal_action,
         [action.get("action", "") for action in item.actions])
        for item in output
    ])
    output = [
        item.model_copy(update={
            "category": classification["category"],
            "threatening_seats": classification["threatening_seats"],
            "discard_safety": classification["safety"],
        })
        for item, classification in zip(output, classifications)
    ]
    counts = {key: sum(d.severity == key for d in output) for key in ("MATCH", "MINOR", "INACCURACY", "MISTAKE")}
    counts["highlighted"] = counts["MISTAKE"] + counts["INACCURACY"]
    warning = temperature_warning(report.metadata.softmax_temperature)
    return ReconstructedReport(analyzed_player=player, decisions=output, replay_steps=replay_steps,
                               summary={"total_decisions": len(output), "replay_steps": len(replay_steps), **counts},
                               warnings=[warning] if warning else [])
