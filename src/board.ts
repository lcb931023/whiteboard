import { getStroke } from "perfect-freehand";

export type Point = [number, number];
export type Ink = "ink" | "red" | "blue" | "green";
/** Strokes sharing a `group` (e.g. one generated sketch) are selected together. */
export type Stroke = { id: string; points: Point[]; ink: Ink; size: number; group?: string; revealAt?: number };
export type Box = [minX: number, minY: number, maxX: number, maxY: number];
export type View = { x: number; y: number; zoom: number };

export const INKS: Ink[] = ["ink", "red", "blue", "green"];
export const REVEAL_MS_PER_STROKE = 90;
const REVEAL_MS = 260;

const outlineCache = new WeakMap<Stroke, Path2D>();

function outline(points: Point[], size: number, simulatePressure: boolean) {
  const polygon = getStroke(points, { size, thinning: 0.5, smoothing: 0.5, streamline: 0.4, simulatePressure });
  const path = new Path2D();
  polygon.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  path.closePath();
  return path;
}

/** Returns how much of a stroke's reveal animation is complete, from 0 to 1. */
export function revealProgress(stroke: Stroke, now: number) {
  if (stroke.revealAt === undefined) return 1;
  return Math.min(1, Math.max(0, (now - stroke.revealAt) / REVEAL_MS));
}

/** Outlines are cached per stroke; pass `live` for a stroke whose points are still being added. */
export function strokePath(stroke: Stroke, now: number, live = false) {
  const progress = revealProgress(stroke, now);
  if (live) return outline(stroke.points, stroke.size, true);
  if (progress < 1) {
    const count = Math.max(2, Math.ceil(stroke.points.length * progress));
    return outline(stroke.points.slice(0, count), stroke.size, true);
  }
  let path = outlineCache.get(stroke);
  if (!path) outlineCache.set(stroke, (path = outline(stroke.points, stroke.size, true)));
  return path;
}

export function screenToWorld([sx, sy]: Point, view: View): Point {
  return [(sx - view.x) / view.zoom, (sy - view.y) / view.zoom];
}

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point) {
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hits(stroke: Stroke, point: Point, radius: number) {
  const reach = radius + stroke.size / 2;
  return stroke.points.some((p, i) => distanceToSegment(point, p, stroke.points[i + 1] ?? p) < reach);
}

/** Maps strokes drawn in a 0–100 box onto the board, centered on `center` and `size` world units wide. */
export function placeSketch(raw: number[][], center: Point, size: number, ink: Ink, revealFrom?: number): Stroke[] {
  const group = crypto.randomUUID();
  return raw
    .filter((flat) => flat.length >= 4)
    .map((flat, i) => ({
      id: crypto.randomUUID(),
      ink,
      group,
      size: 4,
      revealAt: revealFrom === undefined ? undefined : revealFrom + i * REVEAL_MS_PER_STROKE,
      points: Array.from({ length: flat.length >> 1 }, (_, j): Point => [
        center[0] + ((flat[2 * j] - 50) / 100) * size,
        center[1] + ((flat[2 * j + 1] - 50) / 100) * size,
      ]),
    }));
}

export function bounds(strokes: Stroke[]): Box {
  const xs = strokes.flatMap((s) => s.points.map((p) => p[0]));
  const ys = strokes.flatMap((s) => s.points.map((p) => p[1]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function contains([minX, minY, maxX, maxY]: Box, [x, y]: Point) {
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

/** Shifts strokes by (dx, dy). With `fresh`, gives them new ids and groups so they can coexist with the originals. */
export function translate(strokes: Stroke[], dx: number, dy: number, fresh = false): Stroke[] {
  const groups = new Map<string, string>();
  const regroup = (g: string) => groups.get(g) ?? groups.set(g, crypto.randomUUID()).get(g)!;
  return strokes.map(({ revealAt, ...s }) => ({
    ...s,
    ...(fresh && { id: crypto.randomUUID(), group: s.group && regroup(s.group) }),
    points: s.points.map(([x, y]): Point => [x + dx, y + dy]),
  }));
}
