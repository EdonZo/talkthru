# The events file

Network calls and console output, timestamped against the recording and aligned
to the frames the same way narration is.

You say "this button does nothing", and the agent also sees the `POST /checkout`
that returned 500 two seconds earlier.

```bash
talkthru process recording.mp4 --hierarchy hierarchy.json
# events.json is picked up from the same folder automatically
```

Like [the hierarchy file](hierarchy.md), talkthru does not generate this. Your
app, a browser extension, or a test harness writes it. Both sidecars are
optional and independent.

---

## Shape

```json
{
  "version": 1,
  "events": [
    {
      "tMs": 12400,
      "kind": "network",
      "method": "POST",
      "url": "https://api.example.com/checkout",
      "status": 500,
      "durationMs": 340
    },
    {
      "tMs": 12450,
      "kind": "console",
      "level": "error",
      "text": "TypeError: cannot read property 'id' of undefined"
    }
  ]
}
```

A bare array works too. So does `{ "entries": [...] }`.

### Network event

| Field | Type | Required | Meaning |
|---|---|---|---|
| `tMs` | number | **yes** | Milliseconds from the start of the recording |
| `kind` | `"network"` | no | Inferred from the presence of `url` |
| `url` | string | **yes** | Request URL |
| `method` | string | no | Uppercased on the way in. Defaults to `GET` when displayed |
| `status` | number | no | HTTP status. **`0` means the request never completed** |
| `durationMs` | number | no | Wall time of the request |

### Console event

| Field | Type | Required | Meaning |
|---|---|---|---|
| `tMs` | number | **yes** | Milliseconds from the start of the recording |
| `kind` | `"console"` | no | Inferred from the presence of `text` |
| `text` | string | **yes** | The message |
| `level` | string | no | `error`, `warn`, `info`, `log`, `debug` |

### Aliases

| Canonical | Also accepted |
|---|---|
| `tMs` | `t`, `timestampMs`, `time` |
| `events` | `entries`, or a bare array |
| `kind` | `type`; `xhr`/`fetch`/`request`/`http` all mean network |
| `url` | `uri`, `request` |
| `method` | `verb` |
| `status` | `statusCode`, `responseCode` |
| `durationMs` | `duration`, `elapsedMs` |
| `text` | `message`, `msg` |
| `level` | `severity` |

---

## What is deliberately not captured

**No headers. No request or response bodies.**

This is not an oversight and it is not laziness. Auth tokens live in headers,
and the promise talkthru makes is that your data stays on your machine — which
stops being true the moment your agent reads the session and sends it to a
model. `method`, `url`, `status` and `durationMs` answer *which call broke*
without carrying a credential along with the answer.

URLs are scrubbed on the way in regardless, because query strings leak too:

- Any parameter whose **name** matches `token`, `key`, `secret`, `password`,
  `auth`, `signature`, `session`, `credential`, `bearer` has its **value**
  replaced with `REDACTED`. The name is kept — it is diagnostic
- `user:pass@host` credentials are stripped from the authority
- Fragments carrying a token (OAuth implicit flows) are redacted

```
https://api.example.com/me?access_token=hunter2&page=2
→ https://api.example.com/me?access_token=REDACTED&page=2
```

Redaction happens at parse time, so a secret never reaches disk in the session
bundle, let alone the agent.

---

## What reaches the agent

Everything you send is stored. Only **notable** events are put in front of the
agent by default:

- network with `status >= 400`, or `status === 0` (never completed)
- console at `error` or `warn`

A 200 on a polling endpoint is not evidence, and there are hundreds of them. Two
minutes of XHR traffic is more text than the frames and narration combined, and
it would crowd out the thing you actually said.

**Windowing.** Events attach to an utterance spanning
`[start - 5s, end]`. The window reaches backwards because the causal order is
always the same: the thing breaks, and *then* you say something about it.

**Budget.** At most **6 events** per utterance. Over budget, the ones nearest to
what you said win — truncating the tail would drop the event that fired *while*
you were complaining.

**Tally.** The session header always reports everything captured, so a clean
timeline reads as "nothing broke" rather than "nothing was recorded":

```
# Talkthru session 20260807-140102-a1b2c3
demo 1.2.3 · 107s · 20 frames · 22 utterances · 84 requests (3 failed) · 12 console lines (2 error/warn)
```

**Output.** Notable events appear on `net:` lines under the frame they belong to:

```markdown
## 00:34 · f11 — `frames/f11.jpg`
ui: button#checkout-submit "Place order" @24,680 342x48
net: POST https://api.example.com/checkout 500 340ms
net: error: TypeError: cannot read property 'id' of undefined
- [00:39] "I tapped place order and nothing happened"
```

---

## Failure behaviour

Identical to the hierarchy file — the sidecar is an accessory, and losing a
recording over one would be a bad trade:

- Invalid JSON is ignored, with a warning on the session
- Entries with no numeric `tMs` are dropped
- A network entry with no `url`, or a console entry with no `text`, is dropped
- Messages are collapsed to one line and truncated to 200 characters
- URLs are truncated to 180 characters
- Unknown fields are ignored
- Events may be emitted out of order; they are sorted on the way in

If you write no `events.json` at all, nothing about your session changes — no
`net:` lines, no extra keys in `session.json`, and the same `session.md` you got
before this existed.

---

## Writing one

1. **Timestamp against the video**, not wall clock. `tMs: 0` is the first frame.
2. **Send everything.** Filtering is done here, and it is better at it than a
   filter written against one screen. Storing it all is also what makes
   "show me every request" possible later.
3. **Use `status: 0`** for a request that never completed — DNS failure,
   timeout, offline. It is treated as notable.
4. **Do not send headers or bodies.** They are not in the format, and adding
   them locally would defeat the point.

A browser client is roughly: wrap `fetch`/`XMLHttpRequest`, patch the `console`
methods, record `performance.now()` offsets against recording start, dump JSON
at the end. Contributions welcome.
