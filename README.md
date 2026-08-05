# talkthru

**[talkthru.dev](https://talkthru.dev)** · [npm](https://www.npmjs.com/package/talkthru) · MIT

**An automated feedback loop for any app.** Screen-record your app on your phone and talk
while you use it. Send it to your machine and your coding agent gets everything you
said, attached to the screen you were looking at when you said it.

```
you:    *tapping through checkout* "this button is too small, I keep missing it"
                                  "and this error doesn't say what went wrong"

agent:  sees both screens, finds both components, fixes them.
```

Runs entirely on your machine. No accounts, no uploads, no API keys.

Tested on macOS with an iPhone. Any video with sound works — point the watcher at a folder.

[![Watch the 70-second demo](https://img.youtube.com/vi/A1CJRWSLq7o/maxresdefault.jpg)](https://youtu.be/A1CJRWSLq7o)

*70-second demo — install, record, and the agent picking it up.*


---

## Install

```bash
npx talkthru doctor --fix
```

Pulls `ffmpeg`, `whisper.cpp` and the speech model. Nothing else to set up.

## Start the watcher

```bash
npx talkthru watch
```

Leave it running. It only touches files named like a screen recording — the rest of your
Downloads folder is invisible to it.

## Connect your agent

talkthru is an MCP server, so any MCP client works — Cursor, Windsurf, Cline, Zed,
Claude Desktop. Add it to your client's config:

```json
{
  "mcpServers": {
    "talkthru": {
      "command": "npx",
      "args": ["talkthru-mcp"]
    }
  }
}
```

Claude Code has a one-liner for the same thing:

```bash
claude mcp add --scope user talkthru -- npx talkthru-mcp
```

Restart your client afterwards so it picks up the server.

Built and tested against Claude Code. Other MCP clients should work — tell me if yours doesn't.

---

## Set up your phone

Once. Control Centre → **+** → **Add a Control** → **Screen Recording**. Then press and
hold it and turn the **microphone on**.

<table>
<tr>
<td width="33%"><img src="site/img/web/ios-1-plus.jpg" alt="Tap the plus button"></td>
<td width="33%"><img src="site/img/web/ios-2-add-control.png" alt="Tap Add a Control"></td>
<td width="33%"><img src="site/img/web/ios-3-screen-recording.png" alt="Pick Screen Recording"></td>
</tr>
<tr>
<td><b>1.</b> tap <b>+</b></td>
<td><b>2.</b> Add a Control</td>
<td><b>3.</b> pick Screen Recording</td>
</tr>
<tr>
<td><img src="site/img/web/ios-4-long-press.png" alt="Press and hold the record button"></td>
<td><img src="site/img/web/ios-5-mic-on.png" alt="Microphone switched on"></td>
<td><img src="site/img/web/ios-6-rec.png" alt="Recording started"></td>
</tr>
<tr>
<td><b>4.</b> press and hold ◉</td>
<td><b>5.</b> Microphone <b>On</b></td>
<td><b>6.</b> tap ◉ and talk</td>
</tr>
</table>

---

## Use it

1. Record your app, talk as you go
2. Get the video onto your machine (AirDrop is easiest)
3. Ask your agent: **"check the feedback in my last talkthru session and implement it"**

Ready in about twenty seconds. Your original video is kept in `~/.talkthru/archive/`.

**Mute your app if it talks.** Its narration lands in the transcript next to yours and
whisper can't tell you apart.

---

## Output

Your words, attached to the screen that was up when you said them:

```markdown
## 00:34 · f11 — `frames/f11.jpg`
- [00:39] "this button is too small, I keep missing it"

## 00:52 · f13 — `frames/f13.jpg`
- [00:55] "and this error doesn't say what actually went wrong"
```

Plus the frames. A two-minute session is about 600 tokens.

---

## Commands

```bash
talkthru watch                  # watch ~/Downloads for screen recordings
talkthru watch ~/some-folder    # watch your own folder, any video
talkthru process video.mp4      # process one file
talkthru list                   # recent sessions
talkthru show latest            # print one
talkthru doctor                 # check the setup
talkthru prune                  # delete old sessions
```

`tt` also works.

---

## How it works

`ffmpeg` pulls the frames where your screen actually changed. `whisper.cpp` transcribes
your voice locally, split on the real silence between sentences, so each thing you said
lands on the screen you were looking at. An MCP server hands it to your agent.

Needs Node 20.11+.

---

## Why

I built this because I test my own app on my phone every day and kept losing the feedback
on the way back to my editor — screenshotting, cropping, trying to describe which screen I
meant. Now I just record, talk, and Claude Code picks it up. Sharing it in case it saves
you the same trip.
