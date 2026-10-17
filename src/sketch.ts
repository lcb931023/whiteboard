// Turns a short text description into a line drawing: a list of polylines in a 0–100 box.
// Calls Claude straight from the browser with the viewer's own API key, which is stored only in their browser
// and sent only to Anthropic.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const KEY_STORAGE = "whiteboard:anthropic-key";
const MODEL = "claude-opus-5-5";
const SYSTEM = `You draw clean, recognizable line drawings of objects as pen strokes, like a confident illustrator sketching an icon on a whiteboard.
Coordinates live in a 100×100 box, origin top-left, y pointing down. Use most of the box and keep the drawing centered.
Each stroke is a flat list of numbers [x1, y1, x2, y2, ...] tracing one continuous pen line.

Before writing coordinates, plan the drawing as simple parts (rectangles, circles, lines) with explicit positions and sizes, then trace each part.
- Choose the most iconic flat view: front-on or side-on, the way an icon or emoji would show it. Avoid perspective and 3/4 views.
- Geometry should be exact: straight edges are straight, rectangles are axis-aligned with right angles, circles are round, symmetric objects are mirrored exactly.
- Parts that touch must connect: reuse the exact coordinates where one part meets another, so nothing floats or leaves gaps.
- A straight line needs only its endpoints. Sample curves densely (a point every 2–4 units). To close a shape, repeat its first point at the end.
- Use 3–30 strokes: the overall silhouette first, then the few details that make the object identifiable. No shading, hatching, or text.`;

const Sketch = z.object({ strokes: z.array(z.array(z.number())) });

export class InvalidKeyError extends Error {}

export async function sketchFromText(prompt: string, apiKey: string) {
  try {
    return await requestSketch(prompt, apiKey);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new InvalidKeyError("Anthropic rejected that API key.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Rate limited by Anthropic. Try again in a moment.");
    if (err instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach Anthropic. Check your connection.");
    if (err instanceof Anthropic.APIError) throw new Error(err.error?.error?.message ?? err.message);
    throw err;
  }
}

async function requestSketch(prompt: string, apiKey: string) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: zodOutputFormat(Sketch) },
    system: SYSTEM,
    messages: [{ role: "user", content: `Draw: ${prompt.slice(0, 200)}` }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("Claude declined to draw that.");
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return Sketch.parse(JSON.parse(text)).strokes;
}
