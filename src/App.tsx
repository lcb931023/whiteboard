import { useCallback, useEffect, useRef, useState } from "react";
import {
  INKS, bounds, contains, hits, placeSketch, revealProgress, screenToWorld, strokePath, translate,
  type Box, type Ink, type Point, type Stroke, type View,
} from "./board";
import { InvalidKeyError, KEY_STORAGE, sketchFromText } from "./sketch";

const STORAGE_KEY = "whiteboard:strokes";
const PEN_SIZE = 4;
const ERASER_RADIUS = 10;
const SKETCH_SCREEN_SIZE = 260;
const ZOOM_LIMITS = [0.2, 5];
const SELECT_PADDING = 8;
const PASTE_OFFSET = 24;

type Tool = "select" | "pen" | "eraser" | "hand";
type Pending = { prompt: string; strokes: number[][] };

function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadStrokes(): Stroke[] {
  try {
    return JSON.parse(readStorage(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>(loadStrokes);
  const [undoStack, setUndoStack] = useState<Stroke[][]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[][]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [ink, setInk] = useState<Ink>("ink");
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<{ kind: "loading" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [apiKey, setApiKey] = useState(() => readStorage(KEY_STORAGE) ?? "");
  const [keyOpen, setKeyOpen] = useState(false);

  // Fast-changing values live in refs so pointer moves don't re-render React.
  const pointer = useRef<Point>([innerWidth / 2, innerHeight / 2]);
  const draft = useRef<Stroke | null>(null);
  const gesture = useRef<{ kind: "draw" | "erase" | "pan" | "move" | "marquee"; before: Stroke[]; start: Point; last: Point } | null>(null);
  const clipboard = useRef<{ strokes: Stroke[]; pastes: number } | null>(null);
  const frame = useRef(0);

  const selection = strokes.filter((s) => selected.has(s.id));
  const selectionBox = (zoom: number): Box | null => {
    if (!selection.length) return null;
    const [minX, minY, maxX, maxY] = bounds(selection);
    const pad = SELECT_PADDING / zoom;
    return [minX - pad, minY - pad, maxX + pad, maxY + pad];
  };
  /** Expands a set of strokes to include every stroke in the same groups. */
  const withGroups = (picked: Stroke[]) => {
    const groups = new Set(picked.map((s) => s.group).filter(Boolean));
    return new Set(strokes.filter((s) => picked.includes(s) || groups.has(s.group)).map((s) => s.id));
  };

  const commit = useCallback((next: Stroke[], before: Stroke[]) => {
    setUndoStack((stack) => [...stack.slice(-99), before]);
    setRedoStack([]);
    setStrokes(next);
  }, []);

  const undo = () => {
    if (!undoStack.length) return;
    setRedoStack((stack) => [...stack, strokes]);
    setStrokes(undoStack.at(-1)!);
    setUndoStack((stack) => stack.slice(0, -1));
  };
  const redo = () => {
    if (!redoStack.length) return;
    setUndoStack((stack) => [...stack, strokes]);
    setStrokes(redoStack.at(-1)!);
    setRedoStack((stack) => stack.slice(0, -1));
  };

  const render = useCallback(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = devicePixelRatio;
    const css = getComputedStyle(canvas);
    const colorOf = (i: Ink) => css.getPropertyValue(`--${i}`);
    const now = performance.now();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);

    const g = gesture.current;
    const moveBy = g?.kind === "move" ? [(g.last[0] - g.start[0]) / view.zoom, (g.last[1] - g.start[1]) / view.zoom] : [0, 0];
    let animating = false;
    for (const stroke of strokes) {
      const progress = revealProgress(stroke, now);
      if (progress < 1) animating = true;
      if (progress === 0) continue;
      const moving = selected.has(stroke.id);
      if (moving) ctx.translate(moveBy[0], moveBy[1]);
      ctx.fillStyle = colorOf(stroke.ink);
      ctx.fill(strokePath(stroke, now));
      if (moving) ctx.translate(-moveBy[0], -moveBy[1]);
    }

    ctx.strokeStyle = colorOf("blue");
    ctx.lineWidth = 1.5 / view.zoom;
    const box = selectionBox(view.zoom);
    if (box) {
      ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
      ctx.strokeRect(box[0] + moveBy[0], box[1] + moveBy[1], box[2] - box[0], box[3] - box[1]);
      ctx.setLineDash([]);
    }
    if (g?.kind === "marquee") {
      const [a, b] = [screenToWorld(g.start, view), screenToWorld(g.last, view)];
      ctx.fillStyle = colorOf("blue");
      ctx.globalAlpha = 0.08;
      ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      ctx.globalAlpha = 1;
      ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    }
    if (draft.current) {
      ctx.fillStyle = colorOf(draft.current.ink);
      ctx.fill(strokePath(draft.current, now, true));
    }

    const world = screenToWorld(pointer.current, view);
    if (pending) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = colorOf(ink);
      for (const ghost of placeSketch(pending.strokes, world, SKETCH_SCREEN_SIZE / view.zoom, ink)) ctx.fill(strokePath(ghost, now));
      ctx.globalAlpha = 1;
    } else if (tool === "eraser" && !spaceHeld) {
      ctx.strokeStyle = colorOf("ink");
      ctx.lineWidth = 1 / view.zoom;
      ctx.beginPath();
      ctx.arc(world[0], world[1], ERASER_RADIUS / view.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (animating) frame.current = requestAnimationFrame(render);
  }, [strokes, view, pending, ink, tool, spaceHeld, selected]);

  const requestRender = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(render);
  }, [render]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const resize = () => {
      canvas.width = innerWidth * devicePixelRatio;
      canvas.height = innerHeight * devicePixelRatio;
      requestRender();
    };
    resize();
    addEventListener("resize", resize);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", requestRender);
    return () => {
      removeEventListener("resize", resize);
      matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", requestRender);
    };
  }, [requestRender]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(strokes.map(({ revealAt, ...s }) => s)));
    } catch {}
  }, [strokes]);

  const eraseAt = (screen: Point) => {
    const point = screenToWorld(screen, view);
    setStrokes((current) => {
      const kept = current.filter((s) => !hits(s, point, ERASER_RADIUS / view.zoom));
      return kept.length === current.length ? current : kept;
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const screen: Point = [e.clientX, e.clientY];
    pointer.current = screen;
    if (pending) {
      const placed = placeSketch(pending.strokes, screenToWorld(screen, view), SKETCH_SCREEN_SIZE / view.zoom, ink, performance.now());
      commit([...strokes, ...placed], strokes);
      setPending(null);
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    const world = screenToWorld(screen, view);
    let kind: NonNullable<typeof gesture.current>["kind"] =
      spaceHeld || tool === "hand" || e.button === 1 ? "pan" : tool === "eraser" ? "erase" : tool === "select" ? "marquee" : "draw";
    if (kind === "marquee") {
      const box = selectionBox(view.zoom);
      const hit = strokes.findLast((s) => hits(s, world, 6 / view.zoom));
      if (hit && !selected.has(hit.id)) {
        const group = withGroups([hit]);
        setSelected(e.shiftKey ? new Set([...selected, ...group]) : group);
        kind = "move";
      } else if (hit || (box && contains(box, world))) {
        kind = "move";
      } else if (!e.shiftKey) {
        setSelected(new Set());
      }
    }
    gesture.current = { kind, before: strokes, start: screen, last: screen };
    if (kind === "draw") draft.current = { id: crypto.randomUUID(), points: [screenToWorld(screen, view)], ink, size: PEN_SIZE };
    if (kind === "erase") eraseAt(screen);
    requestRender();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const screen: Point = [e.clientX, e.clientY];
    pointer.current = screen;
    const g = gesture.current;
    if (g?.kind === "pan") setView((v) => ({ ...v, x: v.x + screen[0] - g.last[0], y: v.y + screen[1] - g.last[1] }));
    if (g?.kind === "draw") draft.current!.points.push(screenToWorld(screen, view));
    if (g?.kind === "erase") eraseAt(screen);
    if (g) g.last = screen;
    requestRender();
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.kind === "draw" && draft.current) commit([...strokes, draft.current], strokes);
    if (g?.kind === "erase" && strokes !== g.before) commit(strokes, g.before);
    if (g?.kind === "move" && (g.last[0] !== g.start[0] || g.last[1] !== g.start[1])) {
      const [dx, dy] = [(g.last[0] - g.start[0]) / view.zoom, (g.last[1] - g.start[1]) / view.zoom];
      commit(strokes.map((s) => (selected.has(s.id) ? translate([s], dx, dy)[0] : s)), strokes);
    }
    if (g?.kind === "marquee") {
      const [a, b] = [screenToWorld(g.start, view), screenToWorld(g.last, view)];
      const area: Box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      const inside = strokes.filter((s) => s.points.every((p) => contains(area, p)));
      if (inside.length) setSelected((current) => new Set([...current, ...withGroups(inside)]));
    }
    draft.current = null;
    requestRender();
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Zoom around the cursor: keep the world point under it fixed on screen.
      setView((v) => {
        const zoom = Math.min(ZOOM_LIMITS[1], Math.max(ZOOM_LIMITS[0], v.zoom * Math.exp(-e.deltaY * 0.01)));
        const k = zoom / v.zoom;
        return { zoom, x: e.clientX - (e.clientX - v.x) * k, y: e.clientY - (e.clientY - v.y) * k };
      });
    } else {
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const block = (e: WheelEvent) => e.preventDefault();
    canvas.addEventListener("wheel", block, { passive: false });
    return () => canvas.removeEventListener("wheel", block);
  }, []);

  const copy = () => {
    if (selection.length) clipboard.current = { strokes: selection, pastes: 0 };
  };
  const remove = () => {
    if (!selection.length) return;
    commit(strokes.filter((s) => !selected.has(s.id)), strokes);
    setSelected(new Set());
  };
  /** Pastes at the cursor; if the cursor hasn't moved off the copied doodle, each paste steps diagonally instead. */
  const paste = () => {
    const clip = clipboard.current;
    if (!clip) return;
    const [minX, minY, maxX, maxY] = bounds(clip.strokes);
    const saveKey = (key: string) => {
    setApiKey(key);
    try {
      localStorage.setItem(KEY_STORAGE, key);
    } catch {}
  };

  const cursor = screenToWorld(pointer.current, view);
    const overSource = contains([minX, minY, maxX, maxY], cursor);
    clip.pastes++;
    const [dx, dy] = overSource
      ? [(PASTE_OFFSET * clip.pastes) / view.zoom, (PASTE_OFFSET * clip.pastes) / view.zoom]
      : [cursor[0] - (minX + maxX) / 2, cursor[1] - (minY + maxY) / 2];
    const pasted = translate(clip.strokes, dx, dy, true);
    commit([...strokes, ...pasted], strokes);
    setSelected(new Set(pasted.map((s) => s.id)));
    setTool("select");
  };

  const sketch = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || status?.kind === "loading") return;
    if (!apiKey) return setKeyOpen(true);
    inputRef.current?.blur();
    setStatus({ kind: "loading", text: `Sketching ${text}…` });
    try {
      setPending({ prompt: text, strokes: await sketchFromText(text, apiKey) });
      setPrompt("");
      setStatus(null);
    } catch (err) {
      if (err instanceof InvalidKeyError) setKeyOpen(true);
      setStatus({ kind: "error", text: err instanceof Error ? err.message : "Something went wrong" });
    }
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) {
        if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && key === "c") { copy(); return; }
      if (mod && key === "x") { copy(); remove(); return; }
      if (mod && key === "v") { e.preventDefault(); paste(); return; }
      if (mod && key === "a") { e.preventDefault(); setTool("select"); setSelected(new Set(strokes.map((s) => s.id))); return; }
      if (mod) return;
      if (e.key === "Backspace" || e.key === "Delete") remove();
      if (e.key === " ") { e.preventDefault(); setSpaceHeld(true); }
      if (e.key === "Escape") { setPending(null); setStatus(null); setSelected(new Set()); }
      if (e.key === "/") { e.preventDefault(); inputRef.current?.focus(); }
      if (e.key === "v") setTool("select");
      if (e.key === "p") setTool("pen");
      if (e.key === "e") setTool("eraser");
      if (e.key === "h") setTool("hand");
      const inkIndex = Number(e.key) - 1;
      if (INKS[inkIndex]) setInk(INKS[inkIndex]);
    };
    const up = (e: KeyboardEvent) => e.key === " " && setSpaceHeld(false);
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
  });

  useEffect(requestRender, [requestRender]);
  useEffect(() => {
    if (tool !== "select") setSelected(new Set());
  }, [tool]);

  const saveKey = (key: string) => {
    setApiKey(key);
    try {
      localStorage.setItem(KEY_STORAGE, key);
    } catch {}
  };

  const cursor = pending ? "copy" : spaceHeld || tool === "hand" ? (gesture.current ? "grabbing" : "grab") : tool === "eraser" ? "none" : tool === "select" ? "default" : "crosshair";

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={requestRender}
        onWheel={onWheel}
      />

      {(status || pending) && (
        <div className={`hint ${status?.kind ?? ""}`}>
          {status?.text ?? `Click to place ${pending!.prompt} · Esc to cancel`}
        </div>
      )}

      {strokes.length === 0 && !pending && !status && (
        <p className="empty">Draw anything, or type below to have it sketched for you</p>
      )}

      {keyOpen && (
        <form className="keybar" onSubmit={(e) => { e.preventDefault(); setKeyOpen(false); if (prompt.trim()) sketch(e); }}>
          <label htmlFor="api-key">Anthropic API key · stored only in this browser</label>
          <input id="api-key" type="password" value={apiKey} onChange={(e) => saveKey(e.target.value.trim())} placeholder="sk-ant-…" autoComplete="off" spellCheck={false} autoFocus />
          <p>
            Sketches are requested straight from your browser to Anthropic.{" "}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Get a key</a>
          </p>
        </form>
      )}

      <div className="toolbar">
        <div className="group">
          <ToolButton active={tool === "select"} onClick={() => setTool("select")} label="Select (V) · ⌘C / ⌘V to copy & paste" icon="M5 3l14 8-6 1.5L10 19z" />
          <ToolButton active={tool === "pen"} onClick={() => setTool("pen")} label="Pen (P)" icon="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
          <ToolButton active={tool === "eraser"} onClick={() => setTool("eraser")} label="Eraser (E)" icon="M8 20h12M5 15l8-8 5 5-8 8H7l-2-2a2 2 0 010-3z" />
          <ToolButton active={tool === "hand"} onClick={() => setTool("hand")} label="Pan (H, or hold Space)" icon="M7 11V6a1.5 1.5 0 013 0v4m0-5a1.5 1.5 0 013 0v5m0-4a1.5 1.5 0 013 0v5m0-2a1.5 1.5 0 013 0v4a7 7 0 01-7 7h-1a6 6 0 01-5-3l-3-5a1.5 1.5 0 012.5-1.5L7 14" />
        </div>
        <div className="group">
          {INKS.map((i, n) => (
            <button key={i} className={`swatch ${ink === i ? "active" : ""}`} style={{ "--swatch": `var(--${i})` } as React.CSSProperties} onClick={() => setInk(i)} title={`Color (${n + 1})`} aria-label={`${i} color`} />
          ))}
        </div>
        <form className="sketch" onSubmit={sketch}>
          <svg viewBox="0 0 24 24" aria-hidden><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg>
          <input ref={inputRef} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Sketch a bicycle…  ( / )" disabled={status?.kind === "loading"} />
          <ToolButton active={keyOpen} onClick={() => setKeyOpen((open) => !open)} label={apiKey ? "API key" : "Add an API key to sketch from text"} icon="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.7 5.7L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.6a1 1 0 01.3-.7l6-6A6 6 0 1121 9z" />
        </form>
        <div className="group">
          <ToolButton onClick={undo} disabled={!undoStack.length} label="Undo (⌘Z)" icon="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" />
          <ToolButton onClick={redo} disabled={!redoStack.length} label="Redo (⇧⌘Z)" icon="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3" />
          <ToolButton onClick={() => strokes.length && commit([], strokes)} disabled={!strokes.length} label="Clear board" icon="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" />
        </div>
      </div>
    </>
  );
}

function ToolButton({ icon, label, active, ...props }: { icon: string; label: string; active?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={`tool ${active ? "active" : ""}`} title={label} aria-label={label} {...props}>
      <svg viewBox="0 0 24 24" aria-hidden><path d={icon} /></svg>
    </button>
  );
}
