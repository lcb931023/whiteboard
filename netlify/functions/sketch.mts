// Turns a short text description into a line drawing: a list of polylines in a 0–100 box.
// The response is streamed so long generations stay within Netlify's streaming time limit.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const MODEL = "claude-opus-5-5";
const SYSTEM = `You draw simple, recognizable doodles of objects as pen strokes, like a person sketching on a whiteboard.
Coordinates live in a 100×100 box, origin top-left, y pointing down. Use most of the box and keep the drawing centered.
Each stroke is a flat list of numbers [x1, y1, x2, y2, ...] tracing one continuous pen line.
Sample curves densely (a point every 2–4 units) so they look smooth. To close a shape, repeat its first point at the end.
Use 3–30 strokes: outline first, then the key details that make the object identifiable. No shading, hatching, or text.`;

const Sketch = z.object({ strokes: z.array(z.array(z.number())) });

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const { prompt } = await req.json();
  if (typeof prompt !== "string" || !prompt.trim()) return Response.json({ error: "Empty prompt" }, { status: 400 });

  const body = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(new TextEncoder().encode(JSON.stringify(obj)));
      try {
        const stream = new Anthropic().beta.messages.stream({
          model: MODEL,
          max_tokens: 32000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low", format: zodOutputFormat(Sketch) },
          system: SYSTEM,
          messages: [{ role: "user", content: `Draw: ${prompt.slice(0, 200)}` }],
        });
        const message = await stream.finalMessage();
        if (message.stop_reason === "refusal") throw new Error("Claude declined to draw that.");
        const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        send(Sketch.parse(JSON.parse(text)));
      } catch (err) {
        send({ error: err instanceof Error ? err.message : String(err) });
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/json" } });
};

export const config = { path: "/api/sketch" };
