import { MemoryRatingControls } from "../components/MemoryRatingControls";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchHealth, fetchTrainingAnnotations, fetchTrainingItems, fetchDueTrainingItems, fetchTrainingSourceDecisions, fetchTrainingSources, importTrainingReport, saveTrainingAnnotation, saveTrainingMistake } from "../api/client";
import type { MistakeRecord, TrainingSource } from "../api/client";
import type { ActionEvaluation, DecisionCategory, GameState, Meld, PlayerState, ReplayEvent, ReconstructedDecision, Severity } from "../types/review";
import type { TrainingItem } from "../types/training";

type TrainingDecision = { id: string; sourceGameId?: string; actualAction: string | null; mortalAction: string | null; severity: Severity; category: DecisionCategory; mortalPolicy: number | null; actions: ActionEvaluation[]; state: GameState };
const categoryOptions: { value: Exclude<DecisionCategory, "UNCLASSIFIED">; label: string }[] = [
  { value: "CALL_DECISION", label: "Call decision" }, { value: "RIICHI_DECISION", label: "Riichi decision" },
  { value: "PUSH_FOLD", label: "Push / fold" }, { value: "BETAORI", label: "Betaori" },
  { value: "TILE_EFFICIENCY", label: "Tile efficiency" }, { value: "ENDGAME_PLACEMENT", label: "Endgame placement" },
];
const categoryStorageKey = "mahjong-training-categories-v1";
const nearDueWindowMs = 10 * 60 * 1000;

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
function availableTrainingDecisions(decisions: TrainingDecision[], items: TrainingItem[], sourceFile: string, at: Date, horizonMs = 0): TrainingDecision[] {
  const byId = new Map(items.filter((item) => item.source_game_id === sourceFile).map((item) => [item.decision_id, item]));
  return decisions.filter((decision) => {
    const card = byId.get(decision.id);
    return !card || card.reps === 0 || new Date(card.due_at).getTime() <= at.getTime() + horizonMs;
  });
}
interface DiscardRiverState { tiles: string[]; riichiIndices: number[]; tsumogiriIndices: number[] }
interface MahjongTableProps {
  boardState: GameState;
  score: (seat: number) => number | null;
  pond: (seat: number) => string[];
  meldTiles: (seat: number) => Meld[];
  closedCount: (seat: number) => number;
  boardHand: string[];
  drawnTile?: string | null;
  onTileSelect?: (tile: string) => void;
  callTile?: string | null;
  callTileIsRiichi?: boolean;
  callFromSeat?: number | null;
  currentActor?: number;
  currentAction?: string;
  drawKey: string | number;
}
const honorCodes: Record<string, string> = { "1": "1z", "2": "2z", "3": "3z", "4": "4z", "5": "5z", "6": "6z", "7": "7z", e: "1z", s: "2z", w: "3z", n: "4z", c: "5z", f: "6z", p: "7z" };
const honorFiles: Record<string, string> = { "1z": "Ton", "2z": "Nan", "3z": "Shaa", "4z": "Pei", "5z": "Chun", "6z": "Hatsu", "7z": "Haku" };
function normalizeTile(tile: string) {
  if (/^5[mps]r$/.test(tile)) return `0${tile[1]}`;
  return honorCodes[tile] ?? tile;
}
function actionTile(action: string | null): string | null {
  return action?.match(/([0-9][mps]r?|[1-7]z|[東南西北中發白]|[epwsfcn])/u)?.[1] ?? null;
}
function isTileToken(token: string): boolean {
  return /^(?:[0-9][mps]r?|[1-7]z|[東南西北中發白]|[epwsfcn])$/u.test(token);
}
function calledMeldLabel(kind: string): string {
  const normalizedKind = kind.toLowerCase();
  if (normalizedKind === "chi" || normalizedKind === "chii") return "You called chi";
  if (normalizedKind === "pon") return "You called pon";
  if (["kan", "minkan", "daiminkan"].includes(normalizedKind)) return "You called kan";
  return "Your called meld";
}
function ActionWithTiles({ action }: { action: string }) {
  return <span className="training-action-label">{action.split(/\s+/).map((part, index) => isTileToken(part) ? <Tile key={`${part}-${index}`} tile={part} /> : <span key={`${part}-${index}`}>{part}</span>)}</span>;
}
function sameTile(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && normalizeTile(left) === normalizeTile(right);
}
function normalizeAction(action: string | null): string {
  return (action ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
function isPassAction(action: string): boolean {
  return /^(pass|skip|スルー|見送る)(?:\b|$)/iu.test(action.trim());
}
function isCallAction(action: string): boolean {
  return /^(chi|chii|pon|kan|minkan|daiminkan|ron|チー|ポン|カン|ロン)(?:\b|\s|$)/iu.test(action.trim());
}
function callActionPriority(action: string): number {
  if (/^(ron|ロン)(?:\b|\s|$)/iu.test(action.trim())) return 0;
  if (/^(kan|minkan|daiminkan|カン)(?:\b|\s|$)/iu.test(action.trim())) return 1;
  if (/^(pon|ポン)(?:\b|\s|$)/iu.test(action.trim())) return 2;
  if (/^(chi|chii|チー)(?:\b|\s|$)/iu.test(action.trim())) return 3;
  if (isPassAction(action)) return 4;
  return 5;
}
function isCallDecision(actions: string[]): boolean {
  return actions.some(isPassAction) && actions.some(isCallAction);
}
function relativeCallSeat(source: string | null): number | null {
  if (!source) return null;
  if (/kamicha|上家/iu.test(source)) return 3;
  if (/shimocha|下家/iu.test(source)) return 1;
  if (/toimen|対面/iu.test(source)) return 2;
  return null;
}
function formatPolicy(policy: number | null): string | null {
  return policy === null ? null : `${(policy * 100).toFixed(1)}%`;
}
function policyForTile(actions: ActionEvaluation[], tile: string): number | null {
  const match = actions.find((action) => sameTile(actionTile(action.action), tile));
  return match?.policy_probability_percent == null ? null : match.policy_probability_percent / 100;
}
function policyForAction(actions: ActionEvaluation[], action: string): number | null {
  const match = actions.find((item) => normalizeAction(item.action) === normalizeAction(action));
  return match?.policy_probability_percent == null ? null : match.policy_probability_percent / 100;
}
function toTrainingDecision(item: ReconstructedDecision): TrainingDecision {
  return {
    id: item.id,
    actualAction: item.actual_action,
    mortalAction: item.mortal_action,
    severity: item.severity,
    category: item.category ?? "UNCLASSIFIED",
    mortalPolicy: item.mortal.best_policy,
    actions: item.actions,
    state: item.state,
  };
}
function tileUrl(tile: string) {
  if (typeof tile !== "string" || !tile) return undefined;
  const normalized = normalizeTile(tile);
  const honorFile = honorFiles[normalized];
  if (honorFile) return `/tiles/Regular/${honorFile}.svg`;
  const match = normalized.match(/^([0-9])([mps])$/);
  if (!match) return undefined;
  const suit = { m: "Man", p: "Pin", s: "Sou" }[match[2]];
  const rank = match[1] === "0" ? "5" : match[1];
  const file = `${suit}${rank}${match[1] === "0" ? "-Dora" : ""}`;
  return `/tiles/Regular/${file}.svg`;
}
function Tile({ tile, muted = false, onClick }: { tile: string; muted?: boolean; onClick?: () => void }) {
  const face = <span className={`mahjong-tile ${muted ? "tile-muted" : ""}`} title={tile}><img src={tileUrl(tile)} alt={tile} /></span>;
  if (!onClick) return face;
  return <button type="button" className="training-tile-choice" aria-label={`Discard ${tile}`} onClick={onClick}>{face}</button>;
}
function TileBack({ className = "", ariaLabel }: { className?: string; ariaLabel?: string }) { return <span className={`tile-back ${className}`} aria-hidden={ariaLabel ? undefined : true} aria-label={ariaLabel}><img src="/tiles/Regular/Back.svg" alt="" /></span>; }
type Seat = "bottom" | "right" | "top" | "left";
const seatIndex: Record<Seat, number> = { bottom: 0, right: 1, top: 2, left: 3 };

class ReplayErrorBoundary extends Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <main className="app-shell"><section className="workspace"><h1>Replay could not render</h1><p>{this.state.error}</p></section></main> : this.props.children; }
}

