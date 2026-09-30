import { Component, useEffect, useState } from "react";
import { fetchDefaultReplay, fetchDefaultReview, fetchHealth } from "../api/client";
import type { ActionAnalysis, Decision as ApiDecision, GameState, Meld, PlayerState, ReplayEvent, ReplayResponse, Severity } from "../types/review";

type Decision = { source: ApiDecision; id: string; turn: number | null; severity: Severity | null; actual: string; mortal: string; playerPolicy: string; mortalPolicy: string; shanten: string; playerUkeire: number | null; mortalUkeire: number | null; playerAnalysis?: ActionAnalysis | null; mortalAnalysis?: ActionAnalysis | null; playerEffectiveTiles: ActionAnalysis["effective_tiles"]; mortalEffectiveTiles: ActionAnalysis["effective_tiles"]; state: GameState };
interface BoardState extends GameState {
  players: PlayerState[];
  scores: (number | null)[];
}
interface DiscardRiverState { tiles: string[]; riichiIndices: number[]; tsumogiriIndices: number[] }
interface MahjongTableProps {
  boardState: BoardState;
  score: (seat: number) => number | null;
  pond: (seat: number) => string[];
  meldTiles: (seat: number) => Meld[];
  closedCount: (seat: number) => number;
  boardHand: string[];
  drawnTile?: string | null;
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
function Tile({ tile, muted = false, selected = false }: { tile: string; muted?: boolean; selected?: boolean }) { return <span className={`mahjong-tile ${muted ? "tile-muted" : ""} ${selected ? "tile-selected" : ""}`} title={tile}><img src={tileUrl(tile)} alt={tile} /></span>; }
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
      const tiles: string[] = meld.tiles ?? [];
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
function DrawnTile({ tile, hidden, animate, eventKey }: { tile?: string; hidden: boolean; animate: boolean; eventKey: string }) {
  if (!hidden && !tile) return null;
  return <span key={eventKey} className={`drawn-tile ${animate ? "drawn-tile-animated" : ""}`}>{hidden ? <TileBack className="tile-drawn-back" /> : <Tile tile={tile!} />}</span>;
}
function PlayerHand({ seat, standingTiles, concealedCount, drawnTile, drawHidden, animateDraw, drawKey }: { seat: Seat; standingTiles?: string[] | null; concealedCount: number; drawnTile?: string | null; drawHidden: boolean; animateDraw: boolean; drawKey: string | number }) {
  const tilesToRender = standingTiles ? sortTiles(standingTiles) : undefined;
  return <div className={`hand-tiles player-hand-${seat}`}>
    {tilesToRender
      ? tilesToRender.map((tile, index) => <Tile key={`${tile}-${index}`} tile={tile} />)
      : Array.from({ length: concealedCount }, (_, index) => <TileBack key={`back-${index}`} />)}
    <span className="draw-gap" aria-hidden="true" />
    <span className="draw-area"><DrawnTile tile={drawnTile ?? undefined} hidden={drawHidden} animate={animateDraw} eventKey={`draw-${drawKey}-${seat}`} /></span>
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
function PlayerZone({ seat, playerSeat, wind, score, melds, closedCount, hand, revealedHand, winningTile, winType, drawnTile, drawHidden = false, drawKey, animateDraw = false, revealHand = false, active = false }: { seat: Seat; playerSeat: number; wind: string; score: number | null; melds: Meld[]; closedCount: number; hand?: string[] | null; revealedHand?: string[] | null; winningTile?: string | null; winType?: string | null; drawnTile?: string | null; drawHidden?: boolean; drawKey: string | number; animateDraw?: boolean; revealHand?: boolean; active?: boolean }) {
  const side = seat === "left" || seat === "right";
  return <section className={`player-zone player-zone-${seat} ${active ? "player-zone-active" : ""}`}>
    <div className="player-zone-content">
      <div className="hand-anchor">
        <div className="hand-flow">
          <div className={`concealed-hand concealed-hand-${seat}`}>
            {revealHand && revealedHand ? <WinningHand seat={seat} tiles={revealedHand} winningTile={winningTile} winType={winType} /> : <PlayerHand seat={seat} standingTiles={hand} concealedCount={closedCount} drawnTile={drawnTile} drawHidden={drawHidden} animateDraw={animateDraw} drawKey={drawKey} />}
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
function CenterInformation({ boardState, scores, winds }: { boardState: BoardState; scores: Record<Seat, number | null>; winds: Record<Seat, string> }) {
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
function CenterTable({ boardState, scores, winds, rivers }: { boardState: BoardState; scores: Record<Seat, number | null>; winds: Record<Seat, string>; rivers: Record<Seat, DiscardRiverState> }) {
  return <section className="center-table" aria-label="Mahjong center table">
    <DiscardRiver seat="top" tiles={rivers.top.tiles} riichiIndices={rivers.top.riichiIndices} tsumogiriIndices={rivers.top.tsumogiriIndices} />
    <DiscardRiver seat="left" tiles={rivers.left.tiles} riichiIndices={rivers.left.riichiIndices} tsumogiriIndices={rivers.left.tsumogiriIndices} />
    <CenterInformation boardState={boardState} scores={scores} winds={winds} />
    <DiscardRiver seat="right" tiles={rivers.right.tiles} riichiIndices={rivers.right.riichiIndices} tsumogiriIndices={rivers.right.tsumogiriIndices} />
    <DiscardRiver seat="bottom" tiles={rivers.bottom.tiles} riichiIndices={rivers.bottom.riichiIndices} tsumogiriIndices={rivers.bottom.tsumogiriIndices} />
  </section>;
}
function MahjongTable({ boardState, score, pond, meldTiles, closedCount, boardHand, drawnTile, currentActor, currentAction, drawKey }: MahjongTableProps) {
  const analyzed = boardState.analyzed_player ?? 0;
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
      && boardState.players?.[playerSeat]?.is_tenpai === true;
  return <div className="mahjong-table">
    <PlayerZone seat="top" playerSeat={2} wind="西" score={scores.top} melds={meldTiles(2)} closedCount={closedCount(2)} revealedHand={boardState.players?.[2]?.revealed_hand} winningTile={currentAction === "win" && currentActor === 2 ? boardState.winning_tile : undefined} winType={currentAction === "win" && currentActor === 2 ? boardState.win_type : undefined} revealHand={shouldReveal(2)} drawnTile={undefined} drawHidden={currentAction === "draw" && currentActor === 2} drawKey={drawKey} animateDraw={currentAction === "draw" && currentActor === 2} />
    <PlayerZone seat="left" playerSeat={3} wind="北" score={scores.left} melds={meldTiles(3)} closedCount={closedCount(3)} revealedHand={boardState.players?.[3]?.revealed_hand} winningTile={currentAction === "win" && currentActor === 3 ? boardState.winning_tile : undefined} winType={currentAction === "win" && currentActor === 3 ? boardState.win_type : undefined} revealHand={shouldReveal(3)} drawnTile={undefined} drawHidden={currentAction === "draw" && currentActor === 3} drawKey={drawKey} animateDraw={currentAction === "draw" && currentActor === 3} />
    <CenterTable boardState={boardState} scores={scores} winds={winds} rivers={rivers} />
    <PlayerZone seat="right" playerSeat={1} wind="南" score={scores.right} melds={meldTiles(1)} closedCount={closedCount(1)} revealedHand={boardState.players?.[1]?.revealed_hand} winningTile={currentAction === "win" && currentActor === 1 ? boardState.winning_tile : undefined} winType={currentAction === "win" && currentActor === 1 ? boardState.win_type : undefined} revealHand={shouldReveal(1)} drawnTile={undefined} drawHidden={currentAction === "draw" && currentActor === 1} drawKey={drawKey} animateDraw={currentAction === "draw" && currentActor === 1} />
    <PlayerZone seat="bottom" playerSeat={analyzed} wind="東" score={scores.bottom} melds={meldTiles(analyzed)} closedCount={closedCount(analyzed)} hand={boardHand} revealedHand={boardState.players?.[analyzed]?.revealed_hand} winningTile={currentAction === "win" && currentActor === analyzed ? boardState.winning_tile : undefined} winType={currentAction === "win" && currentActor === analyzed ? boardState.win_type : undefined} drawnTile={currentAction === "win" ? undefined : drawnTile} drawHidden={false} drawKey={drawKey} animateDraw={currentAction === "draw" && currentActor === analyzed} revealHand={shouldReveal(analyzed)} active />
  </div>;
}

function FullGameReplay({ events, analyzedPlayer, onExit }: { events: ReplayEvent[]; analyzedPlayer: number; onExit: () => void }) {
  const [index, setIndex] = useState(0);
  const [showTileDebug, setShowTileDebug] = useState(false);
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
    if (itemIndex === 0 || item.round_id !== events[itemIndex - 1]?.round_id) starts.push(itemIndex);
    return starts;
  }, []);
  const currentRound = Math.max(0, roundStarts.findIndex((start, roundIndex) => safeIndex < (roundStarts[roundIndex + 1] ?? events.length)));
  const previousRoundIndex = currentRound > 0 ? roundStarts[currentRound - 1] : 0;
  const nextRoundIndex = currentRound < roundStarts.length - 1 ? roundStarts[currentRound + 1] : events.length - 1;
  if (!event || !event.state || !Array.isArray(event.state.players)) return <main className="app-shell"><section className="workspace"><h1>Replay event unavailable</h1><p>Event {safeIndex + 1} has an invalid state payload.</p></section></main>;
  const raw = event.state;
  const getBoardStateFromReplayEvent = (replayEvent: ReplayEvent): BoardState => {
    const source = replayEvent.state;
    const players = [0, 1, 2, 3].map((relativeSeat): PlayerState => {
      const sourceSeat = source.players[(analyzedPlayer + relativeSeat) % 4];
      const player: PlayerState = sourceSeat ?? { seat: relativeSeat, score: null, discards: [], tsumogiri_discard_indices: [], riichi_discard_indices: [], melds: [], riichi: false, concealed_count: null, has_drawn_tile: false, revealed_hand: null, is_tenpai: false };
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
  const playerAnalysis = event.player_perspective_analysis;
  const parsedMove = event.action === "discard" || event.action === "dahai"
    ? `Discard ${event.tile ?? "—"}`
    : event.action === "draw"
      ? `Draw ${event.tile ?? "—"}`
      : `${event.action ?? "Unknown action"}${event.tile ? ` ${event.tile}` : ""}`;
  const discardGroups = (Object.entries(
    (playerAnalysis?.discard_options ?? []).reduce<Record<string, ActionAnalysis[]>>((groups, option) => {
      const key = String(option.shanten);
      (groups[key] ??= []).push(option);
      return groups;
    }, {}),
  ) as [string, ActionAnalysis[]][]).sort(([shantenA], [shantenB]) => Number(shantenA) - Number(shantenB));
  const score = (seat: number) => state.players?.[seat]?.score ?? state.scores?.[seat] ?? null;
  const pond = (seat: number) => state.players?.[seat]?.discards ?? [];
  const meldTiles = (seat: number) => state.players[seat]?.melds ?? [];
  const closedCount = (seat: number) => state.players[seat]?.concealed_count ?? (seat === state.analyzed_player ? state.concealed_hand.length : Math.max(0, 13 - meldTiles(seat).flatMap((meld) => meld.tiles).length));
  return <main className="app-shell"><header className="topbar"><div className="brand-mark"><span className="brand-seal">麻</span><div><span className="brand-name">Matsu</span><span className="brand-sub">RIICHI TRAINER</span></div></div><div className="topbar-center"><span className="eyebrow">FULL GAME REPLAY</span><span className="crumb">/ event stream · fixed player perspective</span></div><div className="topbar-actions"><button className="debug-button" onClick={() => setShowTileDebug((value) => !value)}>Debug</button></div></header>
    <section className="workspace replay-workspace"><div className="round-heading"><div><span className="eyebrow">REPLAY MODE · {state.round_label ?? "FULL GAME"}</span><h1>Full Game Replay</h1><p className="panel-note">Complete chronological event stream. Review decisions are not used in this mode.</p></div><div className="turn-display">EVENT <strong>{events.length ? `${index + 1} / ${events.length}` : "0 / 0"}</strong><span>{event.action ?? "initial_hands"} · seat {event.actor ?? analyzedPlayer}</span></div></div>
      {showTileDebug && <section className="tile-debug" aria-label="Analyzed player debug"><b>Analyzed player perspective</b><span>{parsedMove} · perspective seat {analyzedPlayer}{event.actor !== analyzedPlayer && " · latest known 14-tile hand analysis"}</span><div className="debug-analysis"><div><small>SELECTED DISCARD</small><strong>{playerAnalysis?.discard ?? "—"}</strong></div><div><small>SHANTEN AFTER DISCARD</small><strong>{playerAnalysis?.shanten ?? "Unavailable"}</strong></div><div><small>UKEIRE AFTER DISCARD</small><strong>{playerAnalysis?.ukeire ?? "Unavailable"}</strong></div></div>{discardGroups.length > 0 ? <div className="discard-option-list"><b>Discard options grouped by resulting shanten</b>{discardGroups.map(([shanten, options]) => <div className="discard-shanten-group" key={shanten}><b>{shanten} shanten</b>{[...options].sort((a, b) => b.ukeire - a.ukeire).map((option, optionIndex) => <span key={`${option.discard}-${optionIndex}`} className={option.discard === playerAnalysis?.discard ? "discard-option-selected" : ""}>{option.discard} · {option.ukeire} ukeire</span>)}</div>)}</div> : <small className="discard-options-unavailable">Discard options are unavailable until a complete player hand snapshot is recorded.</small>}</section>}
      <div className="table-wrap"><MahjongTable boardState={state} score={score} pond={pond} meldTiles={meldTiles} closedCount={closedCount} boardHand={state.concealed_hand ?? []} drawnTile={state.drawn_tile} currentActor={relativeActor} currentAction={event.action} drawKey={safeIndex} /></div>
      <div className="replay-controls"><button onClick={() => setIndex(previousRoundIndex)} disabled={currentRound === 0}>Previous round</button><button onClick={() => setIndex(Math.max(0, index - 1))} disabled={index === 0}>Previous event</button><span><b>Round {currentRound + 1} / {roundStarts.length}</b> · event {index + 1} / {events.length} · {event.action ?? "INITIAL HANDS"}{event.tile ? ` · ${event.tile}` : ""} · seat {event.actor ?? analyzedPlayer}</span><button onClick={() => setIndex(Math.min(events.length - 1, index + 1))} disabled={index >= events.length - 1}>Next event</button><button onClick={() => setIndex(nextRoundIndex)} disabled={currentRound >= roundStarts.length - 1}>Next round</button></div>
    </section></main>;
}

export function HomePage() {
  const [selected, setSelected] = useState(0); const [status, setStatus] = useState("checking"); const [reportDecisions, setReportDecisions] = useState<Decision[]>([]); const [sourceFile, setSourceFile] = useState("default report"); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [replay, setReplay] = useState<ReplayResponse | null>(null); const [replayError, setReplayError] = useState<string | null>(null); const [replayLoading, setReplayLoading] = useState(true); const [viewMode, setViewMode] = useState<"review" | "replay">("replay"); const [showTileDebug, setShowTileDebug] = useState(false); const decision = reportDecisions[selected];
  useEffect(() => {
    fetchHealth().then((health) => setStatus(health.status)).catch(() => setStatus("offline"));
    fetchDefaultReplay().then((value) => {
      if (!value || !Array.isArray(value.events)) throw new Error("Replay response has no events array");
      setReplay(value);
    }).catch((err) => setReplayError(err instanceof Error ? err.message : "Unable to load replay")).finally(() => setReplayLoading(false));
    fetchDefaultReview().then((review) => {
      setSourceFile(review.source_file ?? "default report");
      const reviewDecisions = review.decisions.map((item): Decision => ({
        source: item,
        id: item.id,
        turn: item.state.turn,
        severity: item.severity,
        actual: item.actual_action ?? "—",
        mortal: item.mortal_action ?? "—",
        playerPolicy: item.mortal?.player_policy == null ? "—" : `${(item.mortal.player_policy * 100).toFixed(1)}%`,
        mortalPolicy: item.mortal?.best_policy == null ? "—" : `${(item.mortal.best_policy * 100).toFixed(1)}%`,
        shanten: `${item.analysis?.player_analysis?.shanten ?? "—"}`,
        playerUkeire: item.analysis?.player_analysis?.ukeire ?? null,
        mortalUkeire: item.analysis?.mortal_analysis?.ukeire ?? null,
        playerAnalysis: item.analysis?.player_analysis,
        mortalAnalysis: item.analysis?.mortal_analysis,
        playerEffectiveTiles: item.analysis?.player_analysis?.effective_tiles ?? [],
        mortalEffectiveTiles: item.analysis?.mortal_analysis?.effective_tiles ?? [],
        state: item.state,
      }));
      setReportDecisions(reviewDecisions);
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load the default report")).finally(() => setLoading(false));
  }, []);
  if (viewMode === "replay") {
    if (replayLoading) return <main className="app-shell"><section className="workspace"><h1>Full Game Replay</h1><p>Loading replay events…</p></section></main>;
    if (replayError) return <main className="app-shell"><section className="workspace"><h1>Replay unavailable</h1><p>{replayError}</p></section></main>;
    if (!replay) return <main className="app-shell"><section className="workspace"><h1>Replay unavailable</h1><p>The replay response is missing.</p></section></main>;
    return <ReplayErrorBoundary><FullGameReplay events={replay.events} analyzedPlayer={replay.analyzed_player} onExit={() => setViewMode("review")} /></ReplayErrorBoundary>;
  }
  if (loading) return <main className="app-shell"><section className="workspace"><p>Loading {sourceFile}…</p></section></main>;
  if (error) return <main className="app-shell"><section className="workspace"><h1>Unable to load the default report</h1><p>{error}</p></section></main>;
  if (!decision) return <main className="app-shell"><section className="workspace"><h1>No review decisions</h1><p>{sourceFile} contains no highlighted decisions.</p></section></main>;
  const boardState = decision.state;
  const analyzedPlayer = boardState.analyzed_player ?? 0;
  const boardPlayers = [0, 1, 2, 3].map((relativeSeat) => {
    const sourceSeat = (analyzedPlayer + relativeSeat) % 4;
    const source = boardState.players?.[sourceSeat] ?? { seat: sourceSeat, discards: [], melds: [], score: null };
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
    scores: [0, 1, 2, 3].map((relativeSeat) => boardState.scores?.[(analyzedPlayer + relativeSeat) % 4] ?? null),
  };
  const boardHand: string[] = relativeBoardState.concealed_hand ?? [];
  const drawnTile = relativeBoardState.drawn_tile;
  const score = (seat: number) => boardPlayers[seat]?.score ?? relativeBoardState.scores?.[seat] ?? null;
  const pond = (seat: number) => boardPlayers[seat]?.discards ?? [];
  // Preserve the aka/red-five suffix when extracting a tile from review text.
  // Without the optional `r`, 5mr was normalized to 5m and lost its Dora art.
  const actionTile = (action: string) => action.match(/([0-9][mps]r?|[1-7]z|[東南西北中發白]|[epwsfc])/u)?.[1] ?? action;
  const meldTiles = (seat: number): Meld[] => boardPlayers[seat]?.melds ?? [];
  const closedCount = (seat: number) => boardPlayers[seat]?.concealed_count ?? Math.max(0, 13 - meldTiles(seat).flatMap((meld) => meld.tiles).length);
  return <main className="app-shell">
    <header className="topbar"><div className="brand-mark"><span className="brand-seal">麻</span><div><span className="brand-name">Matsu</span><span className="brand-sub">RIICHI TRAINER</span></div></div><div className="topbar-center"><span className="eyebrow">REVIEW ROOM</span><span className="crumb">/ East 1 · Game 01</span></div><div className="topbar-actions"><span className="api-dot" data-online={status === "ok"} /> <span>{status === "ok" ? "Synced" : "Local review"}</span><button className="debug-button" onClick={() => setShowTileDebug((value) => !value)}>Debug</button><button className="icon-button" aria-label="Settings">☼</button></div></header>
    <section className="review-layout">
      <aside className="timeline-panel"><div className="panel-kicker">DECISIONS <span>{String(reportDecisions.length).padStart(2, "0")}</span></div><h2>Game review</h2><p className="panel-note">Analyzed decisions from {sourceFile}.</p><div className="decision-list">{reportDecisions.map((item, index) => <button key={item.id} onClick={() => setSelected(index)} className={`decision-row ${selected === index ? "decision-active" : ""}`}><span className={`severity-mark severity-${(item.severity ?? "minor").toLowerCase()}`} /><span className="decision-copy"><span className="decision-id">{item.id} <small>TURN {item.turn ?? "—"}</small></span><span>{item.actual} <i>·</i> {item.mortal}</span></span><span className="decision-percent">{item.playerPolicy}</span></button>)}</div></aside>
      <section className="workspace"><div className="round-heading"><div><span className="eyebrow">{boardState.round_label ?? "ROUND —"}</span><h1>Decision <em>{decision.id}</em>{decision.severity && <span className={`severity-pill ${decision.severity.toLowerCase()}`}>{decision.severity}</span>}</h1><button className="replay-launch" onClick={() => setViewMode("replay")} disabled={!replay}>Full Game Replay</button></div><div className="turn-display">TURN <strong>{decision.turn == null ? "—" : String(decision.turn).padStart(2, "0")}</strong><span>⟵ use ← → to browse</span></div></div>
        {showTileDebug && <section className="tile-debug" aria-label="Analyzed player debug"><b>Analyzed player perspective</b><span>After discard · seat {analyzedPlayer}</span><div className="debug-analysis debug-action-comparison"><div><small>YOUR MOVE · SHANTEN / UKEIRE</small><strong>{decision.playerAnalysis?.shanten ?? "Unavailable"} / {decision.playerUkeire ?? "Unavailable"}</strong><small>{decision.playerEffectiveTiles?.map((item) => `${item.tile} ×${item.remaining}`).join(" · ") || "No effective tiles reported"}</small></div><div><small>MORTAL MOVE · SHANTEN / UKEIRE</small><strong>{decision.mortalAnalysis?.shanten ?? "Unavailable"} / {decision.mortalUkeire ?? "Unavailable"}</strong><small>{decision.mortalEffectiveTiles?.map((item) => `${item.tile} ×${item.remaining}`).join(" · ") || "No effective tiles reported"}</small></div></div></section>}
        <div className="table-wrap"><MahjongTable boardState={relativeBoardState} score={score} pond={pond} meldTiles={meldTiles} closedCount={closedCount} boardHand={boardHand} drawnTile={drawnTile} drawKey={decision.id} /></div>
        <section className="comparison-card"><div className="comparison-title"><span className="eyebrow">ACTION COMPARISON</span><span className="confidence">MORTAL CONFIDENCE <b>{decision.mortalPolicy}</b></span></div><div className="move-compare"><div className="move-block yours"><span className="move-label">YOUR MOVE</span><strong>{decision.actual}</strong><span className="move-policy">{decision.playerPolicy} policy</span></div><div className="versus">VS</div><div className="move-block mortal"><span className="move-label">MORTAL'S MOVE</span><strong>{decision.mortal}</strong><span className="move-policy">preferred action</span></div></div><div className="analysis-strip"><div><span className="analysis-label">UKEIRE</span><b>{decision.playerUkeire ?? "—"}</b><small>you</small><i>→</i><b className="good">{decision.mortalUkeire ?? "—"}</b><small>Mortal</small></div><div><span className="analysis-label">VISIBLE</span><Tile tile={actionTile(decision.actual)} muted /><span>× {decision.playerEffectiveTiles?.find((item) => item.tile === normalizeTile(actionTile(decision.actual)))?.visible_copies ?? "—"}</span><i>·</i><Tile tile={actionTile(decision.mortal)} muted /><span>× {decision.mortalEffectiveTiles?.find((item) => item.tile === normalizeTile(actionTile(decision.mortal)))?.visible_copies ?? "—"}</span></div><button className="details-button">View detail ↗</button></div></section>
      </section>
    </section>
  </main>;
}
