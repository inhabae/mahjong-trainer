import { MemoryRatingControls } from "../components/MemoryRatingControls";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { checkRiichiDiscard, deleteUnreviewedTrainingItem, fetchHealth, fetchTrainingAnnotations, fetchTrainingItems, fetchTrainingSourceDecisions, fetchTrainingSources, importTrainingReport, resetTrainingData, saveTrainingAnnotation, saveTrainingMistake, undoTrainingAnnotation, undoTrainingMistake, undoTrainingReview } from "../api/client";
import type { MistakeRecord, RiichiCheck, TrainingSource } from "../api/client";
import type { ActionEvaluation, DecisionCategory, GameState, Meld, PlayerState, ReplayEvent, ReconstructedDecision, Severity } from "../types/review";
import type { TrainingItem } from "../types/training";

type TrainingDecision = { id: string; sourceGameId?: string; actualAction: string | null; mortalAction: string | null; severity: Severity; category: DecisionCategory; mortalPolicy: number | null; actions: ActionEvaluation[]; state: GameState; afterRiichiDeclaration?: boolean };
type AnswerUndo = {
  decision: TrainingDecision;
  selectedIndex: number;
  submittedAt: string;
  selectedDiscard: string | null;
  selectedCall: string | null;
  selectedRiichi: boolean | null;
  previousCategory: DecisionCategory | null;
  changedCategory: DecisionCategory | null;
  categorySavedOnServer: boolean;
  categorySave: Promise<void> | null;
  correct: boolean;
  nearCycleReviewed: Set<string>;
  mistakeSave: Promise<{ previous_record: MistakeRecord | null } | null> | null;
  mistakeSaveCategory: DecisionCategory | null;
  savedItem: TrainingItem | null;
};
const categoryOptions: { value: Exclude<DecisionCategory, "UNCLASSIFIED">; label: string }[] = [
  { value: "CALL_DECISION", label: "Call decision" }, { value: "RIICHI_DECISION", label: "Riichi decision" },
  { value: "PUSH_FOLD", label: "Push / fold" }, { value: "BETAORI", label: "Betaori" },
  { value: "TILE_EFFICIENCY", label: "Tile efficiency" }, { value: "ENDGAME_PLACEMENT", label: "Endgame placement" },
];
const categoryStorageKey = "mahjong-training-categories-v1";
const starredQuestionsStorageKey = "mahjong-training-starred-questions-v1";
const nearDueWindowMs = 10 * 60 * 1000;

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
function availableTrainingDecisions(decisions: TrainingDecision[], items: TrainingItem[], at: Date, horizonMs = 0): TrainingDecision[] {
  const bySourceAndId = new Map(items.map((item) => [`${item.source_game_id}:${item.decision_id}`, item]));
  return decisions.filter((decision) => {
    const card = bySourceAndId.get(`${decision.sourceGameId ?? ""}:${decision.id}`);
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
  selectableTiles?: string[];
}
const honorCodes: Record<string, string> = { "1": "1z", "2": "2z", "3": "3z", "4": "4z", "5": "5z", "6": "6z", "7": "7z", e: "1z", s: "2z", w: "3z", n: "4z", c: "5z", f: "6z", p: "7z" };
const honorFiles: Record<string, string> = { "1z": "Ton", "2z": "Nan", "3z": "Shaa", "4z": "Pei", "5z": "Chun", "6z": "Hatsu", "7z": "Haku" };
function normalizeTile(tile: string) {
  if (/^5[mps]r$/.test(tile)) return `0${tile[1]}`;
  return honorCodes[tile] ?? tile;
}
function actionTile(action: string | null): string | null {
  return action?.match(/(?:^|\s)([0-9][mps]r?|[1-7]z|[東南西北中發白]|[epwsfcn])(?=$|\s)/u)?.[1] ?? null;
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
function isRiichiAction(action: string | null): boolean {
  return /riichi|reach|立直|リーチ/iu.test(action ?? "");
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
function markPostRiichiDecisions(decisions: TrainingDecision[]): TrainingDecision[] {
  return decisions.map((decision, index) => {
    const previous = decisions[index - 1];
    const followsRiichi = previous !== undefined
      && previous.state.round_id === decision.state.round_id
      && previous.state.turn === decision.state.turn
      && isRiichiAction(previous.actualAction);
    return { ...decision, afterRiichiDeclaration: followsRiichi };
  });
}
function isMistakeForStats(item: ReconstructedDecision): boolean {
  const playerPolicy = item.mortal?.player_policy;
  return item.severity !== "MATCH" && playerPolicy != null && playerPolicy < 0.05;
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
function DrawnTile({ tile, hidden, animate, eventKey, onTileSelect, selectableTiles }: { tile?: string; hidden: boolean; animate: boolean; eventKey: string; onTileSelect?: (tile: string) => void; selectableTiles?: string[] }) {
  if (!hidden && !tile) return null;
  const canSelect = !!onTileSelect && (!selectableTiles || selectableTiles.some((candidate) => sameTile(candidate, tile ?? null)));
  return <span key={eventKey} className={`drawn-tile ${animate ? "drawn-tile-animated" : ""}`}>{hidden ? <TileBack className="tile-drawn-back" /> : <Tile tile={tile!} onClick={canSelect ? () => onTileSelect(tile!) : undefined} />}</span>;
}
function PlayerHand({ seat, standingTiles, concealedCount, drawnTile, drawHidden, animateDraw, drawKey, onTileSelect, selectableTiles }: { seat: Seat; standingTiles?: string[] | null; concealedCount: number; drawnTile?: string | null; drawHidden: boolean; animateDraw: boolean; drawKey: string | number; onTileSelect?: (tile: string) => void; selectableTiles?: string[] }) {
  const tilesToRender = standingTiles ? sortTiles(standingTiles) : undefined;
  return <div className={`hand-tiles player-hand-${seat}`}>
    {tilesToRender
      ? tilesToRender.map((tile, index) => <Tile key={`${tile}-${index}`} tile={tile} onClick={onTileSelect && (!selectableTiles || selectableTiles.some((candidate) => sameTile(candidate, tile))) ? () => onTileSelect(tile) : undefined} />)
      : Array.from({ length: concealedCount }, (_, index) => <TileBack key={`back-${index}`} />)}
    <span className="draw-gap" aria-hidden="true" />
    <span className="draw-area"><DrawnTile tile={drawnTile ?? undefined} hidden={drawHidden} animate={animateDraw} eventKey={`draw-${drawKey}-${seat}`} onTileSelect={onTileSelect} selectableTiles={selectableTiles} /></span>
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
function PlayerZone({ seat, playerSeat, wind, score, melds, closedCount, hand, revealedHand, winningTile, winType, drawnTile, drawHidden = false, drawKey, animateDraw = false, revealHand = false, active = false, onTileSelect, selectableTiles }: { seat: Seat; playerSeat: number; wind: string; score: number | null; melds: Meld[]; closedCount: number; hand?: string[] | null; revealedHand?: string[] | null; winningTile?: string | null; winType?: string | null; drawnTile?: string | null; drawHidden?: boolean; drawKey: string | number; animateDraw?: boolean; revealHand?: boolean; active?: boolean; onTileSelect?: (tile: string) => void; selectableTiles?: string[] }) {
  const side = seat === "left" || seat === "right";
  return <section className={`player-zone player-zone-${seat} ${active ? "player-zone-active" : ""}`}>
    <div className="player-zone-content">
      <div className="hand-anchor">
        <div className="hand-flow">
          <div className={`concealed-hand concealed-hand-${seat}`}>
            {revealHand && revealedHand ? <WinningHand seat={seat} tiles={revealedHand} winningTile={winningTile} winType={winType} /> : <PlayerHand seat={seat} standingTiles={hand} concealedCount={closedCount} drawnTile={drawnTile} drawHidden={drawHidden} animateDraw={animateDraw} drawKey={drawKey} onTileSelect={onTileSelect} selectableTiles={selectableTiles} />}
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
function MahjongTable({ boardState, score, pond, meldTiles, closedCount, boardHand, drawnTile, onTileSelect, callTile, callTileIsRiichi, callFromSeat, currentActor, currentAction, drawKey, selectableTiles }: MahjongTableProps) {
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
    <PlayerZone seat="bottom" playerSeat={analyzed} wind="東" score={scores.bottom} melds={meldTiles(analyzed)} closedCount={closedCount(analyzed)} hand={boardHand} onTileSelect={onTileSelect} selectableTiles={selectableTiles} revealedHand={boardState.players[analyzed]?.revealed_hand} winningTile={currentAction === "win" && currentActor === analyzed ? boardState.winning_tile : undefined} winType={currentAction === "win" && currentActor === analyzed ? boardState.win_type : undefined} drawnTile={currentAction === "win" ? undefined : drawnTile} drawHidden={false} drawKey={drawKey} animateDraw={currentAction === "draw" && currentActor === analyzed} revealHand={shouldReveal(analyzed)} active />
  </div>;
}

function ProductTopbar({ onNavigate, navigateLabel, online }: { onNavigate: () => void; navigateLabel: string; online?: boolean }) {
  return <header className="topbar"><div className="topbar-title">Riichi Study</div><div className="topbar-actions">{online !== undefined && <><span className="api-dot" data-online={online} /><span>{online ? "Synced" : "Local"}</span></>}<button className="topbar-navigation" onClick={onNavigate}>{navigateLabel}</button></div></header>;
}

type MainView = "home" | "training" | "stats";
function MainNavigation({ view, online, onNavigate }: { view: MainView; online: boolean; onNavigate: (view: MainView) => void }) {
  return <header className="topbar app-navigation"><div className="topbar-title">Riichi Study</div><nav aria-label="Main navigation">{(["home", "training", "stats"] as const).map((tab) => <button type="button" key={tab} aria-current={view === tab ? "page" : undefined} onClick={() => onNavigate(tab)}>{tab === "home" ? "Home" : tab === "training" ? "Trainer" : "Stats"}</button>)}</nav><div className="topbar-actions"><span className="api-dot" data-online={online} /><span>{online ? "Synced" : "Local"}</span></div></header>;
}

type GameMistakeStats = { source: TrainingSource; total: number; mistakes: number; categories: Record<string, number>; decisions: ReconstructedDecision[] };
function MistakeStats({ games, loading, error, resetBusy, resetNotice, resetError, onReset, onImport, importing, starredQuestions, onToggleQuestionStar, onOpenQuestion, categoryAssignments }: {
  games: GameMistakeStats[]; loading: boolean; error: string | null; resetBusy: boolean;
  resetNotice: string | null; resetError: string | null; onReset: () => void;
  onImport: (file: File) => void; importing: boolean;
  starredQuestions: string[]; onToggleQuestionStar: (key: string) => void;
  onOpenQuestion: (sourceGameId: string, decisionId: string) => void;
  categoryAssignments: Record<string, DecisionCategory>;
}) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [questionStats, setQuestionStats] = useState<{ source: TrainingSource; decision: ReconstructedDecision; item?: TrainingItem }[]>([]);
  const [detailsNow, setDetailsNow] = useState(() => Date.now());
  useEffect(() => {
    if (!detailsOpen) return;
    const timer = window.setInterval(() => setDetailsNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [detailsOpen]);
  const showQuestionStats = async () => {
    setDetailsOpen(true);
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const sources = (await fetchTrainingSources()).filter((source) => source.imported_at);
      const rows = await Promise.all(sources.map(async (source) => {
        const [decisions, items] = await Promise.all([
          fetchTrainingSourceDecisions(source.source_game_id),
          fetchTrainingItems(source.source_game_id),
        ]);
        const byDecision = new Map(items.map((item) => [item.decision_id, item]));
        return decisions
          .filter((decision) => decision.severity === "MISTAKE" || decision.severity === "INACCURACY")
          .map((decision) => ({ source, decision, item: byDecision.get(decision.id) }));
      }));
      setQuestionStats(rows.flat());
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : "Could not load question statistics");
    } finally {
      setDetailsLoading(false);
    }
  };
  const displayDate = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "—";
  const categoryTotals = games.reduce<Record<string, number>>((totals, game) => {
    for (const [category, count] of Object.entries(game.categories)) totals[category] = (totals[category] ?? 0) + count;
    return totals;
  }, {});
  const totalMistakes = games.reduce((total, game) => total + game.mistakes, 0);
  const totalDecisions = games.reduce((total, game) => total + game.total, 0);
  const rollingWindowSize = 10;
  const points = games.map((game, index) => {
    const firstGame = Math.max(0, index - rollingWindowSize + 1);
    const windowGames = games.slice(firstGame, index + 1);
    const windowMistakes = windowGames.reduce((total, item) => total + item.mistakes, 0);
    const windowDecisions = windowGames.reduce((total, item) => total + item.total, 0);
    const rollingRate = windowDecisions ? windowMistakes / windowDecisions * 100 : 0;
    const rawRate = game.total ? game.mistakes / game.total * 100 : 0;
    return {
      x: games.length <= 1 ? 50 : 50 + index * 700 / (games.length - 1),
      rollingRate,
      rawRate,
      windowGames: windowGames.length,
      windowMistakes,
      windowDecisions,
      game,
    };
  });
  const axisMax = Math.min(100, Math.max(5, Math.ceil(Math.max(...points.map((point) => point.rollingRate), 0) / 5) * 5));
  const chartY = (rate: number) => 190 - rate / axisMax * 170;
  const pointsWithY = points.map((point) => ({ ...point, y: chartY(point.rollingRate) }));
  const path = pointsWithY.map(({ x, y }, index) => `${index ? "L" : "M"}${x},${y}`).join(" ");
  const tenMinutesFromNow = detailsNow + 10 * 60 * 1000;
  const newQuestionCount = questionStats.filter(({ item }) => !item || item.reps === 0).length;
  const dueSoonCount = questionStats.filter(({ item }) => item && item.reps > 0 && new Date(item.due_at).getTime() <= tenMinutesFromNow).length;
  const dueLaterCount = questionStats.filter(({ item }) => item && item.reps > 0 && new Date(item.due_at).getTime() > tenMinutesFromNow).length;
  const heading = <div className="stats-heading"><div><span className="eyebrow">YOUR PLAY</span><h1>Mistake rate</h1></div><div className="stats-heading-actions"><button className="stats-details-button" type="button" onClick={() => void showQuestionStats()}>Question details</button><button className="stats-reset-button" type="button" onClick={onReset} disabled={resetBusy}>{resetBusy ? "Resetting…" : "Reset stats & trainer"}</button></div></div>;
  const resetMessages = <>{resetError && <p className="stats-reset-message" role="alert">{resetError}</p>}{resetNotice && <p className="stats-reset-message" role="status">{resetNotice}</p>}</>;
  if (loading) return <section className="workspace stats-workspace">{heading}{resetMessages}<p>Loading game statistics…</p></section>;
  if (error) return <section className="workspace stats-workspace">{heading}{resetMessages}<p role="alert">{error}</p></section>;
  return <section className="workspace stats-workspace">
    {heading}{resetMessages}
    {detailsOpen && <div className="stats-details-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailsOpen(false); }}><section className="stats-details-dialog" role="dialog" aria-modal="true" aria-labelledby="stats-details-title"><div className="stats-details-heading"><div><span className="eyebrow">TRAINING SCHEDULE</span><h2 id="stats-details-title">Question details</h2></div><button type="button" aria-label="Close question details" onClick={() => setDetailsOpen(false)}>Close</button></div>{detailsLoading ? <p>Loading question statistics…</p> : detailsError ? <p role="alert">{detailsError}</p> : questionStats.length ? <><div className="stats-question-counts"><div><strong>{dueSoonCount}</strong><span>Due now or within 10 minutes</span></div><div><strong>{newQuestionCount}</strong><span>New · no attempts yet</span></div><div><strong>{dueLaterCount}</strong><span>Due more than 10 minutes from now</span></div></div><div className="stats-details-table-wrap"><table className="stats-details-table"><thead><tr><th>Star</th><th>Game</th><th>Question</th><th>Severity / category</th><th>Schedule</th><th>Reps</th><th>Lapses</th><th>Interval (days)</th><th>Stability</th><th>Difficulty</th><th>Learning step</th><th>Last rating</th><th>Last reviewed</th><th>Due</th><th>Created</th><th>Updated</th></tr></thead><tbody>{questionStats.map(({ source, decision, item }) => { const starKey = `${source.source_game_id}:${decision.id}`; const isStarred = starredQuestions.includes(starKey); return <tr key={starKey}><td><button type="button" className={`question-star-button${isStarred ? " is-starred" : ""}`} aria-label={isStarred ? "Unstar question" : "Star question"} aria-pressed={isStarred} onClick={() => onToggleQuestionStar(starKey)}>{isStarred ? "★" : "☆"}</button></td><td><button type="button" className="stats-question-link" onClick={() => onOpenQuestion(source.source_game_id, decision.id)}>{source.source_filename}</button></td><td>{decision.round_label ?? decision.round_id} · Turn {decision.state.turn ?? "—"}<br />You: {decision.actual_action ?? "—"}<br />Mortal: {decision.mortal_action ?? "—"}</td><td>{decision.severity}<br />{(categoryAssignments[decision.id] ?? item?.category ?? decision.category).replace(/_/g, " ")}</td><td>{item?.state ?? "Not scheduled"}</td><td>{item?.reps ?? 0}</td><td>{item?.lapses ?? 0}</td><td>{item?.interval_days ?? 0}</td><td>{item?.stability?.toFixed(2) ?? "—"}</td><td>{item?.difficulty?.toFixed(2) ?? "—"}</td><td>{item?.learning_step ?? "—"}</td><td>{item?.last_rating ?? "—"}</td><td>{displayDate(item?.last_reviewed_at)}</td><td>{displayDate(item?.due_at)}</td><td>{displayDate(item?.created_at)}</td><td>{displayDate(item?.updated_at)}</td></tr>; })}</tbody></table></div></> : <p>No training questions found in the imported games.</p>}</section></div>}
    {games.length > 0 && <p className="stats-description">Imported games only · Mistakes count only when Mortal gives your move under 5% probability · Weighted rolling rate across up to 10 games</p>}
    {games.length ? <>
      <div className="stats-chart-summary"><strong>{games.length}</strong><span>most recent games</span><strong>{totalMistakes}</strong><span>Mistakes</span><strong>{totalDecisions ? (totalMistakes / totalDecisions * 100).toFixed(1) : "0.0"}%</strong><span>overall rate</span></div>
      <div className="stats-chart-wrap"><svg className="mistake-rate-chart" viewBox="0 0 760 230" role="img" aria-label="Weighted rolling 10-game Mortal Mistake rate across the last 100 imported games">
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => { const tick = axisMax * fraction; const y = chartY(tick); return <g key={fraction}><line x1="48" x2="755" y1={y} y2={y} /><text x="40" y={y + 4}>{tick.toFixed(tick % 1 ? 1 : 0)}%</text></g>; })}
        {path && <path className="stats-chart-line" d={path} />}
        {pointsWithY.map(({ x, y, game, rollingRate, rawRate, windowGames, windowMistakes, windowDecisions }, index) => <circle key={game.source.source_game_id} cx={x} cy={y} r={games.length > 40 ? 2.5 : 4}><title>{`Through game ${index + 1}: ${rollingRate.toFixed(1)}% rolling rate over ${windowGames} game${windowGames === 1 ? "" : "s"} (${windowMistakes} Mistakes / ${windowDecisions} decisions). This game: ${rawRate.toFixed(1)}% (${game.mistakes} / ${game.total}).`}</title></circle>)}
        {games.length > 1 && <><text x="50" y="220">Oldest</text><text x="700" y="220">Newest</text></>}
      </svg></div>
      <div className="stats-category-section"><h2>Mistakes by category</h2><p>Share of all Mistakes in these games.</p>{Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).map(([category, count]) => <div className="stats-category-row" key={category}><span>{category.replace(/_/g, " ")}</span><div><i style={{ width: `${totalMistakes ? count / totalMistakes * 100 : 0}%` }} /></div><strong>{count}</strong><small>{totalMistakes ? (count / totalMistakes * 100).toFixed(1) : "0.0"}%</small></div>)}{!Object.keys(categoryTotals).length && <p>No Mortal Mistakes in these games yet.</p>}</div>
    </> : <div className="stats-empty-state">
      <div className="stats-empty-mark" aria-hidden="true">發</div>
      <div className="stats-empty-copy"><span className="eyebrow">YOUR FIRST REPORT</span><h2>Your stats will take shape here</h2><p>Import a Mortal HTML report to see your mistake rate across games and which decision categories need the most attention.</p><p className="stats-empty-note">Training answers don’t affect these stats. Only imported game reports are counted.</p></div>
      <button type="button" className="stats-import-button" onClick={() => importInputRef.current?.click()} disabled={importing}>{importing ? "Importing report…" : "Import Mortal report"} <span aria-hidden="true">↗</span></button>
      <input ref={importInputRef} className="stats-import-input" type="file" accept=".html,text/html" aria-label="Import a Mortal HTML report" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onImport(file); event.currentTarget.value = ""; }} />
      <div className="stats-empty-preview" aria-hidden="true"><div><span>MISTAKE RATE</span><strong>—</strong><small>Waiting for games</small></div><div className="stats-preview-chart"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div><span>TOP CATEGORY</span><strong>—</strong><small>Appears after import</small></div></div>
    </div>}
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

function TrainingPanel({ memoryRating, isCall, callTile, callTileFromRiichi, callLabel, drawTile, postCallMeld, callOptions, selectedDiscard, afterRiichiDeclaration = false, category = "UNCLASSIFIED", result, categorySaving, categoryError, onCategoryChange, onCallSelect, riichiCheck, riichiCheckBusy, riichiCheckError, onRiichiSelect }: { memoryRating: ReactNode; isCall: boolean; callTile: string | null; callTileFromRiichi: boolean; callLabel: string; drawTile: string | null; postCallMeld: Meld | null; callOptions: string[]; selectedDiscard: string | null; afterRiichiDeclaration?: boolean; category?: DecisionCategory; result: TrainingResult | null; categorySaving: boolean; categoryError: string | null; onCategoryChange: (category: Exclude<DecisionCategory, "UNCLASSIFIED">) => void; onCallSelect: (action: string) => void; riichiCheck: RiichiCheck | null; riichiCheckBusy: boolean; riichiCheckError: string | null; onRiichiSelect: (riichi: boolean) => void }) {
  const severityTone = result?.severity?.toLowerCase() ?? "";
  return <aside className="training-panel" aria-live="polite">
    <header className="training-panel-header">
      <div className="training-panel-head"><span className="eyebrow">TRAINING</span></div>
      {result && <div className="training-category"><span>{category.replace(/_/g, " ")}</span>{category === "TILE_EFFICIENCY" && <strong>牌効率</strong>}</div>}
    </header>
    <div className="training-panel-body">
      {!result ? <>
        <div className="training-question">
          {afterRiichiDeclaration
            ? <div className="training-question-tile"><span>You declared riichi</span></div>
            : (isCall || drawTile || postCallMeld) && <div className="training-question-tile"><span>{isCall ? callLabel : postCallMeld ? calledMeldLabel(postCallMeld.kind) : "Your draw"}</span>{isCall && callTile ? <b className={callTileFromRiichi ? "training-riichi-call-tile" : undefined}><Tile tile={callTile} /></b> : drawTile ? <b><Tile tile={drawTile} /></b> : postCallMeld && <div className="training-question-meld"><MeldArea seat="bottom" callerSeat={0} melds={[postCallMeld]} /></div>}</div>}
          {isCall ? <><span className="training-select-hint">Call or pass?</span>{callOptions.map((action) => <button type="button" className="training-call-choice" key={action} onClick={() => onCallSelect(action)}><ActionWithTiles action={action} /></button>)}</> : riichiCheckBusy ? <span className="training-select-hint">Checking the hand after this discard…</span> : riichiCheck?.can_riichi && selectedDiscard ? <div className="training-riichi-choice">
            <span className="training-select-hint">Riichi or dama?</span>
            <button type="button" className="training-call-choice" onClick={() => onRiichiSelect(true)}>Riichi</button>
            <button type="button" className="training-call-choice" onClick={() => onRiichiSelect(false)}>Dama</button>
          </div> : <><span className="training-select-hint">Choose a discard.</span>{riichiCheckError && <span role="status">{riichiCheckError}</span>}</>}
        </div>
      </> : <>
      <div className={`training-verdict ${result.correct ? "training-correct" : result.severity ? `severity-tone-${severityTone}` : "training-unrated"}`}>{result.correct ? "CORRECT" : result.severity?.toUpperCase() ?? "NO POLICY DATA"}</div>
      <div className="training-result-moves">
        <div><span>YOU</span><b>{result.selectedAction ? <><ActionWithTiles action={result.selectedAction} />{isRiichiAction(result.selectedAction) && result.selectedTile && <Tile tile={result.selectedTile} />}</> : result.selectedTile ? <Tile tile={result.selectedTile} /> : "—"}<small className={`training-move-percent severity-tone-${severityTone}`}>{result.playerPolicy ?? "—"}</small></b></div>
        <div><span>MORTAL</span><b>{result.mortalAction ? <><ActionWithTiles action={result.mortalAction} />{isRiichiAction(result.mortalAction) && result.mortalTile && <Tile tile={result.mortalTile} />}</> : result.mortalTile ? <Tile tile={result.mortalTile} /> : "—"}<small className="training-move-percent training-move-percent-mortal">{result.mortalPolicy ?? "—"}</small></b></div>
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
  const [selectedRiichi, setSelectedRiichi] = useState<boolean | null>(null);
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);
  const [riichiCheck, setRiichiCheck] = useState<RiichiCheck | null>(null);
  const [riichiCheckBusy, setRiichiCheckBusy] = useState(false);
  const [riichiCheckError, setRiichiCheckError] = useState<string | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const answerUndoRef = useRef<AnswerUndo | null>(null);
  const undoQuestionHandlerRef = useRef<() => void>(() => undefined);
  const ratingSavingRef = useRef(false);
  const undoAfterRatingRef = useRef(false);
  const restoreQuestionIdRef = useRef<string | null>(null);
  const requestedTrainingQuestionRef = useRef<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState("checking");
  const [reportDecisions, setReportDecisions] = useState<TrainingDecision[]>([]);
  const [allReportDecisions, setAllReportDecisions] = useState<TrainingDecision[]>([]);
  const [trainingItems, setTrainingItems] = useState<TrainingItem[]>([]);
  const [starredQuestions, setStarredQuestions] = useState<string[]>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem(starredQuestionsStorageKey) ?? "[]"); return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
  });
  const [statsGames, setStatsGames] = useState<GameMistakeStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<MainView>("home");
  const [trainingLoading, setTrainingLoading] = useState(false);
  const [trainingError, setTrainingError] = useState<string | null>(null);
  const [categoryAssignments, setCategoryAssignments] = useState<Record<string, DecisionCategory>>(() => { try { return JSON.parse(localStorage.getItem(categoryStorageKey) ?? "{}"); } catch { return {}; } });
  const [categorySaving, setCategorySaving] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [nearDueMode, setNearDueMode] = useState(false);
  const [nearCycleReviewed, setNearCycleReviewed] = useState<Set<string>>(() => new Set());
  const [scheduleClock, setScheduleClock] = useState(() => new Date());
  const decision = reportDecisions[selected];
  const activeSourceId = decision?.sourceGameId ?? "";
  const toggleQuestionStar = (key: string) => {
    setStarredQuestions((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      localStorage.setItem(starredQuestionsStorageKey, JSON.stringify(next));
      return next;
    });
  };
  currentDecisionId.current = decision ? `${decision.sourceGameId ?? ""}:${decision.id}` : null;
  useEffect(() => {
    if (!allReportDecisions.length) return;
    const at = scheduleClock;
    if (Number.isNaN(at.getTime())) return;
    const dueNow = availableTrainingDecisions(allReportDecisions, trainingItems, at);
    let available = dueNow;
    if (nearDueMode) {
      const nearDue = availableTrainingDecisions(allReportDecisions, trainingItems, at, nearDueWindowMs);
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
      const nearDue = availableTrainingDecisions(allReportDecisions, trainingItems, at, nearDueWindowMs);
      if (nearDue.length) {
        setNearDueMode(true);
        setNearCycleReviewed(new Set());
        available = nearDue;
      }
    }
    const shuffled = shuffle(available);
    if (requestedTrainingQuestionRef.current) {
      const requestedId = requestedTrainingQuestionRef.current;
      const requestedQuestion = allReportDecisions.find((item) => `${item.sourceGameId ?? ""}:${item.id}` === requestedId);
      requestedTrainingQuestionRef.current = null;
      if (requestedQuestion) {
        setReportDecisions([requestedQuestion, ...shuffled.filter((item) => `${item.sourceGameId ?? ""}:${item.id}` !== requestedId)]);
        setSelected(0);
        setSelectedDiscard(null);
        setSelectedCall(null);
        setSelectedRiichi(null);
        setSubmitted(false);
        setSubmittedAt(null);
        setRiichiCheck(null); setRiichiCheckBusy(false); setRiichiCheckError(null);
        return;
      }
    }
    if (restoreQuestionIdRef.current) {
      const restoreIndex = shuffled.findIndex((item) => `${item.sourceGameId ?? ""}:${item.id}` === restoreQuestionIdRef.current);
      if (restoreIndex >= 0) {
        const [restoreQuestion] = shuffled.splice(restoreIndex, 1);
        setReportDecisions([restoreQuestion, ...shuffled]);
        setSelected(0);
        setSelectedDiscard(null);
        setSelectedCall(null);
        setSelectedRiichi(null);
        setSubmitted(false);
        setSubmittedAt(null);
        setRiichiCheck(null); setRiichiCheckBusy(false); setRiichiCheckError(null);
        restoreQuestionIdRef.current = null;
        return;
      }
    }
    setReportDecisions(shuffled);
    const activeIndex = currentDecisionId.current == null ? -1 : shuffled.findIndex((item) => `${item.sourceGameId ?? ""}:${item.id}` === currentDecisionId.current);
    if (activeIndex >= 0) setSelected(activeIndex);
    else {
      setSelected((current) => Math.max(0, Math.min(current, available.length - 1)));
      setSelectedDiscard(null);
      setSelectedCall(null);
      setSelectedRiichi(null);
      setSubmitted(false);
      setSubmittedAt(null);
      setRiichiCheck(null); setRiichiCheckBusy(false); setRiichiCheckError(null);
    }
  }, [allReportDecisions, trainingItems, nearDueMode, nearCycleReviewed, scheduleClock]);
  useEffect(() => {
    if (import.meta.env.DEV || nearDueMode) return;
    const now = Date.now();
    const nextDue = trainingItems
      .filter((item) => item.reps > 0)
      .map((item) => new Date(item.due_at).getTime())
      .filter((due) => due > now)
      .sort((a, b) => a - b)[0];
    if (nextDue == null) return;
    const timeout = window.setTimeout(() => setScheduleClock(new Date()), Math.max(250, Math.min(nextDue - now, 60 * 60 * 1000)));
    return () => window.clearTimeout(timeout);
  }, [import.meta.env.DEV, nearDueMode, trainingItems, scheduleClock]);
  useEffect(() => {
    if (viewMode !== "training") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoQuestionHandlerRef.current();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
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
      setSelectedRiichi(null);
      setSubmitted(false);
      setSubmittedAt(null);
      setRiichiCheck(null); setRiichiCheckBusy(false); setRiichiCheckError(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewMode, selected, reportDecisions.length]);
  useEffect(() => {
    fetchHealth().then((health) => setStatus(health.status)).catch(() => setStatus("offline"));
    fetchTrainingAnnotations().then((annotations) => {
      const serverCategories: Record<string, DecisionCategory> = {};
      for (const [id, annotation] of Object.entries(annotations)) serverCategories[id] = annotation.category as DecisionCategory;
      setCategoryAssignments((current) => {
        // Local entries are manual choices too; keep them authoritative if
        // they changed while the initial server annotations were loading.
        const saved = { ...serverCategories, ...current };
        localStorage.setItem(categoryStorageKey, JSON.stringify(saved));
        return saved;
      });
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    const undo = answerUndoRef.current;
    if (!submitted || !decision || !hasSelectedMove || !result || !undo || undo.submittedAt !== submittedAt) return;
    undo.correct = result.correct;
    if (result.correct) return;
    const record: MistakeRecord = {
      decision_id: decision.id, source_file: activeSourceId, severity: decision.severity,
      category: categoryAssignments[decision.id] ?? decision.category,
      user_action: (selectedRiichi ? "Riichi" : selectedCall ?? selectedDiscard)!,
      user_policy: selectedRiichi ? policyForAction(decision.actions, "Riichi") : callDecision ? policyForAction(decision.actions, selectedCall!) : policyForTile(decision.actions, selectedDiscard!),
      mortal_action: decision.mortalAction, mortal_policy: decision.mortalPolicy,
      reviewed_at: submittedAt!,
    };
    if (undo.mistakeSave && undo.mistakeSaveCategory === record.category) return;
    const earlierSave = undo.mistakeSave;
    undo.mistakeSaveCategory = record.category as DecisionCategory;
    undo.mistakeSave = earlierSave
      ? earlierSave.then(async (previous) => {
        await saveTrainingMistake(record);
        return previous;
      }).catch(() => null)
      : saveTrainingMistake(record).catch(() => null);
  }, [submitted, submittedAt, selected, decision?.id, categoryAssignments, selectedCall, selectedDiscard, selectedRiichi, activeSourceId]);
  const confirmCategory = async (category: Exclude<DecisionCategory, "UNCLASSIFIED">) => {
    if (!decision) return;
    setCategorySaving(true); setCategoryError(null);
    const next = { ...categoryAssignments, [decision.id]: category };
    setCategoryAssignments(next);
    localStorage.setItem(categoryStorageKey, JSON.stringify(next));
    const undo = answerUndoRef.current;
    if (undo && undo.decision.id === decision.id) {
      undo.changedCategory = category;
      undo.categorySavedOnServer = false;
    }
    try {
      const categorySave = saveTrainingAnnotation(decision.id, category).then(() => undefined);
      if (undo && undo.decision.id === decision.id) undo.categorySave = categorySave;
      await categorySave;
      if (undo && undo.decision.id === decision.id) undo.categorySavedOnServer = true;
    } catch (err) {
      setCategoryError(err instanceof Error ? `${err.message}; saved on this device` : "Could not sync category; saved on this device");
    } finally { setCategorySaving(false); }
  };
  const undoCurrentQuestion = async () => {
    if (undoBusy) return;
    if (ratingSavingRef.current) {
      undoAfterRatingRef.current = true;
      return;
    }
    const undo = answerUndoRef.current;
    const activeKey = decision ? `${decision.sourceGameId ?? ""}:${decision.id}` : null;
    const undoKey = undo ? `${undo.decision.sourceGameId ?? ""}:${undo.decision.id}` : null;
    if (undo && activeKey !== undoKey && (selectedDiscard || selectedCall || selectedRiichi !== null || riichiCheckBusy)) {
      setSelectedDiscard(null); setSelectedCall(null); setSelectedRiichi(null);
      setRiichiCheck(null); setRiichiCheckBusy(false); setRiichiCheckError(null);
      return;
    }
    if (!undo) {
      if (selectedDiscard || selectedCall || selectedRiichi !== null || riichiCheckBusy) {
        setSelectedDiscard(null); setSelectedCall(null); setSelectedRiichi(null);
        setRiichiCheck(null); setRiichiCheckBusy(false); setRiichiCheckError(null);
      }
      return;
    }
    setUndoBusy(true); setUndoError(null);
    try {
      if (!undo.correct && undo.mistakeSave) {
        const saved = await undo.mistakeSave;
        if (saved) await undoTrainingMistake({ decision_id: undo.decision.id, source_file: undo.decision.sourceGameId ?? "", reviewed_at: undo.submittedAt, previous_record: saved.previous_record });
      }
      if (undo.categorySave) await undo.categorySave.catch(() => undefined);
      if (undo.changedCategory && undo.changedCategory !== undo.previousCategory && undo.categorySavedOnServer) {
        await undoTrainingAnnotation(undo.decision.id, undo.changedCategory, undo.previousCategory);
      }
      let restoredItem: TrainingItem | null = null;
      if (undo.savedItem?.last_reviewed_at) {
        restoredItem = await undoTrainingReview(undo.savedItem.id, undo.savedItem.last_reviewed_at);
      } else if (undo.savedItem) {
        await deleteUnreviewedTrainingItem(undo.savedItem.id);
        setTrainingItems((current) => current.filter((item) => item.id !== undo.savedItem!.id));
      }
      if (restoredItem) {
        setTrainingItems((current) => [...current.filter((item) => item.id !== restoredItem!.id), restoredItem!]);
        restoreQuestionIdRef.current = `${undo.decision.sourceGameId ?? ""}:${undo.decision.id}`;
        setScheduleClock(new Date());
      }
      setNearCycleReviewed(undo.nearCycleReviewed);
      setCategoryAssignments((current) => {
        const restored = { ...current };
        if (undo.previousCategory) restored[undo.decision.id] = undo.previousCategory;
        else delete restored[undo.decision.id];
        localStorage.setItem(categoryStorageKey, JSON.stringify(restored));
        return restored;
      });
      answerUndoRef.current = null;
      setSubmitted(false); setSubmittedAt(null); setSelectedDiscard(null); setSelectedCall(null); setSelectedRiichi(null);
      setRiichiCheck(null); setRiichiCheckBusy(false); setRiichiCheckError(null);
      if (!restoredItem) setSelected(Math.min(undo.selectedIndex, Math.max(0, reportDecisions.length - 1)));
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : "Could not undo this question");
    } finally { setUndoBusy(false); }
  };
  undoQuestionHandlerRef.current = () => { void undoCurrentQuestion(); };
  const setRatingSaving = (saving: boolean) => {
    ratingSavingRef.current = saving;
    if (!saving && undoAfterRatingRef.current) {
      undoAfterRatingRef.current = false;
      queueMicrotask(() => undoQuestionHandlerRef.current());
    }
  };
  const startTraining = async (requestedQuestionId?: string) => {
    requestedTrainingQuestionRef.current = requestedQuestionId ?? null;
    setViewMode("training");
    setReportDecisions([]);
    setTrainingLoading(true);
    setTrainingError(null);
    try {
      const sources = (await fetchTrainingSources()).filter((source) => source.imported_at);
      const loaded = await Promise.all(sources.map(async (source) => {
        const [decisions, items] = await Promise.all([
          fetchTrainingSourceDecisions(source.source_game_id),
          fetchTrainingItems(source.source_game_id),
        ]);
        const itemCategories = new Map(items.map((item) => [item.decision_id, item.category as DecisionCategory]));
        return {
          decisions: markPostRiichiDecisions(decisions
            .map((item) => ({ ...toTrainingDecision(item), sourceGameId: source.source_game_id })))
            .filter((item) => item.severity === "MISTAKE" || item.severity === "INACCURACY")
            .map((item) => ({ ...item,
              category: categoryAssignments[item.id] ?? itemCategories.get(item.id) ?? item.category ?? "UNCLASSIFIED" })),
          items,
        };
      }));
      const decisions = loaded.flatMap((game) => game.decisions);
      const items = loaded.flatMap((game) => game.items);
      setAllReportDecisions(decisions);
      setTrainingItems(items);
      setReportDecisions([]);
      setNearDueMode(false);
      setNearCycleReviewed(new Set());
      setSelected(0);
      setSelectedDiscard(null);
      setSelectedCall(null);
      setSelectedRiichi(null); setSubmittedAt(null); setRiichiCheck(null); setRiichiCheckBusy(false); setRiichiCheckError(null);
      setSubmitted(false);
    } catch (err) {
      setTrainingError(err instanceof Error ? err.message : "Could not load training questions");
    } finally {
      setTrainingLoading(false);
    }
  };
  const changeView = (view: MainView) => {
    if (view === "training") void startTraining();
    else setViewMode(view);
    if (view === "stats") {
      setStatsLoading(true);
      setStatsError(null);
      setResetNotice(null);
      setResetError(null);
      void fetchTrainingSources().then(async (sources) => {
        const recent = sources.filter((source) => source.imported_at).slice(0, 100).reverse();
        const games = await Promise.all(recent.map(async (source) => {
          const decisions = await fetchTrainingSourceDecisions(source.source_game_id);
          const mistakes = decisions.filter(isMistakeForStats);
          const categories: Record<string, number> = {};
          for (const item of mistakes) {
            const category = categoryAssignments[item.id] ?? item.category ?? "UNCLASSIFIED";
            categories[category] = (categories[category] ?? 0) + 1;
          }
          return { source, total: decisions.length, mistakes: mistakes.length, categories, decisions };
        }));
        setStatsGames(games);
      }).catch((err) => setStatsError(err instanceof Error ? err.message : "Could not load game statistics")).finally(() => setStatsLoading(false));
    }
  };
  const resetAllTrainingData = async () => {
    const confirmed = window.confirm("Reset stats and trainer? This permanently deletes all imported games, saved mistake records, training cards, review history, and category assignments.");
    if (!confirmed) return;
    setResetBusy(true);
    setResetError(null);
    setResetNotice(null);
    try {
      await resetTrainingData();
      setStatsGames([]);
      setStatsError(null);
      setAllReportDecisions([]);
      setReportDecisions([]);
      setTrainingItems([]);
      setCategoryAssignments({});
      localStorage.removeItem(categoryStorageKey);
      localStorage.removeItem("mahjong-training-mistakes-v1");
      setNearDueMode(false);
      setNearCycleReviewed(new Set());
      setSelected(0);
      setSelectedDiscard(null);
      setSelectedCall(null);
      setSelectedRiichi(null); setSubmittedAt(null); setRiichiCheck(null); setRiichiCheckBusy(false); setRiichiCheckError(null);
      setSubmitted(false);
      answerUndoRef.current = null;
      setResetNotice("Imported games and all training data have been cleared.");
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Could not reset stats and trainer");
    } finally {
      setResetBusy(false);
    }
  };
  const importReport = async (file: File) => {
    setImporting(true); setImportError(null); setImportNotice(null);
    try {
      const report = await importTrainingReport(file);
      const sourceId = report.source_game_id ?? report.source_file;
      const items = await fetchTrainingItems(sourceId);
      setTrainingItems(items);
      const decisions = markPostRiichiDecisions(report.decisions.map(toTrainingDecision).map((item) => ({ ...item, sourceGameId: sourceId })));
      setAllReportDecisions(decisions.filter((item) => item.severity === "MISTAKE" || item.severity === "INACCURACY"));
      setReportDecisions([]);
      setTrainingError(null); setSelected(0);
      setNearDueMode(false); setNearCycleReviewed(new Set());
      setSelectedDiscard(null); setSelectedCall(null); setSelectedRiichi(null); setSubmitted(false); setSubmittedAt(null);
      setRiichiCheck(null); setRiichiCheckBusy(false); setRiichiCheckError(null); answerUndoRef.current = null;
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
      <button type="button" className="home-tile home-tile-train" onClick={() => void startTraining()}><span className="home-tile-face" aria-hidden="true">白</span><span className="home-tile-label">TRAIN</span><span className="home-tile-description">Practice your saved questions.</span></button>
      <button type="button" className="home-tile home-tile-stats" onClick={() => changeView("stats")}><span className="home-tile-face" aria-hidden="true">發</span><span className="home-tile-label">STATS</span><span className="home-tile-description">View your progress and statistics.</span></button>
      <label className={`home-tile home-tile-import${importing ? " is-importing" : ""}`}><input type="file" accept=".html,text/html" disabled={importing} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importReport(file); event.currentTarget.value = ""; }} /><span className="home-tile-face" aria-hidden="true">中</span><span className="home-tile-label">{importing ? "IMPORTING" : "IMPORT"}</span><span className="home-tile-description">Import an MJAI review report.</span></label>
    </div>
    {importError && <p className="home-message" role="alert">{importError}</p>}{importNotice && <p className="home-message" role="status">{importNotice}</p>}
  </section></main>;
  if (viewMode === "stats") return <main className="app-shell"><MainNavigation view="stats" online={status === "ok"} onNavigate={changeView} /><MistakeStats games={statsGames} loading={statsLoading} error={statsError} resetBusy={resetBusy} resetNotice={resetNotice} resetError={resetError} onReset={() => void resetAllTrainingData()} onImport={(file) => void importReport(file)} importing={importing} starredQuestions={starredQuestions} onToggleQuestionStar={toggleQuestionStar} onOpenQuestion={(sourceGameId, decisionId) => { void startTraining(`${sourceGameId}:${decisionId}`); }} categoryAssignments={categoryAssignments} /></main>;
  if (trainingLoading || !decision) return <main className="app-shell"><MainNavigation view="training" online={status === "ok"} onNavigate={changeView} /><section className="workspace trainer-workspace"><div className="trainer-empty-card">{trainingLoading ? <><span className="eyebrow">TRAINING</span><h1>Gathering your questions</h1><p>Loading imported games and review progress…</p></> : trainingError ? <><span className="eyebrow">TRAINING</span><h1>Questions couldn’t load</h1><p role="alert">{trainingError}</p><button type="button" onClick={() => void startTraining()}>Try again</button></> : allReportDecisions.length ? <><span className="eyebrow">ALL CAUGHT UP</span><h1>No questions ready</h1><p>Your imported questions will return when they’re due for review.</p></> : <><span className="eyebrow">YOUR TRAINING</span><h1>Start with a game</h1><p>Import a Mortal HTML report and its review questions will appear here.</p></>}</div></section></main>;
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
  const mortalChoosesRiichi = !callDecision && isRiichiAction(decision.mortalAction);
  const selectedMortalTile = callDecision ? null : actionTile(decision.mortalAction);
  const riichiOptionSelected = selectedRiichi !== null;
  const isRiichiResult = !callDecision && selectedRiichi === true;
  const matchesMortal = callDecision
    ? normalizeAction(selectedCall) === normalizeAction(decision.mortalAction)
      : mortalChoosesRiichi
        ? isRiichiResult
      : sameTile(selectedDiscard, selectedMortalTile);
  const hasSelectedMove = callDecision ? selectedCall !== null : selectedDiscard !== null && (!riichiCheck?.can_riichi || riichiOptionSelected);
  const selectedPolicy = callDecision
    ? selectedCall ? policyForAction(decision.actions, selectedCall) : null
    : isRiichiResult ? policyForAction(decision.actions, "Riichi")
      : selectedDiscard ? policyForTile(decision.actions, selectedDiscard) : null;
  const selectedSeverity: Severity | null = selectedPolicy === null ? null
    : selectedPolicy >= 0.20 ? "REASONABLE"
      : selectedPolicy >= 0.05 ? "INACCURACY"
        : "MISTAKE";
  const result: TrainingResult | null = submitted && hasSelectedMove ? {
    correct: matchesMortal,
    selectedTile: callDecision ? null : selectedDiscard,
    mortalTile: selectedMortalTile,
    selectedAction: callDecision ? selectedCall : isRiichiResult ? "Riichi" : null,
    mortalAction: callDecision || mortalChoosesRiichi || riichiCheck?.can_riichi && normalizeAction(decision.mortalAction).includes("riichi") ? decision.mortalAction : null,
    severity: matchesMortal ? null : selectedSeverity,
    playerPolicy: formatPolicy(selectedPolicy),
    mortalPolicy: formatPolicy(decision.mortalPolicy),
  } : null;
  const actualActionIsRiichi = isRiichiAction(decision.actualAction);
  // Decision snapshots are pre-action. Once the answer reveals an actual
  // riichi declaration, show its deposited stick on the table without
  // changing the saved replay state.
  const displayedBoardState = result && actualActionIsRiichi
    ? { ...relativeBoardState, kyotaku: relativeBoardState.kyotaku == null ? null : relativeBoardState.kyotaku + 1 }
    : relativeBoardState;
  const submitAnswer = (tile: string | null, call: string | null, riichi: boolean | null) => {
    const answeredAt = new Date().toISOString();
    answerUndoRef.current = {
      decision, selectedIndex: selected, submittedAt: answeredAt,
      selectedDiscard: tile, selectedCall: call, selectedRiichi: riichi,
      previousCategory: categoryAssignments[decision.id] ?? null, changedCategory: null,
      categorySavedOnServer: false, categorySave: null, correct: false, nearCycleReviewed: new Set(nearCycleReviewed),
      mistakeSave: null, mistakeSaveCategory: null, savedItem: null,
    };
    setSubmittedAt(answeredAt);
    setSubmitted(true);
    setUndoError(null);
  };
  const submitDiscard = async (tile: string) => {
    setSelectedDiscard(tile);
    setSelectedCall(null);
    setSelectedRiichi(null);
    setRiichiCheck(null);
    setRiichiCheckError(null);
    if (decision.afterRiichiDeclaration) {
      submitAnswer(tile, null, null);
      return;
    }
    setRiichiCheckBusy(true);
    try {
      const check = await checkRiichiDiscard(boardState, tile);
      setRiichiCheck(check);
      if (!check.can_riichi) submitAnswer(tile, null, null);
    } catch (err) {
      setRiichiCheckError(err instanceof Error ? `Could not check riichi: ${err.message}` : "Could not check riichi; treating this as dama.");
      submitAnswer(tile, null, false);
    } finally { setRiichiCheckBusy(false); }
  };
  const submitRiichiChoice = (riichi: boolean) => {
    if (!selectedDiscard) return;
    setSelectedRiichi(riichi);
    submitAnswer(selectedDiscard, null, riichi);
  };
  const submitCall = (action: string) => {
    setSelectedCall(action);
    setSelectedDiscard(null);
    setSelectedRiichi(null);
    submitAnswer(null, action, null);
  };
  const currentCardReps = trainingItems.find((item) => item.source_game_id === activeSourceId && item.decision_id === decision.id)?.reps ?? 0;
  const currentQuestionStarKey = `${activeSourceId}:${decision.id}`;
  const currentQuestionStarred = starredQuestions.includes(currentQuestionStarKey);
  const selectableTiles = decision.afterRiichiDeclaration
    ? decision.state.legal_actions
      .filter((action) => /^(?:discard|打牌)(?:\s|$)/iu.test(action.trim()))
      .map(actionTile)
      .filter((tile): tile is string => tile !== null)
    : undefined;
  return <main className="app-shell">
    <MainNavigation view="training" online={status === "ok"} onNavigate={changeView} />
    <section className="workspace trainer-workspace">
      <div className="training-session-controls"><div><span className="eyebrow">YOUR TRAINING · SHUFFLED</span><strong>Question <b>{selected + 1}</b><small>of {reportDecisions.length}</small></strong><p>Choose your move from the table.</p></div><div className="training-session-status"><button type="button" className={`training-question-star${currentQuestionStarred ? " is-starred" : ""}`} aria-label={currentQuestionStarred ? "Unstar question" : "Star question"} aria-pressed={currentQuestionStarred} onClick={() => toggleQuestionStar(currentQuestionStarKey)}>{currentQuestionStarred ? "★" : "☆"}<span>{currentQuestionStarred ? "Starred" : "Star question"}</span></button><div className="training-ready-badge"><span aria-hidden="true">白</span><div><b>{reportDecisions.length}</b><small>READY</small></div></div><small>⌘Z to undo</small></div></div>
      {undoError && <p className="home-message" role="alert">{undoError}</p>}
      <div className="training-layout">
        <div className="training-board"><div className="table-wrap"><MahjongTable boardState={displayedBoardState} score={score} pond={pond} meldTiles={meldTiles} closedCount={closedCount} boardHand={boardHand} drawnTile={drawnTile} onTileSelect={submitted || callDecision || riichiCheckBusy ? undefined : (tile) => { void submitDiscard(tile); }} callTile={boardState.call_tile} callTileIsRiichi={callTileIsRiichi} callFromSeat={callFromSeat} drawKey={decision.id} selectableTiles={selectableTiles} /></div></div>
        <TrainingPanel memoryRating={result ? <MemoryRatingControls key={`${activeSourceId}:${decision.id}:${currentCardReps}`} item={{ source_game_id: activeSourceId, decision_id: decision.id, category: categoryAssignments[decision.id] ?? decision.category, severity: decision.severity }} review={{ user_action: (selectedRiichi ? "Riichi" : selectedCall ?? selectedDiscard)!, model_action: decision.mortalAction, was_correct: result.correct }} onCreated={(created) => { if (!trainingItems.some((item) => item.id === created.id) && answerUndoRef.current?.decision.id === decision.id) answerUndoRef.current.savedItem = created; }} onSavingChange={setRatingSaving} onRated={(saved) => { setTrainingItems((current) => [...current.filter((item) => item.id !== saved.id), saved]); if (answerUndoRef.current?.decision.id === decision.id) answerUndoRef.current.savedItem = saved; if (nearDueMode) setNearCycleReviewed((current) => new Set(current).add(decision.id)); setSubmitted(false); setSubmittedAt(null); setSelectedDiscard(null); setSelectedCall(null); setSelectedRiichi(null); setRiichiCheck(null); }} /> : null} isCall={callDecision} callTile={boardState.call_tile} callTileFromRiichi={callTileIsRiichi} callLabel={callLabel} drawTile={drawnTile} postCallMeld={postCallMeld} callOptions={callOptions} selectedDiscard={selectedDiscard} afterRiichiDeclaration={decision.afterRiichiDeclaration} category={categoryAssignments[decision.id] ?? decision.category} result={result} categorySaving={categorySaving} categoryError={categoryError} onCategoryChange={confirmCategory} onCallSelect={submitCall} riichiCheck={riichiCheck} riichiCheckBusy={riichiCheckBusy} riichiCheckError={riichiCheckError} onRiichiSelect={submitRiichiChoice} />
      </div>
    </section>
  </main>;
}