function DiscardRiver({ seat, tiles, riichiIndices = [], tsumogiriIndices = [] }: { seat: Seat; tiles: string[]; riichiIndices?: number[]; tsumogiriIndices?: number[] }) {
  const rows: { tile: string; index: number }[][] = [];
  for (let index = 0; index < tiles.length; index += 6) {
    rows.push(tiles.slice(index, index + 6).map((tile, offset) => ({ tile, index: index + offset })));
  }
  return <div className={`discard-river discard-river-${seat}`} aria-label={`${seat} discard river`}>
    {rows.map((row, rowIndex) => <div className="discard-row" key={`row-${rowIndex}`}>{row.map(({ tile, index }) => {
      const isRiichi = riichiIndices.includes(index);
      const isTsumogiri = tsumogiriIndices.includes(index);
      return <span className={`discard-slot ${isRiichi ? `riichi-discard riichi-discard-${seat}` : "discard-normal"}`} key={`${tile}-${index}`}><Tile tile={tile} muted={isTsumogiri} /></span>;
    })}</div>)}
  </div>;
}
function calledTileIndex(meld: Meld): number | null {
  return Number.isInteger(meld.called_index) ? meld.called_index : null;
}
function calledTileDisplayIndex(callerSeat: number, calledFrom: number | null, meldSize: number): number | null {
  if (!Number.isInteger(calledFrom) || meldSize < 3) return null;
  const relative = (calledFrom! - callerSeat + 4) % 4;
  if (relative === 3) return 0;
  if (relative === 2) return meldSize === 3 ? 1 : Math.floor(meldSize / 2);
  if (relative === 1) return meldSize - 1;
  return null;
}
function MeldArea({ seat, callerSeat, melds }: { seat: Seat; callerSeat: number; melds: Meld[] }) {
  return <div className={`meld-area meld-area-${seat}`} aria-label={`${seat} melds`}>
    {melds.map((meld, meldIndex) => {
      const tiles = meld.tiles;
      const kind = meld.kind.toLowerCase();
      const isAnkan = kind === "ankan";
      const isKan = kind === "kan" || kind === "minkan" || kind === "daiminkan" || kind === "kakan";
      if (isAnkan) {
        const tile = tiles[0];
        return <span className="meld-group meld-ankan" key={`meld-${meldIndex}`}>
          <span className="meld-tile-slot"><TileBack /></span>
          <span className="meld-tile-slot"><Tile tile={tile} /></span>
          <span className="meld-tile-slot"><Tile tile={tile} /></span>
          <span className="meld-tile-slot"><TileBack /></span>
        </span>;
      }
      const calledIndex = calledTileIndex(meld);
      const displayIndex = calledTileDisplayIndex(callerSeat, meld.called_from, tiles.length);
      const items = tiles.map((tile, originalIndex) => ({
        tile,
        originalIndex,
        isCalled: originalIndex === calledIndex,
      }));
      const calledItem = items.find((item) => item.isCalled);
      const others = items.filter((item) => !item.isCalled);
      const extraKanTile = isKan && tiles.length > 3 ? (others.pop()?.tile ?? calledItem?.tile) : undefined;
      const displayTiles = [...others];
      if (calledItem && displayIndex !== null) displayTiles.splice(displayIndex, 0, calledItem);
      const isOpenCall = meld.called_from !== null;
      return <span className={`meld-group meld-${meld.kind}`} key={`meld-${meldIndex}`}>
        {displayTiles.map((item) => {
          const called = isOpenCall && item.isCalled;
          return <span className={`meld-tile-slot${called ? " called-tile-slot" : ""}${called && extraKanTile ? " kan-called-stack" : ""}`} key={`${meldIndex}-${item.originalIndex}`}>
            {called ? <span className="called-tile-frame"><Tile tile={item.tile} />{extraKanTile && <span className="kan-top-tile"><Tile tile={extraKanTile} /></span>}</span> : <Tile tile={item.tile} />}
          </span>;
        })}
      </span>;
    })}
  </div>;
}
function DrawnTile({ tile, hidden, animate, eventKey, onTileSelect }: { tile?: string; hidden: boolean; animate: boolean; eventKey: string; onTileSelect?: (tile: string) => void }) {
  if (!hidden && !tile) return null;
  return <span key={eventKey} className={`drawn-tile ${animate ? "drawn-tile-animated" : ""}`}>{hidden ? <TileBack className="tile-drawn-back" /> : <Tile tile={tile!} onClick={onTileSelect ? () => onTileSelect(tile!) : undefined} />}</span>;
}
function PlayerHand({ seat, standingTiles, concealedCount, drawnTile, drawHidden, animateDraw, drawKey, onTileSelect }: { seat: Seat; standingTiles?: string[] | null; concealedCount: number; drawnTile?: string | null; drawHidden: boolean; animateDraw: boolean; drawKey: string | number; onTileSelect?: (tile: string) => void }) {
  const tilesToRender = standingTiles ? sortTiles(standingTiles) : undefined;
  return <div className={`hand-tiles player-hand-${seat}`}>
    {tilesToRender
      ? tilesToRender.map((tile, index) => <Tile key={`${tile}-${index}`} tile={tile} onClick={onTileSelect ? () => onTileSelect(tile) : undefined} />)
      : Array.from({ length: concealedCount }, (_, index) => <TileBack key={`back-${index}`} />)}
    <span className="draw-gap" aria-hidden="true" />
    <span className="draw-area"><DrawnTile tile={drawnTile ?? undefined} hidden={drawHidden} animate={animateDraw} eventKey={`draw-${drawKey}-${seat}`} onTileSelect={onTileSelect} /></span>
  </div>;
}
function tileSortValue(tile: string): number {
  const suitOrder: Record<string, number> = { m: 0, p: 1, s: 2, z: 3 };
  const aliases: Record<string, string> = { e: "1z", s: "2z", w: "3z", n: "4z", c: "5z", f: "6z", p: "7z" };
  const normalized = /^5[mps]r$/.test(tile) ? `0${tile[1]}` : aliases[tile] ?? tile;
  const suit = normalized.slice(-1);
  const rawRank = Number(normalized.slice(0, -1));
  const rank = Number.isFinite(rawRank) ? (rawRank === 0 ? 5 : rawRank) : 99;
  return (suitOrder[suit] ?? 99) * 20 + rank;
}
function sortTiles(tiles: string[]): string[] {
  return [...tiles].sort((a, b) => tileSortValue(a) - tileSortValue(b) || a.localeCompare(b));
}
function WinningHand({ seat, tiles, winningTile, winType }: { seat: Seat; tiles: string[]; winningTile?: string | null; winType?: string | null }) {
  const sortedTiles = sortTiles(tiles);
  return <div className={`hand-tiles player-hand-${seat} winning-hand`}>
    {sortedTiles.map((tile, index) => <Tile key={`win-${tile}-${index}`} tile={tile} />)}
    <span className="draw-gap" aria-hidden="true" />
    <span className="draw-area">{winType === "tsumo" && winningTile ? <Tile tile={winningTile} /> : null}</span>
  </div>;
}
function SeatScore({ seat, wind, score }: { seat: Seat; wind: string; score: number | null }) {
  return <div className={`seat-score seat-score-${seat}`}><span>{wind}</span><b>{score == null ? "—" : score.toLocaleString()}</b></div>;
}
function CenterScore({ score }: { score: number | null }) {
  if (score == null) return <b className="center-score"><strong>—</strong></b>;
  const safeScore = Math.max(0, Math.round(score));
  const major = Math.floor(safeScore / 100);
  const minor = String(safeScore % 100).padStart(2, "0");
  return <b className="center-score"><strong>{major.toLocaleString()}</strong><small>{minor}</small></b>;
}
function PlayerZone({ seat, playerSeat, wind, score, melds, closedCount, hand, revealedHand, winningTile, winType, drawnTile, drawHidden = false, drawKey, animateDraw = false, revealHand = false, active = false, onTileSelect }: { seat: Seat; playerSeat: number; wind: string; score: number | null; melds: Meld[]; closedCount: number; hand?: string[] | null; revealedHand?: string[] | null; winningTile?: string | null; winType?: string | null; drawnTile?: string | null; drawHidden?: boolean; drawKey: string | number; animateDraw?: boolean; revealHand?: boolean; active?: boolean; onTileSelect?: (tile: string) => void }) {
  const side = seat === "left" || seat === "right";
  return <section className={`player-zone player-zone-${seat} ${active ? "player-zone-active" : ""}`}>
    <div className="player-zone-content">
      <div className="hand-anchor">
        <div className="hand-flow">
          <div className={`concealed-hand concealed-hand-${seat}`}>
            {revealHand && revealedHand ? <WinningHand seat={seat} tiles={revealedHand} winningTile={winningTile} winType={winType} /> : <PlayerHand seat={seat} standingTiles={hand} concealedCount={closedCount} drawnTile={drawnTile} drawHidden={drawHidden} animateDraw={animateDraw} drawKey={drawKey} onTileSelect={onTileSelect} />}
          </div>
          <div className="player-melds"><MeldArea seat={seat} callerSeat={playerSeat} melds={melds} /></div>
        </div>
      </div>
    </div>
  </section>;
}
function TenboIcon({ value }: { value: 100 | 300 | 1000 }) {
  return <span className={`tenbo tenbo-${value}`} aria-label={`${value} point stick`}><i /><i /><i /><i /><i /><i /><i /><i /></span>;
}
function CenterInformation({ boardState, scores, winds }: { boardState: GameState; scores: Record<Seat, number | null>; winds: Record<Seat, string> }) {
  const doraIndicators = boardState.dora_indicators;
  const honba = boardState.honba;
  const kyotaku = boardState.kyotaku;
  const roundLabel = boardState.round_label ? String(boardState.round_label).replace(/\s*\d+本場/g, "").trim() : "—";
  return <div className="center-information" aria-label="Round information">
    <div className="center-seat-score center-seat-score-top"><div className="center-seat-score-inner"><span>{winds.top}</span><CenterScore score={scores.top} /></div></div>
    <div className="center-seat-score center-seat-score-left"><div className="center-seat-score-inner"><span>{winds.left}</span><CenterScore score={scores.left} /></div></div>
    <div className="center-seat-score center-seat-score-right"><div className="center-seat-score-inner"><span>{winds.right}</span><CenterScore score={scores.right} /></div></div>
    <div className="center-seat-score center-seat-score-bottom"><div className="center-seat-score-inner"><span>{winds.bottom}</span><CenterScore score={scores.bottom} /></div></div>
    <div className="center-core">
      <div className="center-round">{roundLabel}</div>
      <div className="center-counters"><span className="center-tiles-left"><small>×</small><span className="center-tiles-left-value">{boardState.tiles_remaining ?? "—"}</span></span><div className="center-sticks" aria-label={`${kyotaku ?? "unknown"} riichi sticks and ${honba ?? "unknown"} honba counters`}>
        <div className="tenbo-row"><TenboIcon value={1000} /><span>× {kyotaku ?? "—"}</span></div>
        <div className="tenbo-row"><TenboIcon value={300} /><span>× {honba ?? "—"}</span></div>
      </div></div>
      <div className="center-dora" aria-label="Dora indicators">{Array.from({ length: 5 }, (_, index) => {
        const tile = doraIndicators[index];
        return tile ? <Tile tile={tile} key={`${tile}-${index}`} /> : <TileBack className="center-dora-slot" key={`hidden-dora-${index}`} ariaLabel="Hidden dora indicator" />;
      })}</div>
    </div>
  </div>;
}
function CenterTable({ boardState, scores, winds, rivers }: { boardState: GameState; scores: Record<Seat, number | null>; winds: Record<Seat, string>; rivers: Record<Seat, DiscardRiverState> }) {
  return <section className="center-table" aria-label="Mahjong center table">
    <DiscardRiver seat="top" tiles={rivers.top.tiles} riichiIndices={rivers.top.riichiIndices} tsumogiriIndices={rivers.top.tsumogiriIndices} />
    <DiscardRiver seat="left" tiles={rivers.left.tiles} riichiIndices={rivers.left.riichiIndices} tsumogiriIndices={rivers.left.tsumogiriIndices} />
    <CenterInformation boardState={boardState} scores={scores} winds={winds} />
    <DiscardRiver seat="right" tiles={rivers.right.tiles} riichiIndices={rivers.right.riichiIndices} tsumogiriIndices={rivers.right.tsumogiriIndices} />
    <DiscardRiver seat="bottom" tiles={rivers.bottom.tiles} riichiIndices={rivers.bottom.riichiIndices} tsumogiriIndices={rivers.bottom.tsumogiriIndices} />
  </section>;
}
function MahjongTable({ boardState, score, pond, meldTiles, closedCount, boardHand, drawnTile, onTileSelect, callTile, callTileIsRiichi, callFromSeat, currentActor, currentAction, drawKey }: MahjongTableProps) {
  const analyzed = boardState.analyzed_player;
  const scores = (Object.keys(seatIndex) as Seat[]).reduce((result, seat) => ({ ...result, [seat]: score(seatIndex[seat]) }), {} as Record<Seat, number | null>);
  const winds = (Object.keys(seatIndex) as Seat[]).reduce((result, seat) => {
    const windNames = ["東", "南", "西", "北"];
    const dealer = Number.isInteger(boardState.dealer) ? boardState.dealer! : 0;
    return { ...result, [seat]: windNames[(seatIndex[seat] - dealer + 4) % 4] };
  }, {} as Record<Seat, string>);
  const rivers = (Object.keys(seatIndex) as Seat[]).reduce((result, seat) => {
    const playerSeat = seatIndex[seat];
    const player = boardState.players[playerSeat];
    const tiles = pond(playerSeat);
    const riichiIndices = [...(player?.riichi_discard_indices ?? [])];
    if (callTileIsRiichi && callFromSeat === playerSeat && callTile) {
      const offeredTileIndex = tiles.map(normalizeTile).lastIndexOf(normalizeTile(callTile));
      if (offeredTileIndex >= 0 && !riichiIndices.includes(offeredTileIndex)) riichiIndices.push(offeredTileIndex);
    }
    return { ...result, [seat]: { tiles, riichiIndices, tsumogiriIndices: player?.tsumogiri_discard_indices ?? [] } };
  }, {} as Record<Seat, { tiles: string[]; riichiIndices: number[]; tsumogiriIndices: number[] }>);
  const shouldReveal = (playerSeat: number) => currentAction === "win"
    ? currentActor === playerSeat
    : (currentAction === "exhaustive_draw" || currentAction === "draw_end" || currentAction === "ryuukyoku")
      && boardState.players[playerSeat]?.is_tenpai === true;
  return <div className="mahjong-table">
    <PlayerZone seat="top" playerSeat={2} wind="西" score={scores.top} melds={meldTiles(2)} closedCount={closedCount(2)} revealedHand={boardState.players[2]?.revealed_hand} winningTile={currentAction === "win" && currentActor === 2 ? boardState.winning_tile : undefined} winType={currentAction === "win" && currentActor === 2 ? boardState.win_type : undefined} revealHand={shouldReveal(2)} drawnTile={undefined} drawHidden={currentAction === "draw" && currentActor === 2} drawKey={drawKey} animateDraw={currentAction === "draw" && currentActor === 2} />
    <PlayerZone seat="left" playerSeat={3} wind="北" score={scores.left} melds={meldTiles(3)} closedCount={closedCount(3)} revealedHand={boardState.players[3]?.revealed_hand} winningTile={currentAction === "win" && currentActor === 3 ? boardState.winning_tile : undefined} winType={currentAction === "win" && currentActor === 3 ? boardState.win_type : undefined} revealHand={shouldReveal(3)} drawnTile={undefined} drawHidden={currentAction === "draw" && currentActor === 3} drawKey={drawKey} animateDraw={currentAction === "draw" && currentActor === 3} />
    <CenterTable boardState={boardState} scores={scores} winds={winds} rivers={rivers} />
    <PlayerZone seat="right" playerSeat={1} wind="南" score={scores.right} melds={meldTiles(1)} closedCount={closedCount(1)} revealedHand={boardState.players[1]?.revealed_hand} winningTile={currentAction === "win" && currentActor === 1 ? boardState.winning_tile : undefined} winType={currentAction === "win" && currentActor === 1 ? boardState.win_type : undefined} revealHand={shouldReveal(1)} drawnTile={undefined} drawHidden={currentAction === "draw" && currentActor === 1} drawKey={drawKey} animateDraw={currentAction === "draw" && currentActor === 1} />
    <PlayerZone seat="bottom" playerSeat={analyzed} wind="東" score={scores.bottom} melds={meldTiles(analyzed)} closedCount={closedCount(analyzed)} hand={boardHand} onTileSelect={onTileSelect} revealedHand={boardState.players[analyzed]?.revealed_hand} winningTile={currentAction === "win" && currentActor === analyzed ? boardState.winning_tile : undefined} winType={currentAction === "win" && currentActor === analyzed ? boardState.win_type : undefined} drawnTile={currentAction === "win" ? undefined : drawnTile} drawHidden={false} drawKey={drawKey} animateDraw={currentAction === "draw" && currentActor === analyzed} revealHand={shouldReveal(analyzed)} active />
  </div>;
}

