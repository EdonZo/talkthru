# talkthru

**[talkthru.dev](https://talkthru.dev)** · [npm](https://www.npmjs.com/package/talkthru) · MIT

**An automated feedback loop for any app.** Screen-record your app on your phone and talk
while you use it. Send the recording to your Mac and your coding agent gets everything you
said, attached to the screen you were looking at when you said it.

```
you:    *taps around* "this quest card sits on top of the sun, it washes out"

Claude: reads that exact frame, sees the card against the glow, fixes the component.
```

Runs entirely on your machine. No accounts, no uploads, no API keys.

Tested on macOS with an iPhone. Any video with sound works — point the watcher at a folder.

---

## Install

```bash
npx talkthru doctor --fix
claude mcp add --scope user talkthru -- npx talkthru-mcp
```

First command installs `ffmpeg` + `whisper.cpp` and downloads the speech model. Second
tells Claude Code where to find your sessions — restart Claude Code afterwards so it picks
it up.

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

Leave this running:

```bash
talkthru watch
```

Then:

1. Record your app, talk as you go
2. AirDrop the video to your Mac
3. Ask Claude Code: **"check the feedback in my last talkthru session and implement it"**

Ready in about twenty seconds. Your original video is kept in `~/.talkthru/archive/`.

**Mute your app if it talks.** Its narration lands in the transcript next to yours and
whisper can't tell you apart.

---

## Output

Your words, attached to the screen that was up when you said them:

```markdown
## 00:34 · f11 — `frames/f11.jpg`
- [00:39] "the settings here is a bit off, you have to scroll down
           instead of scrolling the whole sheet"
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
lands on the screen you were looking at. An MCP server hands it to Claude Code.

Needs Node 20.11+.
