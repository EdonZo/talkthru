# Talkthru session <session-id>
FixtureApp 1.0.0 · Fixture / synthetic · 60s · 6 frames · 6 utterances · note: synthetic fixture — deterministic scene cuts every 10s

Frames are JPEGs beside this file. `ui:` lines list on-screen elements (`Type#testId "label" @x,y WxH`, screen points) captured with the frame.

## 00:00 · f00 — `frames/f00.jpg`
ui: header#app-header "AstroShort" @40,60 400x90 | button#planet-mars "Mars" @90,300 120x120
- [00:02] "This is the home screen, the header spacing at the top looks wrong."

## 00:10 · f01 — `frames/f01.jpg`
ui: header#app-header "AstroShort" @40,60 400x90 | div#planet-card "Mars — the red planet" @90,300 300x300
- [00:12] "Now I tap Mars and the Planet card opened."

## 00:20 · f02 — `frames/f02.jpg`
ui: section#fact-panel "Diameter 6,779 km" @20,500 440x200
- [00:22] "The fact panel down here is too low on the screen."

## 00:30 · f03 — `frames/f03.jpg`
ui: button#settings-close "Close" @60,120 360x60
- [00:32] "This is Settings. The Close button was way too small."

## 00:40 · f04 — `frames/f00.jpg` (back on the f00 screen)
ui: header#app-header "AstroShort" @40,60 400x90
- [00:42] "I am back on the home screen again, same spacing problem."

## 00:50 · f05 — `frames/f05.jpg`
occluded: system alert — not visible in this frame
ui: div#error-banner "Could not load" @100,400 280x120
- [00:52] "and this error state, the yellow is far too bright."

## Warnings
- The audio track is silent (-91 dB) — the microphone was off. In Control Centre, press and hold the Screen Recording button and switch the Microphone on, then record again.