function ProductTopbar({ onNavigate, navigateLabel, online }: { onNavigate: () => void; navigateLabel: string; online?: boolean }) {
  return <header className="topbar"><div className="topbar-title">Riichi Study</div><div className="topbar-actions">{online !== undefined && <><span className="api-dot" data-online={online} /><span>{online ? "Synced" : "Local"}</span></>}<button className="topbar-navigation" onClick={onNavigate}>{navigateLabel}</button></div></header>;
}

type MainView = "home" | "training" | "stats";
function MainNavigation({ view, online, onNavigate }: { view: MainView; online: boolean; onNavigate: (view: MainView) => void }) {
  return <header className="topbar app-navigation"><div className="topbar-title">Riichi Study</div><nav aria-label="Main navigation">{(["home", "training", "stats"] as const).map((tab) => <button type="button" key={tab} aria-current={view === tab ? "page" : undefined} onClick={() => onNavigate(tab)}>{tab === "home" ? "Home" : tab === "training" ? "Trainer" : "Stats"}</button>)}</nav><div className="topbar-actions"><span className="api-dot" data-online={online} /><span>{online ? "Synced" : "Local"}</span></div></header>;
}

type GameMistakeStats = { source: TrainingSource; total: number; mistakes: number; categories: Record<string, number> };
function MistakeStats({ games, loading, error }: { games: GameMistakeStats[]; loading: boolean; error: string | null }) {
  const categoryTotals = games.reduce<Record<string, number>>((totals, game) => {
    for (const [category, count] of Object.entries(game.categories)) totals[category] = (totals[category] ?? 0) + count;
    return totals;
  }, {});
  const totalMistakes = games.reduce((total, game) => total + game.mistakes, 0);
  const rate = (game: GameMistakeStats) => game.total ? game.mistakes / game.total * 100 : 0;
  const points = games.map((game, index) => ({
    x: games.length <= 1 ? 50 : 50 + index * 700 / (games.length - 1),
    y: 190 - Math.min(rate(game), 100) * 1.7,
    game,
  }));
  const path = points.map(({ x, y }, index) => `${index ? "L" : "M"}${x},${y}`).join(" ");
  if (loading) return <section className="workspace stats-workspace"><h1>Stats</h1><p>Loading game statistics…</p></section>;
  if (error) return <section className="workspace stats-workspace"><h1>Stats</h1><p role="alert">{error}</p></section>;
  return <section className="workspace stats-workspace">
    <span className="eyebrow">YOUR PLAY</span><h1>Mistake rate</h1>
    <p className="stats-description">Mortal Mistakes as a percentage of all analyzed decisions in each imported game. Inaccuracies are excluded.</p>
    {games.length ? <>
      <div className="stats-chart-summary"><strong>{games.length}</strong><span>most recent games</span><strong>{totalMistakes}</strong><span>Mistakes</span><strong>{games.reduce((sum, game) => sum + game.total, 0) ? (totalMistakes / games.reduce((sum, game) => sum + game.total, 0) * 100).toFixed(1) : "0.0"}%</strong><span>overall rate</span></div>
      <div className="stats-chart-wrap"><svg className="mistake-rate-chart" viewBox="0 0 760 230" role="img" aria-label="Mistake rate by game for the last 100 imported games">
        {[0, 25, 50, 75, 100].map((tick) => <g key={tick}><line x1="48" x2="755" y1={190 - tick * 1.7} y2={190 - tick * 1.7} /><text x="40" y={194 - tick * 1.7}>{tick}%</text></g>)}
        {path && <path className="stats-chart-line" d={path} />}
        {points.map(({ x, y, game }, index) => <circle key={game.source.source_game_id} cx={x} cy={y} r={games.length > 40 ? 2.5 : 4}><title>{`Game ${index + 1}: ${rate(game).toFixed(1)}% (${game.mistakes} Mistakes / ${game.total} decisions)`}</title></circle>)}
        {games.length > 1 && <><text x="50" y="220">Oldest</text><text x="700" y="220">Newest</text></>}
      </svg></div>
      <div className="stats-category-section"><h2>Mistakes by category</h2><p>Share of all Mistakes in these games.</p>{Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).map(([category, count]) => <div className="stats-category-row" key={category}><span>{category.replace(/_/g, " ")}</span><div><i style={{ width: `${totalMistakes ? count / totalMistakes * 100 : 0}%` }} /></div><strong>{count}</strong><small>{totalMistakes ? (count / totalMistakes * 100).toFixed(1) : "0.0"}%</small></div>)}{!Object.keys(categoryTotals).length && <p>No Mortal Mistakes in these games yet.</p>}</div>
    </> : <p>Import a Mortal HTML report to see game statistics.</p>}
  </section>;
}

