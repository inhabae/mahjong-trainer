import { Component, useEffect, useState } from "react";
import { fetchDefaultReplay, fetchDefaultReview, fetchHealth } from "../api/client";
import type { ActionEvaluation, GameState, Meld, PlayerState, ReplayEvent, ReplayResponse, ReconstructedDecision, Severity } from "../types/review";

type TrainingDecision = { id: string; actualAction: string | null; mortalAction: string | null; severity: Severity; mortalPolicy: number | null; actions: ActionEvaluation[]; state: GameState };
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
  return action?.match(/([0-9][mps]r?|[1-7]z|[東南西北中發白]|[epwsfc])/u)?.[1] ?? null;
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
  return /^(chi|chii|pon|kan|minkan|daiminkan|チー|ポン|カン)(?:\b|\s|$)/iu.test(action.trim());
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
function MahjongTable({ boardState, score, pond, meldTiles, closedCount, boardHand, drawnTile, onTileSelect, currentActor, currentAction, drawKey }: MahjongTableProps) {
  const analyzed = boardState.analyzed_player;
  const scores = (Object.keys(seatIndex) as Seat[]).reduce((result, seat) => ({ ...result, [seat]: score(seatIndex[seat]) }), {} as Record<Seat, number | null>);
  const winds = (Object.keys(seatIndex) as Seat[]).reduce((result, seat) => {
    const windNames = ["東", "南", "西", "北"];
    const dealer = Number.isInteger(boardState.dealer) ? boardState.dealer! : 0;
    return { ...result, [seat]: windNames[(seatIndex[seat] - dealer + 4) % 4] };
  }, {} as Record<Seat, string>);
  const rivers = (Object.keys(seatIndex) as Seat[]).reduce((result, seat) => {
    const player = boardState.players[seatIndex[seat]];
    return { ...result, [seat]: { tiles: pond(seatIndex[seat]), riichiIndices: player?.riichi_discard_indices ?? [], tsumogiriIndices: player?.tsumogiri_discard_indices ?? [] } };
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
  return <header className="topbar"><div className="topbar-title">Title Placeholder</div><div className="topbar-actions">{online !== undefined && <><span className="api-dot" data-online={online} /><span>{online ? "Synced" : "Local"}</span></>}<button className="topbar-navigation" onClick={onNavigate}>{navigateLabel}</button></div></header>;
}

interface TrainingResult {
  correct: boolean;
  selectedTile: string | null;
  mortalTile: string | null;
  selectedAction: string | null;
  mortalAction: string | null;
  severity: Severity | null;
  mortalPolicy: string | null;
  playerPolicy: string | null;
}

function TrainingPanel({ decisionNumber, total, isCall, callTile, callOptions, result, canNext, onCallSelect, onNext, onSkip }: { decisionNumber: number; total: number; isCall: boolean; callTile: string | null; callOptions: string[]; result: TrainingResult | null; canNext: boolean; onCallSelect: (action: string) => void; onNext: () => void; onSkip: () => void }) {
  return <aside className="training-panel" aria-live="polite">
    <header className="training-panel-header">
      <div className="training-panel-head"><span className="eyebrow">TRAINING</span><span className="training-decision-index">{String(decisionNumber).padStart(2, "0")} / {total}</span></div>
      {result && <div className="training-category"><span>TILE EFFICIENCY</span><strong>牌効率</strong></div>}
    </header>
    <div className="training-panel-body">
      {!result ? <>
        {isCall ? <div className="training-call-prompt"><div className="training-offered-discard"><span>Opponent discard</span>{callTile && <b><Tile tile={callTile} />{callTile}</b>}</div><span>Call or pass?</span>{callOptions.map((action) => <button type="button" className="training-call-choice" key={action} onClick={() => onCallSelect(action)}>{action}</button>)}</div> : <div className="training-select-hint">Your move</div>}
        <button type="button" className="training-skip" disabled={!canNext} onClick={onSkip}>Skip question →</button>
      </> : <>
      <div className={`training-verdict ${result.correct ? "training-correct" : ""}`}>{result.correct ? "CORRECT" : result.severity?.toUpperCase() ?? "MISTAKE"}</div>
      <div className="training-result-moves">
        <div><span>YOU</span><b>{result.selectedAction ?? (result.selectedTile ? <><Tile tile={result.selectedTile} />{result.selectedTile}</> : "—")}</b></div>
        <div><span>MORTAL</span><b>{result.mortalAction ?? (result.mortalTile ? <><Tile tile={result.mortalTile} />{result.mortalTile}</> : "—")}</b></div>
      </div>
      <div className="training-policy-delta"><span className="training-policy-player">{result.playerPolicy ?? "—"}</span><span className="training-policy-arrow">→</span><span className="training-policy-mortal">{result.mortalPolicy ?? "—"}</span></div>
      <button className="training-primary" disabled={!canNext} onClick={onNext}>Next</button>
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
  const [selectedDiscard, setSelectedDiscard] = useState<string | null>(null);
  const [selectedCall, setSelectedCall] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState("checking");
  const [reportDecisions, setReportDecisions] = useState<TrainingDecision[]>([]);
  const [sourceFile, setSourceFile] = useState("default report");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState<ReplayResponse | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayLoading, setReplayLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"training" | "replay">("training");
  const decision = reportDecisions[selected];
  useEffect(() => {
    if (viewMode !== "training") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      let nextIndex = selected;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        nextIndex = Math.min(Math.max(0, reportDecisions.length - 1), selected + 1);
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
    fetchDefaultReplay().then((value) => {
      if (!value || !Array.isArray(value.events)) throw new Error("Replay response has no events array");
      setReplay(value);
    }).catch((err) => setReplayError(err instanceof Error ? err.message : "Unable to load replay")).finally(() => setReplayLoading(false));
    fetchDefaultReview().then((review) => {
      setSourceFile(review.source_file);
      const reviewDecisions = review.decisions.map(toTrainingDecision);
      setReportDecisions(reviewDecisions);
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load the default report")).finally(() => setLoading(false));
  }, []);
  if (viewMode === "replay") {
    if (replayLoading) return <main className="app-shell"><section className="workspace"><h1>Full Game Replay</h1><p>Loading replay events…</p></section></main>;
    if (replayError) return <main className="app-shell"><section className="workspace"><h1>Replay unavailable</h1><p>{replayError}</p></section></main>;
    if (!replay) return <main className="app-shell"><section className="workspace"><h1>Replay unavailable</h1><p>The replay response is missing.</p></section></main>;
    return <ReplayErrorBoundary><FullGameReplay events={replay.events} analyzedPlayer={replay.analyzed_player} onExit={() => setViewMode("training")} /></ReplayErrorBoundary>;
  }
  if (loading) return <main className="app-shell"><section className="workspace"><p>Loading {sourceFile}…</p></section></main>;
  if (error) return <main className="app-shell"><section className="workspace"><h1>Unable to load the default report</h1><p>{error}</p></section></main>;
  if (!decision) return <main className="app-shell"><section className="workspace"><h1>No review decisions</h1><p>{sourceFile} contains no highlighted decisions.</p></section></main>;
  const boardState = decision.state;
  const callDecision = isCallDecision(boardState.legal_actions);
  const callOptions = boardState.legal_actions.filter((action) => isCallAction(action) || isPassAction(action));
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
  const callFromSeat = callDecision ? relativeCallSeat(boardState.call_from) : null;
  const score = (seat: number) => boardPlayers[seat]!.score;
  const pond = (seat: number) => {
    const discards = boardPlayers[seat]!.discards;
    if (!callDecision || callFromSeat !== seat || !boardState.call_tile) return discards;
    return sameTile(discards[discards.length - 1] ?? null, boardState.call_tile) ? discards : [...discards, boardState.call_tile];
  };
  // Preserve the aka/red-five suffix when extracting a tile from review text.
  // Without the optional `r`, 5mr was normalized to 5m and lost its Dora art.
  const meldTiles = (seat: number): Meld[] => boardPlayers[seat]?.melds ?? [];
  const closedCount = (seat: number) => boardPlayers[seat]?.concealed_count ?? Math.max(0, 13 - meldTiles(seat).flatMap((meld) => meld.tiles).length);
  const decisionNumber = selected + 1;
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
    mortalPolicy: formatPolicy(decision.mortalPolicy),
    playerPolicy: callDecision
      ? policyForAction(decision.actions, selectedCall!) === null ? null : formatPolicy(policyForAction(decision.actions, selectedCall!)!)
      : selectedDiscard ? formatPolicy(policyForTile(decision.actions, selectedDiscard)) : null,
  } : null;
  const selectProblem = (index: number) => {
    setSelected(index);
    setSelectedDiscard(null);
    setSelectedCall(null);
    setSubmitted(false);
  };
  const nextProblem = () => {
    if (selected + 1 < reportDecisions.length) selectProblem(selected + 1);
  };
  const previousProblem = () => {
    if (selected > 0) selectProblem(selected - 1);
  };
  const submitDiscard = (tile: string) => {
    setSelectedDiscard(tile);
    setSubmitted(true);
  };
  const submitCall = (action: string) => {
    setSelectedCall(action);
    setSubmitted(true);
  };
  return <main className="app-shell">
    <ProductTopbar onNavigate={() => setViewMode("replay")} navigateLabel="Replay" online={status === "ok"} />
    <section className="workspace trainer-workspace">
      <div className="training-layout">
        <div className="training-board"><div className="table-wrap"><MahjongTable boardState={relativeBoardState} score={score} pond={pond} meldTiles={meldTiles} closedCount={closedCount} boardHand={boardHand} drawnTile={drawnTile} onTileSelect={submitted || callDecision ? undefined : submitDiscard} drawKey={decision.id} /></div></div>
        <TrainingPanel decisionNumber={decisionNumber} total={reportDecisions.length} isCall={callDecision} callTile={boardState.call_tile} callOptions={callOptions} result={result} canNext={selected + 1 < reportDecisions.length} onCallSelect={submitCall} onNext={nextProblem} onSkip={nextProblem} />
      </div>
    </section>
  </main>;
}
