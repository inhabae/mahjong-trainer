"""Deterministic, visibility-safe reconstruction of report decisions."""

from app.models.game_state import GameState, PlayerState, ReplayStep, ReconstructedDecision, ReconstructedReport
from app.models.report import ParsedReport, Round
from app.analysis.ukeire import compare_actions
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
                dora_indicators=(public_replay.dora_indicators[:1 + sum(item.kind in {"kan", "ankan", "kakan"} for item in public_replay.events[:snapshot_index + 1])] if public_replay else []),
                legal_actions=[item.action for item in decision.legal_actions],
                raw_event_index=index,
            )
            # Only the analyzed player's own action is known from this report
            # layer; no opponent discard or hidden tile is invented.
            if decision.actual_action:
                players[player].discards.append(decision.actual_action)
            severity = severity_for_decision(decision)
            output.append(ReconstructedDecision(round_id=round_.id, decision_index=index,
                                                actual_action=decision.actual_action,
                                                mortal_action=decision.mortal_action, state=state,
                                                analysis=compare_actions(state, decision.actual_action, decision.mortal_action),
                                                severity=severity["severity"], mortal=severity["mortal"], actions=severity["actions"]))
    counts = {key: sum(d.severity == key for d in output) for key in ("MATCH", "MINOR", "INACCURACY", "MISTAKE")}
    counts["highlighted"] = counts["MISTAKE"] + counts["INACCURACY"]
    warning = temperature_warning(report.metadata.softmax_temperature)
    return ReconstructedReport(analyzed_player=player, decisions=output, replay_steps=replay_steps,
                               summary={"total_decisions": len(output), "replay_steps": len(replay_steps), **counts},
                               warnings=[warning] if warning else [])