interface TrainingResult {
  correct: boolean;
  selectedTile: string | null;
  mortalTile: string | null;
  selectedAction: string | null;
  mortalAction: string | null;
  severity: Severity | null;
  playerPolicy: string | null;
  mortalPolicy: string | null;
}

function TrainingPanel({ memoryRating, isCall, callTile, callTileFromRiichi, callLabel, drawTile, postCallMeld, callOptions, category = "UNCLASSIFIED", result, categorySaving, categoryError, onCategoryChange, onCallSelect }: { memoryRating: ReactNode; isCall: boolean; callTile: string | null; callTileFromRiichi: boolean; callLabel: string; drawTile: string | null; postCallMeld: Meld | null; callOptions: string[]; category?: DecisionCategory; result: TrainingResult | null; categorySaving: boolean; categoryError: string | null; onCategoryChange: (category: Exclude<DecisionCategory, "UNCLASSIFIED">) => void; onCallSelect: (action: string) => void }) {
  const severityTone = result?.severity?.toLowerCase() ?? "";
  return <aside className="training-panel" aria-live="polite">
    <header className="training-panel-header">
      <div className="training-panel-head"><span className="eyebrow">TRAINING</span></div>
      {result && <div className="training-category"><span>{category.replace(/_/g, " ")}</span>{category === "TILE_EFFICIENCY" && <strong>牌効率</strong>}</div>}
    </header>
    <div className="training-panel-body">
      {!result ? <>
        <div className="training-question">
          {(isCall || drawTile || postCallMeld) && <div className="training-question-tile"><span>{isCall ? callLabel : postCallMeld ? calledMeldLabel(postCallMeld.kind) : "Your draw"}</span>{isCall && callTile ? <b className={callTileFromRiichi ? "training-riichi-call-tile" : undefined}><Tile tile={callTile} /></b> : drawTile ? <b><Tile tile={drawTile} /></b> : postCallMeld && <div className="training-question-meld"><MeldArea seat="bottom" callerSeat={0} melds={[postCallMeld]} /></div>}</div>}
          {isCall ? <><span className="training-select-hint">Call or pass?</span>{callOptions.map((action) => <button type="button" className="training-call-choice" key={action} onClick={() => onCallSelect(action)}><ActionWithTiles action={action} /></button>)}</> : <span className="training-select-hint">Choose a discard.</span>}
        </div>
      </> : <>
      <div className={`training-verdict ${result.correct ? "training-correct" : `severity-tone-${severityTone}`}`}>{result.correct ? "CORRECT" : result.severity?.toUpperCase() ?? "MISTAKE"}</div>
      <div className="training-result-moves">
        <div><span>YOU</span><b>{result.selectedAction ? <ActionWithTiles action={result.selectedAction} /> : result.selectedTile ? <Tile tile={result.selectedTile} /> : "—"}<small className={`training-move-percent severity-tone-${severityTone}`}>{result.playerPolicy ?? "—"}</small></b></div>
        <div><span>MORTAL</span><b>{result.mortalAction ? <ActionWithTiles action={result.mortalAction} /> : result.mortalTile ? <Tile tile={result.mortalTile} /> : "—"}<small className="training-move-percent training-move-percent-mortal">{result.mortalPolicy ?? "—"}</small></b></div>
      </div>
      {!result.correct && <div className="training-category-confirm"><label htmlFor="mistake-category">Category (optional)</label><select id="mistake-category" value={categoryOptions.some((option) => option.value === category) ? category : ""} disabled={categorySaving} onChange={(event) => onCategoryChange(event.target.value as Exclude<DecisionCategory, "UNCLASSIFIED">)}><option value="" disabled>Choose a category</option>{categoryOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>{categorySaving && <span>Saving…</span>}{categoryError && <span role="alert">{categoryError}</span>}</div>}
      {memoryRating}
      </>}
    </div>
  </aside>;
}

function FullGameReplay({ events, analyzedPlayer, onExit }: { events: ReplayEvent[]; analyzedPlayer: number; onExit: () => void }) {
  const [index, setIndex] = useState(0);
  const hasEvents = Array.isArray(events) && events.length > 0;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") setIndex((value) => Math.min(events.length - 1, value + 1));
      if (event.key === "ArrowLeft") setIndex((value) => Math.max(0, value - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [events.length]);
  if (!Array.isArray(events)) return <main className="app-shell"><section className="workspace"><h1>Replay unavailable</h1><p>The replay response did not contain an events array.</p></section></main>;
  if (!hasEvents) return <main className="app-shell"><section className="workspace"><h1>Replay is empty</h1><p>No replayable events were returned for this game.</p></section></main>;
  const safeIndex = Math.max(0, Math.min(index, events.length - 1));
  const event = events[safeIndex];
  const roundStarts = events.reduce<number[]>((starts, item, itemIndex) => {
    if (itemIndex === 0 || item.round_id !== events[itemIndex - 1].round_id) starts.push(itemIndex);
    return starts;
  }, []);
  const currentRound = Math.max(0, roundStarts.findIndex((start, roundIndex) => safeIndex < (roundStarts[roundIndex + 1] ?? events.length)));
  const previousRoundIndex = currentRound > 0 ? roundStarts[currentRound - 1] : 0;
  const nextRoundIndex = currentRound < roundStarts.length - 1 ? roundStarts[currentRound + 1] : events.length - 1;
  if (!event || !event.state || !Array.isArray(event.state.players)) return <main className="app-shell"><section className="workspace"><h1>Replay event unavailable</h1><p>Event {safeIndex + 1} has an invalid state payload.</p></section></main>;
  const getBoardStateFromReplayEvent = (replayEvent: ReplayEvent): GameState => {
    const source = replayEvent.state;
    const players = [0, 1, 2, 3].map((relativeSeat): PlayerState => {
      const player: PlayerState = source.players[(analyzedPlayer + relativeSeat) % 4]!;
      return {
        ...player,
        melds: player.melds.map((meld: Meld) => ({
          ...meld,
          called_from: meld.called_from == null
            ? meld.called_from
            : (meld.called_from - analyzedPlayer + 4) % 4,
        })),
      };
    });
    return { ...source, analyzed_player: 0, dealer: typeof source.dealer === "number" ? (source.dealer - analyzedPlayer + 4) % 4 : null, players, scores: [0, 1, 2, 3].map((relativeSeat) => source.scores[(analyzedPlayer + relativeSeat) % 4] ?? null) };
  };
  const state = getBoardStateFromReplayEvent(event);
  const relativeActor = typeof event.actor === "number" ? (event.actor - analyzedPlayer + 4) % 4 : analyzedPlayer;
  const score = (seat: number) => state.players[seat]!.score;
  const pond = (seat: number) => state.players[seat]!.discards;
  const meldTiles = (seat: number) => state.players[seat]?.melds ?? [];
  const closedCount = (seat: number) => state.players[seat]?.concealed_count ?? (seat === state.analyzed_player ? state.concealed_hand.length : Math.max(0, 13 - meldTiles(seat).flatMap((meld) => meld.tiles).length));
  return <main className="app-shell"><ProductTopbar onNavigate={onExit} navigateLabel="Training" />
    <section className="workspace replay-workspace">
      <div className="table-wrap"><MahjongTable boardState={state} score={score} pond={pond} meldTiles={meldTiles} closedCount={closedCount} boardHand={state.concealed_hand ?? []} drawnTile={state.drawn_tile} currentActor={relativeActor} currentAction={event.action} drawKey={safeIndex} /></div>
      <div className="replay-controls"><button onClick={() => setIndex(previousRoundIndex)} disabled={currentRound === 0}>Previous round</button><button onClick={() => setIndex(Math.max(0, index - 1))} disabled={index === 0}>Previous event</button><span><b>Round {currentRound + 1} / {roundStarts.length}</b> · event {index + 1} / {events.length} · {event.action}{event.tile ? ` · ${event.tile}` : ""} · seat {event.actor}</span><button onClick={() => setIndex(Math.min(events.length - 1, index + 1))} disabled={index >= events.length - 1}>Next event</button><button onClick={() => setIndex(nextRoundIndex)} disabled={currentRound >= roundStarts.length - 1}>Next round</button></div>
    </section></main>;
}

export function HomePage() {
  const [selected, setSelected] = useState(0);
  const currentDecisionId = useRef<string | null>(null);
  const [selectedDiscard, setSelectedDiscard] = useState<string | null>(null);
  const [selectedCall, setSelectedCall] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState("checking");
  const [reportDecisions, setReportDecisions] = useState<TrainingDecision[]>([]);
  const [allReportDecisions, setAllReportDecisions] = useState<TrainingDecision[]>([]);
  const [trainingItems, setTrainingItems] = useState<TrainingItem[]>([]);
  const [statsGames, setStatsGames] = useState<GameMistakeStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [sourceFile, setSourceFile] = useState("no imported game");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<MainView>("home");
  const [dueReviewMode, setDueReviewMode] = useState(false);
  const [dueReviewError, setDueReviewError] = useState<string | null>(null);
  const [categoryAssignments, setCategoryAssignments] = useState<Record<string, DecisionCategory>>(() => { try { return JSON.parse(localStorage.getItem(categoryStorageKey) ?? "{}"); } catch { return {}; } });
  const [categorySaving, setCategorySaving] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [serverAnnotationsReady, setServerAnnotationsReady] = useState(false);
  const [nearDueMode, setNearDueMode] = useState(false);
  const [nearCycleReviewed, setNearCycleReviewed] = useState<Set<string>>(() => new Set());
  const [scheduleClock, setScheduleClock] = useState(() => new Date());
  const decision = reportDecisions[selected];
  const activeSourceId = decision?.sourceGameId ?? sourceFile;
  currentDecisionId.current = decision?.id ?? null;
  useEffect(() => {
    if (!allReportDecisions.length || dueReviewMode) return;
    const at = scheduleClock;
    if (Number.isNaN(at.getTime())) return;
    const dueNow = availableTrainingDecisions(allReportDecisions, trainingItems, sourceFile, at);
    let available = dueNow;
    if (nearDueMode) {
      const nearDue = availableTrainingDecisions(allReportDecisions, trainingItems, sourceFile, at, nearDueWindowMs);
      if (!nearDue.length) {
        setNearDueMode(false);
        setNearCycleReviewed(new Set());
      } else {
        const remainingThisCycle = nearDue.filter((item) => !nearCycleReviewed.has(item.id));
        if (remainingThisCycle.length) available = remainingThisCycle;
        else {
          setNearCycleReviewed(new Set());
          available = nearDue;
        }
      }
    } else if (!dueNow.length) {
      const nearDue = availableTrainingDecisions(allReportDecisions, trainingItems, sourceFile, at, nearDueWindowMs);
      if (nearDue.length) {
        setNearDueMode(true);
        setNearCycleReviewed(new Set());
        available = nearDue;
      }
    }
    const shuffled = shuffle(available);
    setReportDecisions(shuffled);
    const activeIndex = currentDecisionId.current == null ? -1 : shuffled.findIndex((item) => item.id === currentDecisionId.current);
    if (activeIndex >= 0) setSelected(activeIndex);
    else {
      setSelected((current) => Math.max(0, Math.min(current, available.length - 1)));
      setSelectedDiscard(null);
      setSelectedCall(null);
      setSubmitted(false);
    }
  }, [allReportDecisions, trainingItems, sourceFile, nearDueMode, nearCycleReviewed, scheduleClock, dueReviewMode]);
  useEffect(() => {
    if (import.meta.env.DEV || nearDueMode) return;
    const now = Date.now();
    const nextDue = trainingItems
      .filter((item) => item.source_game_id === sourceFile && item.reps > 0)
      .map((item) => new Date(item.due_at).getTime())
      .filter((due) => due > now && due - now <= nearDueWindowMs)
      .sort((a, b) => a - b)[0];
    if (nextDue == null) return;
    const timeout = window.setTimeout(() => setScheduleClock(new Date()), Math.max(250, nextDue - now));
    return () => window.clearTimeout(timeout);
  }, [import.meta.env.DEV, nearDueMode, trainingItems, sourceFile, scheduleClock]);
  useEffect(() => {
    if (viewMode !== "training") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      let nextIndex = selected;
      if (event.key === "ArrowRight") {
        return;
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        nextIndex = Math.max(0, selected - 1);
      } else {
        return;
      }
      if (nextIndex === selected) return;
      setSelected(nextIndex);
      setSelectedDiscard(null);
      setSelectedCall(null);
      setSubmitted(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewMode, selected, reportDecisions.length]);
  useEffect(() => {
    fetchHealth().then((health) => setStatus(health.status)).catch(() => setStatus("offline"));
    fetchTrainingAnnotations().then((annotations) => {
      setServerAnnotationsReady(true);
      const saved: Record<string, DecisionCategory> = { ...categoryAssignments };
      for (const [id, annotation] of Object.entries(annotations)) saved[id] = annotation.category as DecisionCategory;
      setCategoryAssignments(saved);
      localStorage.setItem(categoryStorageKey, JSON.stringify(saved));
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!submitted || !decision || !hasSelectedMove || !result || result.correct) return;
    const record: MistakeRecord = {
      decision_id: decision.id, source_file: activeSourceId, severity: decision.severity,
      category: categoryAssignments[decision.id] ?? decision.category,
      user_action: (selectedCall ?? selectedDiscard)!,
      user_policy: callDecision ? policyForAction(decision.actions, selectedCall!) : policyForTile(decision.actions, selectedDiscard!),
      mortal_action: decision.mortalAction, mortal_policy: decision.mortalPolicy,
      reviewed_at: new Date().toISOString(),
    };
    saveTrainingMistake(record).catch(() => undefined);
  }, [submitted, selected, decision?.id, categoryAssignments, selectedCall, selectedDiscard, activeSourceId]);
  const confirmCategory = async (category: Exclude<DecisionCategory, "UNCLASSIFIED">) => {
    if (!decision) return;
    setCategorySaving(true); setCategoryError(null);
    const next = { ...categoryAssignments, [decision.id]: category };
    setCategoryAssignments(next);
    localStorage.setItem(categoryStorageKey, JSON.stringify(next));
    try {
      if (serverAnnotationsReady) await saveTrainingAnnotation(decision.id, category);
    } catch (err) {
      setCategoryError(err instanceof Error ? `${err.message}; saved on this device` : "Could not sync category; saved on this device");
    } finally { setCategorySaving(false); }
  };
  const enterDueReview = async () => {
    setViewMode("training");
    setDueReviewError(null);
    try {
      const [allDueItems, sources] = await Promise.all([fetchDueTrainingItems(), fetchTrainingSources()]);
      const importedSourceIds = new Set(sources.filter((source) => source.imported_at).map((source) => source.source_game_id));
      const dueItems = allDueItems.filter((item) => importedSourceIds.has(item.source_game_id));
      const sourceIds = [...new Set(dueItems.map((item) => item.source_game_id))];
      const resolvedSources = await Promise.all(sourceIds.map(async (id) => [
        id,
        await fetchTrainingSourceDecisions(id),
      ] as const));
      const decisionsBySource = new Map(resolvedSources.map(([id, decisions]) => [
        id,
        new Map(decisions.map((item) => [item.id, toTrainingDecision(item)])),
      ]));
      const dueDecisions = dueItems.map((item) => {
        const resolved = decisionsBySource.get(item.source_game_id)?.get(item.decision_id);
        if (!resolved) {
          throw new Error(`Decision '${item.decision_id}' is missing from saved source game '${item.source_game_id}'. Re-upload the original report to restore it.`);
        }
        return { ...resolved, sourceGameId: item.source_game_id, category: item.category as DecisionCategory };
      });
      setTrainingItems((current) => {
        const byItemId = new Map(current.map((item) => [item.id, item]));
        dueItems.forEach((item) => byItemId.set(item.id, item));
        return [...byItemId.values()];
      });
      setDueReviewMode(true);
      setReportDecisions(shuffle(dueDecisions));
      setSelected(0);
      setSelectedDiscard(null);
      setSelectedCall(null);
      setSubmitted(false);
    } catch (err) {
      setDueReviewError(err instanceof Error ? err.message : "Could not load due mistakes");
    }
  };
  const exitDueReview = () => {
    setDueReviewMode(false);
    setDueReviewError(null);
    setSelected(0);
    setSelectedDiscard(null);
    setSelectedCall(null);
    setSubmitted(false);
  };
  const changeView = (view: MainView) => {
    setViewMode(view);
    if (view === "stats") {
      setStatsLoading(true);
      setStatsError(null);
      void fetchTrainingSources().then(async (sources) => {
        const recent = sources.filter((source) => source.imported_at).slice(0, 100).reverse();
        const games = await Promise.all(recent.map(async (source) => {
          const decisions = await fetchTrainingSourceDecisions(source.source_game_id);
          const mistakes = decisions.filter((item) => item.severity === "MISTAKE");
          const categories: Record<string, number> = {};
          for (const item of mistakes) {
            const category = item.category ?? "UNCLASSIFIED";
            categories[category] = (categories[category] ?? 0) + 1;
          }
          return { source, total: decisions.length, mistakes: mistakes.length, categories };
        }));
        setStatsGames(games);
      }).catch((err) => setStatsError(err instanceof Error ? err.message : "Could not load game statistics")).finally(() => setStatsLoading(false));
    }
  };
  const importReport = async (file: File) => {
    setImporting(true); setImportError(null); setImportNotice(null);
    try {
      const report = await importTrainingReport(file);
      const sourceId = report.source_game_id ?? report.source_file;
      const items = await fetchTrainingItems(sourceId);
      setSourceFile(sourceId); setTrainingItems(items);
      const decisions = report.decisions.map(toTrainingDecision).map((item) => ({ ...item, sourceGameId: sourceId }));
      setAllReportDecisions(decisions.filter((item) => item.severity === "MISTAKE" || item.severity === "INACCURACY"));
      setDueReviewMode(false); setDueReviewError(null); setSelected(0);
      setSelectedDiscard(null); setSelectedCall(null); setSubmitted(false);
      setImportNotice(`${report.source_file} imported. ${decisions.length} review decisions are ready.`);
      setViewMode("training");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Could not import this report");
    } finally { setImporting(false); }
  };
  if (viewMode === "home") return <main className="app-shell home-app-shell"><MainNavigation view="home" online={status === "ok"} onNavigate={changeView} /><section className="workspace home-workspace">
    <h1>Riichi Study</h1>
    <p className="home-subtitle">Review your decisions. Improve one hand at a time.</p>
    <div className="home-action-row">
      <button type="button" className="home-tile home-tile-train" onClick={() => void enterDueReview()}><span className="home-tile-face" aria-hidden="true">白</span><span className="home-tile-label">TRAIN</span><span className="home-tile-description">Review mistakes and train.</span></button>
      <button type="button" className="home-tile home-tile-stats" onClick={() => changeView("stats")}><span className="home-tile-face" aria-hidden="true">發</span><span className="home-tile-label">STATS</span><span className="home-tile-description">View your progress and statistics.</span></button>
      <label className={`home-tile home-tile-import${importing ? " is-importing" : ""}`}><input type="file" accept=".html,text/html" disabled={importing} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importReport(file); event.currentTarget.value = ""; }} /><span className="home-tile-face" aria-hidden="true">中</span><span className="home-tile-label">{importing ? "IMPORTING" : "IMPORT"}</span><span className="home-tile-description">Import an MJAI review report.</span></label>
    </div>
    {importError && <p className="home-message" role="alert">{importError}</p>}{importNotice && <p className="home-message" role="status">{importNotice}</p>}
  </section></main>;
  if (viewMode === "stats") return <main className="app-shell"><MainNavigation view="stats" online={status === "ok"} onNavigate={changeView} /><MistakeStats games={statsGames} loading={statsLoading} error={statsError} /></main>;
  if (!decision) return <main className="app-shell"><MainNavigation view="training" online={status === "ok"} onNavigate={changeView} /><section className="workspace"><h1>{dueReviewMode ? "No due mistakes" : allReportDecisions.length ? "Deck finished" : "No training discrepancies"}</h1><p>{dueReviewMode ? "You’ve reviewed every currently due mistake." : allReportDecisions.length ? "You’ve finished the deck. No more cards are due within the next 10 minutes." : "Import a Mortal HTML report to start training."}</p>{dueReviewError && <p role="alert">{dueReviewError}</p>}<button type="button" onClick={dueReviewMode ? exitDueReview : () => void enterDueReview()}>{dueReviewMode ? "Return to Training" : "Review Due Mistakes"}</button></section></main>;
  const boardState = decision.state;
  const callDecision = isCallDecision(boardState.legal_actions);
  const callOptions = boardState.legal_actions
    .filter((action) => isCallAction(action) || isPassAction(action))
    .sort((left, right) => callActionPriority(left) - callActionPriority(right) || left.localeCompare(right, undefined, { numeric: true }));
  const analyzedPlayer = boardState.analyzed_player;
  const boardPlayers = [0, 1, 2, 3].map((relativeSeat) => {
    const sourceSeat = (analyzedPlayer + relativeSeat) % 4;
    const source = boardState.players[sourceSeat]!;
    return {
      ...source,
      seat: relativeSeat,
      melds: source.melds.map((meld: Meld) => ({
        ...meld,
        called_from: meld.called_from == null ? meld.called_from : (meld.called_from - analyzedPlayer + 4) % 4,
      })),
    };
  });
  const relativeBoardState = {
    ...boardState,
    analyzed_player: 0,
    dealer: typeof boardState.dealer === "number" ? (boardState.dealer - analyzedPlayer + 4) % 4 : null,
    players: boardPlayers,
    scores: [0, 1, 2, 3].map((relativeSeat) => boardState.scores[(analyzedPlayer + relativeSeat) % 4]),
  };
  const boardHand = relativeBoardState.concealed_hand;
  const drawnTile = callDecision ? null : relativeBoardState.drawn_tile;
  const playerMelds = boardPlayers[0]!.melds;
  const postCallMeld = !callDecision && !drawnTile && playerMelds.length > 0 && boardHand.length === 14 - 3 * playerMelds.length
    ? playerMelds[playerMelds.length - 1]!
    : null;
  const callFromSeat = callDecision ? relativeCallSeat(boardState.call_from) : null;
  const callTileIsRiichi = callDecision && boardState.call_tile_is_riichi;
  const callLabel = callFromSeat === 3 ? "Kamicha's discard" : callFromSeat === 2 ? "Toimen's discard" : callFromSeat === 1 ? "Shimocha's discard" : "Opponent discard";
  const score = (seat: number) => boardPlayers[seat]!.score;
  const pond = (seat: number) => {
    const discards = boardPlayers[seat]!.discards;
    if (!callDecision || callFromSeat !== seat || !boardState.call_tile) return discards;
    const riichiIndices = boardPlayers[seat]!.riichi_discard_indices;
    const offeredRiichiTileIsPresent = discards.some((tile, index) =>
      sameTile(tile, boardState.call_tile) && riichiIndices.includes(index));
    // The replay snapshot can already contain this offered discard without it
    // being the final river tile. Avoid appending a duplicate, which loses its
    // riichi-discard index and renders the duplicate vertically.
    return sameTile(discards[discards.length - 1] ?? null, boardState.call_tile) || offeredRiichiTileIsPresent
      ? discards
      : [...discards, boardState.call_tile];
  };
  // Preserve the aka/red-five suffix when extracting a tile from review text.
  // Without the optional `r`, 5mr was normalized to 5m and lost its Dora art.
  const meldTiles = (seat: number): Meld[] => boardPlayers[seat]?.melds ?? [];
  const closedCount = (seat: number) => boardPlayers[seat]?.concealed_count ?? Math.max(0, 13 - meldTiles(seat).flatMap((meld) => meld.tiles).length);
  const selectedMortalTile = callDecision ? null : actionTile(decision.mortalAction);
  const matchesMortal = callDecision
    ? normalizeAction(selectedCall) === normalizeAction(decision.mortalAction)
    : sameTile(selectedDiscard, selectedMortalTile);
  const matchesReportedMove = callDecision
    ? normalizeAction(selectedCall) === normalizeAction(decision.actualAction)
    : sameTile(selectedDiscard, actionTile(decision.actualAction));
  const hasSelectedMove = callDecision ? selectedCall !== null : selectedDiscard !== null;
  const result: TrainingResult | null = submitted && hasSelectedMove ? {
    correct: matchesMortal,
    selectedTile: callDecision ? null : selectedDiscard,
    mortalTile: selectedMortalTile,
    selectedAction: callDecision ? selectedCall : null,
    mortalAction: callDecision ? decision.mortalAction : null,
    severity: matchesMortal || !matchesReportedMove ? null : decision.severity,
    playerPolicy: callDecision
      ? policyForAction(decision.actions, selectedCall!) === null ? null : formatPolicy(policyForAction(decision.actions, selectedCall!)!)
      : selectedDiscard ? formatPolicy(policyForTile(decision.actions, selectedDiscard)) : null,
    mortalPolicy: formatPolicy(decision.mortalPolicy),
  } : null;
  const selectProblem = (index: number) => {
    setSelected(index);
    setSelectedDiscard(null);
    setSelectedCall(null);
    setSubmitted(false);
  };
  const submitDiscard = (tile: string) => {
    setSelectedDiscard(tile);
    setSubmitted(true);
  };
  const submitCall = (action: string) => {
    setSelectedCall(action);
    setSubmitted(true);
  };
  const currentCardReps = trainingItems.find((item) => item.source_game_id === activeSourceId && item.decision_id === decision.id)?.reps ?? 0;
  return <main className="app-shell">
    <MainNavigation view="training" online={status === "ok"} onNavigate={changeView} />
    <section className="workspace trainer-workspace">
      <div className="training-session-controls"><div><strong>{dueReviewMode ? "Review Due Mistakes" : "Training session"}</strong><span>{reportDecisions.length} {dueReviewMode ? "due mistakes remaining" : "discrepancies in this session · Inaccuracy and Mistake"}</span>{dueReviewError && <p role="alert">{dueReviewError}</p>}</div><div><button type="button" onClick={dueReviewMode ? exitDueReview : () => void enterDueReview()}>{dueReviewMode ? "Exit due review" : "Review Due Mistakes"}</button></div></div>
      <div className="training-layout">
        <div className="training-board"><div className="table-wrap"><MahjongTable boardState={relativeBoardState} score={score} pond={pond} meldTiles={meldTiles} closedCount={closedCount} boardHand={boardHand} drawnTile={drawnTile} onTileSelect={submitted || callDecision ? undefined : submitDiscard} callTile={boardState.call_tile} callTileIsRiichi={callTileIsRiichi} callFromSeat={callFromSeat} drawKey={decision.id} /></div></div>
        <TrainingPanel memoryRating={result ? <MemoryRatingControls key={`${activeSourceId}:${decision.id}:${currentCardReps}`} item={{ source_game_id: activeSourceId, decision_id: decision.id, category: dueReviewMode ? decision.category : categoryAssignments[decision.id] ?? decision.category, severity: decision.severity }} review={{ user_action: (selectedCall ?? selectedDiscard)!, model_action: decision.mortalAction, was_correct: result.correct }} onRated={(saved) => { setTrainingItems((current) => [...current.filter((item) => item.id !== saved.id), saved]); if (dueReviewMode) { setReportDecisions((current) => current.filter((item) => item.id !== decision.id)); setSelected(0); } else if (nearDueMode) setNearCycleReviewed((current) => new Set(current).add(decision.id)); setSubmitted(false); setSelectedDiscard(null); setSelectedCall(null); }} /> : null} isCall={callDecision} callTile={boardState.call_tile} callTileFromRiichi={callTileIsRiichi} callLabel={callLabel} drawTile={drawnTile} postCallMeld={postCallMeld} callOptions={callOptions} category={dueReviewMode ? decision.category : categoryAssignments[decision.id] ?? decision.category} result={result} categorySaving={categorySaving} categoryError={categoryError} onCategoryChange={confirmCategory} onCallSelect={submitCall} />
      </div>
    </section>
  </main>;
}
