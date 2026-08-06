# DOM hierarchy client

`talkthru-dom.js` writes the optional `hierarchy.json` for a web app, so the agent gets
the element under each thing you said — the test id, the label, where it sat on screen —
instead of only the picture of it.

Optional. talkthru works without it.

## Use it

Drop the script into your page before you start recording:

```html
<script src="/talkthru-dom.js"></script>
```

It starts sampling as soon as it loads. Do your walkthrough, then in the console:

```js
talkthru.stop()   // downloads hierarchy.json
```

Then process the recording with both files:

```bash
talkthru process ~/Downloads/screen-recording.mov --hierarchy ~/Downloads/hierarchy.json
```

Pasting the whole file into the console works too, and is the way in if your app sends a
strict `script-src` CSP — DevTools is exempt from it, an injected `<script>` tag is not.

## Options

```html
<script src="/talkthru-dom.js" data-interval="500" data-offset="0"></script>
```

Or start it yourself:

```html
<script src="/talkthru-dom.js" data-autostart="false"></script>
<script>talkthru.start({ intervalMs: 500, maxNodes: 200 })</script>
```

| | |
|---|---|
| `intervalMs` | how often to snapshot, default 500 |
| `offsetMs` | added to every `tMs`; use it when the recording was already rolling |
| `maxNodes` | per snapshot, default 200 |
| `autoDownload` | false keeps the bundle in memory — `stop()` returns it |

## What it writes

The same shape the device client uploads, `origin: "dom"` on every node:

```json
{
  "version": 1,
  "snapshots": [
    {
      "tMs": 1500,
      "screen": { "width": 1280, "height": 800 },
      "nodes": [
        { "type": "button", "label": "Mars", "testId": "planet-mars",
          "rect": [8, 128, 66, 39], "depth": 3, "origin": "dom" }
      ]
    }
  ]
}
```

`type` is the tag name. `testId` is the first of `data-testid`, `data-test-id`,
`data-test`, `data-cy`, `data-qa`, falling back to the element `id`. `label` is the first
of `aria-label`, `title`, `alt`, `placeholder`, then the element's own text. `rect` is
`[x, y, width, height]` in CSS pixels, relative to the viewport. `depth` counts from
`<html>`.

Only elements worth a line in `session.md` are written: something with a test id, a label,
or an interactive role. Hidden, off-screen and sub-8px elements are skipped, open shadow
roots are walked, cross-origin iframes are not.

**Field values are never read.** Not the password box, not anything else you typed.

## Timing

`tMs` counts from when the script started, and the pipeline drops a snapshot more than
750 ms from the frame it would attach to. So start the recording and load the page in
either order, but close together — a page loaded thirty seconds into the recording puts
every node thirty seconds early. `data-offset` corrects it after the fact if you got it
wrong; `startedAt` in the file is the wall clock at capture start, for working out by how
much.
