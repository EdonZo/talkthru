# The hierarchy file

A screen recording tells talkthru *what a screen looked like*. A hierarchy file
tells it *what the screen was made of* — element types, labels, and stable test
ids, timestamped so each one lands on the frame it belongs to.

It is optional. Without it your agent reads pixels and infers which component
you meant. With it, the agent gets `#checkout-submit` and goes straight there.

This is the difference between "the blue button near the bottom" and a symbol
you can grep for, and it is the single biggest thing you can do to stop an agent
confidently patching the wrong component.

```bash
talkthru process recording.mp4 --hierarchy hierarchy.json
```

Nothing in talkthru writes this file. Your app — or a browser extension, or a
test harness — writes it, which is why the format is documented rather than
owned by an SDK.

---

## Shape

```json
{
  "version": 1,
  "snapshots": [
    {
      "tMs": 1200,
      "screen": { "width": 390, "height": 844 },
      "occlusions": ["keyboard"],
      "nodes": [
        {
          "type": "button",
          "testId": "checkout-submit",
          "label": "Place order",
          "rect": [24, 680, 342, 48],
          "depth": 4,
          "origin": "native"
        }
      ]
    }
  ]
}
```

A bare array of snapshots is accepted too, if a wrapper object is inconvenient:

```json
[{ "tMs": 1200, "nodes": [] }]
```

### Snapshot

| Field | Type | Required | Meaning |
|---|---|---|---|
| `tMs` | number | **yes** | Milliseconds from the start of the recording |
| `nodes` | array | **yes** | The elements on screen at `tMs` |
| `screen` | `{width, height}` | no | Logical screen size, for coordinate sanity |
| `occlusions` | string[] | no | What the capture could not see: `"keyboard"`, `"system alert"` |

### Node

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | string | **yes** | Class or tag name — `UIButton`, `div#play.btn`, `button` |
| `rect` | `[x, y, w, h]` | **yes** | Position in screen points |
| `depth` | number | no | Depth in the tree; `0` is the window. Defaults to `0` |
| `label` | string | no | Accessibility label, title, or text content |
| `testId` | string | no | Stable identifier — `data-testid`, accessibility identifier |
| `origin` | `"native"` \| `"dom"` | no | Native view, or bridged out of a web view |

A node without a usable `type` or `rect` is dropped. Everything else is
optional, and a file of nothing but types and rects is still useful.

---

## Field aliases

Platform hierarchies name things differently and rewriting them is busywork, so
the parser accepts the common spellings directly:

| Canonical | Also accepted |
|---|---|
| `tMs` | `t`, `timestampMs` |
| `nodes` | `elements` |
| `type` | `className`, `tag`, `role` |
| `label` | `text`, `accessibilityLabel`, `title` |
| `testId` | `identifier`, `accessibilityIdentifier`, `id` |
| `rect` | `frame`, `bounds` |
| `occlusions` | `occluded` |

`rect` takes either form:

```json
"rect": [24, 680, 342, 48]
"rect": { "x": 24, "y": 680, "width": 342, "height": 48 }
```

`{ "w": …, "h": … }` works as well as `width`/`height`. Numbers may arrive as
strings — `"24"` parses as `24`.

So a DOM client can emit this and talkthru will read it as-is:

```json
{ "tag": "button", "id": "buy", "text": "Buy now",
  "bounds": { "x": 24, "y": 680, "width": 342, "height": 48 } }
```

---

## How it gets used

**Matching.** Each keyframe takes the snapshot closest in time to it. A snapshot
more than **750 ms** from the frame is not used at all — a stale hierarchy is
worse than none, because it describes a screen that had already changed.

You do not need a snapshot per frame. Emit one whenever the UI changes; if you
have no better signal, every 250–500 ms is plenty.

**Trimming.** A real hierarchy is hundreds of nodes and most are layout
containers. At most **12 nodes per frame** reach the agent, ranked by:

- has a `testId` — strongest signal, it is what the agent can search for
- has a `label`
- interactive `type` (button, link, input, switch, slider, tab, cell, …)
- larger area, by log
- shallower `depth` — a small penalty per level

Nodes with **either edge under 8 px** are dropped as noise, as are unlabelled
containers with no id and no interactive type. Labels longer than **48
characters** are truncated.

The surviving nodes are printed in reading order — top to bottom, then left to
right — so their order matches how the screen reads.

**Output.** They appear in `session.md` on a `ui:` line above the narration for
that frame, separated by ` | `:

```markdown
## 00:34 · f11 — `frames/f11.jpg`
ui: input#promo-code "Promo code" @24,600 342x44 | button#checkout-submit "Place order" @24,680 342x48
- [00:39] "this button is too small, I keep missing it"
```

---

## Failure behaviour

The hierarchy is an accessory to the recording, and losing a recording because
a sidecar was malformed would be a bad trade. So parsing never throws:

- A file that is not valid JSON is ignored, with a warning on the session
- Snapshots without a numeric `tMs` are dropped
- Nodes without a usable `type` or `rect` are dropped
- Unknown fields are ignored, so you can add your own without breaking anything
- Snapshots are sorted by `tMs`, so you may emit them out of order

If every snapshot is dropped you get a warning saying so, and the session
processes exactly as it would have without the file.

---

## Writing one

The parts that actually matter, in order:

1. **`testId` on anything interactive.** This is the whole point. Without it the
   agent is guessing from pixels.
2. **Honest `tMs`.** Measure from the first video frame, not from process start.
   If your recorder starts the clock early, subtract the offset — a hierarchy
   shifted by a second lands every node on the wrong screen.
3. **Emit on change.** More snapshots do not cost tokens; only the ones matched
   to a keyframe are ever read.
4. **Do not pre-trim.** Send the full tree. The ranking above is better at
   choosing than a filter written against one screen.

Contributions for other platforms are welcome — a DOM client for web apps is a
small script, and there is no iOS-specific assumption anywhere in the format.
