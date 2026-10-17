# Whiteboard

A minimal infinite whiteboard. Draw freehand, or type a short description ("a bicycle", "a coffee mug") and Claude sketches it for you to place on the board.

## Run

```sh
npm install
npm run dev          # netlify dev → http://localhost:8888 (needs ANTHROPIC_API_KEY)
```

## Controls

| Action | Input |
| --- | --- |
| Select / Pen / Eraser / Pan | `V` / `P` / `E` / `H` (or hold `Space`) |
| Select a doodle | click it (a generated sketch selects as a whole), drag a box, `⇧` to add, `⌘A` for all |
| Move / Delete selection | drag it / `Backspace` |
| Copy / Cut / Paste | `⌘C` / `⌘X` / `⌘V` (pastes at the cursor) |
| Colors | `1`–`4` |
| Sketch from text | `/`, type, `Enter`, then click to place (`Esc` cancels) |
| Undo / Redo | `⌘Z` / `⇧⌘Z` |
| Pan / Zoom | scroll / `⌘`+scroll or pinch |

Strokes are saved in localStorage. The sketch endpoint lives in `netlify/functions/sketch.mts`.
