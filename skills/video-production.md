---
name: video-production
description: FFmpeg that works — probe first, concat, frame-accurate trim, overlay, audio sync, export presets
when: Cutting, joining, captioning, overlaying, resizing, muxing or exporting video or audio
---

# Video production

Everything here is FFmpeg. **Run `ffprobe` before you run `ffmpeg`** — most
failures in this domain are two inputs that disagree about something you never
looked at.

## ⚠️⚠️ FIRST: can you even run it here?

`ffmpeg` is **not on the default allowlist**. On a default install
`run_command ffmpeg ...` is refused, and so is an `npm run` script whose body
calls it — the script body is validated by the same rules.

Two legitimate routes, both the human's to open:

- `acuvo --shell` for that run, or
- `ACUVO_ALLOW_COMMANDS="ffmpeg:-i|-y|-vf|-af|-c:v|-c:a|-filter_complex|-map|-ss|-to|-t|-r|-crf|-preset|-pix_fmt|-b:a|-movflags|-shortest,ffprobe:-v|-show_entries|-of|-i"`
  in the environment that launches acuvo.

⚠️ **Do not route around it** by spawning ffmpeg from a Node script. Say what
you need and why, in one sentence, and stop. Also check it exists at all:
`ffmpeg -version` — "command not found" and "not allowed" are different problems
with different answers, and reporting the wrong one wastes the human's time.

## Probe first, always

```
ffprobe -v error -show_entries stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels -show_entries format=duration,bit_rate -of default=noprint_wrappers=1 in.mp4
```

Read four things off it before planning anything: **resolution, frame rate,
audio sample rate, and duration.** Two clips at 1080p30 and 720p29.97 will not
stream-copy-concat, and the failure looks like corruption rather than an error.

## Concat — two methods, and the one you pick is decided by the probe

**Same codec, same resolution, same fps** → demuxer, no re-encode, instant:

```
# list.txt — one line per file, single quotes, path relative to list.txt
file 'a.mp4'
file 'b.mp4'

ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4
```

⚠️ `-safe 0` is required for anything but bare relative names. And **`-c copy`
concat of mismatched inputs "succeeds" and produces a file that plays the first
clip then glitches** — that is why you probed.

**Anything else** → filter, which re-encodes and is the safe default:

```
ffmpeg -i a.mp4 -i b.mp4 -filter_complex \
"[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0]; \
 [1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v1]; \
 [0:a]aresample=48000[a0];[1:a]aresample=48000[a1]; \
 [v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" \
-map "[v]" -map "[a]" -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p -c:a aac -b:a 160k out.mp4
```

⭐ `setsar=1` is the one everybody forgets: two clips with different *sample*
aspect ratios concat into a video that changes shape halfway through.
⚠️ If one input has **no audio track**, `concat` with `a=1` fails. Give it
silence: `-f lavfi -t 5 -i anullsrc=r=48000:cl=stereo`.

## Trim — `-ss` before or after `-i` is not a style choice

```
# FAST, seeks by keyframe, ~zero cost. Use for rough cuts and long files.
ffmpeg -ss 00:01:30 -i in.mp4 -t 20 -c copy out.mp4

# FRAME-ACCURATE. Decodes from the start of the GOP, re-encodes. Use for edits.
ffmpeg -ss 00:01:30 -i in.mp4 -to 00:01:50 -c:v libx264 -crf 18 -preset veryfast -c:a aac out.mp4
```

⚠️ **`-c copy` can only cut on a keyframe.** Ask for 1:30 and get 1:28, or get
2 seconds of frozen/black frames at the head. That artefact is not a bug you can
fix downstream — re-encode the cut instead.
⚠️ `-t` is a DURATION, `-to` is a TIMESTAMP. With `-ss` before `-i`, `-to` is
measured from the seek point in modern FFmpeg — mixing them up silently produces
a clip of the wrong length, so check the output's duration with `ffprobe`.

## Overlay — logo, picture-in-picture, and text

```
# Logo bottom-right, 24px margin, scaled to 12% of the video width
ffmpeg -i in.mp4 -i logo.png -filter_complex \
"[1:v]scale=iw*0.12:-1[wm];[0:v][wm]overlay=W-w-24:H-h-24:format=auto" \
-c:a copy out.mp4

# Only between 5s and 12s
...overlay=W-w-24:H-h-24:enable='between(t,5,12)'
```

Burned-in text:

```
ffmpeg -i in.mp4 -vf "drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='Q3 results':\
fontcolor=white:fontsize=48:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-tw)/2:y=h-th-60" \
-c:a copy out.mp4
```

⚠️ **`drawtext` is where Windows breaks.** Three separate traps:
1. Without fontconfig, `font='Arial'` fails — you must give `fontfile`.
2. A Windows path contains `:` which is FFmpeg's own option separator. Escape it
   as `C\:/Windows/Fonts/arial.ttf`, forward slashes.
3. An apostrophe in the text ends the quoted string. Use `textfile=caption.txt`
   for any real copy, and `-vf "subtitles=cc.srt"` for actual captions.

## Audio — sync, mix, and the drift nobody notices until the end

```
# Delay the audio by 500ms relative to video (positive = audio later)
ffmpeg -i in.mp4 -itsoffset 0.5 -i in.mp4 -map 0:v -map 1:a -c copy out.mp4

# Music under narration, music ducked to 25%, stop at the shorter one
ffmpeg -i voice.wav -i music.mp3 -filter_complex \
"[1:a]volume=0.25[m];[0:a][m]amix=inputs=2:duration=shortest:dropout_transition=0[a]" \
-map "[a]" -c:a aac -b:a 192k out.m4a

# Replace the audio track entirely
ffmpeg -i video.mp4 -i track.wav -map 0:v -map 1:a -c:v copy -c:a aac -shortest out.mp4
```

⚠️ **Drift.** A screen recording is variable frame rate; muxing it against a
fixed-rate audio track drifts a few frames per minute — imperceptible at 0:10 and
obviously wrong at 5:00. Force constant frame rate on any VFR source:
`-vsync cfr -r 30`. Confirm the source with `ffprobe`'s `r_frame_rate` vs
`avg_frame_rate` — if they differ, it is VFR.

⚠️ **`-shortest` truncates to the shortest INPUT**, which is usually the one you
wanted to keep. Pad the other instead: `-af apad` or `-vf tpad=stop_mode=clone`.

Normalise loudness for anything anyone will listen to (broadcast/web target):
`-af loudnorm=I=-14:TP=-1.5:LRA=11`. One pass is fine for a prototype; two-pass
(measure, then apply the measured values) is what you do when it matters.

## Export presets — copy these

```
# Web H.264. The default answer for "put it on a page".
-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 160k

# Small (email/Slack), still watchable
-c:v libx264 -preset slow -crf 26 -vf "scale=1280:-2" -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 96k

# Vertical 9:16 from landscape — centre crop, no letterbox
-vf "crop=ih*9/16:ih,scale=1080:1920:flags=lanczos,setsar=1" -c:v libx264 -crf 21 -pix_fmt yuv420p

# Stills → clip (Ken Burns-free, simplest correct version)
ffmpeg -framerate 1/3 -pattern_type glob -i 'shots/*.png' -vf "scale=1920:1080,fps=30" -c:v libx264 -crf 20 -pix_fmt yuv420p out.mp4

# GIF, two-pass palette (one-pass GIFs look like 1998)
ffmpeg -i in.mp4 -vf "fps=12,scale=640:-1:flags=lanczos,palettegen=stats_mode=diff" -y pal.png
ffmpeg -i in.mp4 -i pal.png -filter_complex "fps=12,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" -y out.gif
```

⚠️ **`-pix_fmt yuv420p` is not optional.** Without it libx264 may emit yuv444p,
which Safari, QuickTime and most phones refuse to play — you get a file that
works on your machine and is black for everyone else.
⚠️ **`-movflags +faststart`** moves the index to the front. Without it a video
served over HTTP will not start until it has fully downloaded.
⚠️ `scale=1280:-2` not `-1`: H.264 needs even dimensions and `-1` can produce an
odd height, which fails the encode outright.

## You cannot watch the output — so look at a frame

There is no video preview here. Prove the render instead:

1. `ffprobe` the OUTPUT and check duration, resolution and that both streams exist.
2. Pull a frame from the middle and actually look at it:
   `ffmpeg -ss 00:00:07 -i out.mp4 -frames:v 1 -q:v 2 check.jpg` then `read_image` it.
3. Pull one from each side of a cut or an overlay's `enable` window. A watermark
   that is off-screen, or a caption that is white on white, is invisible in a
   duration check and obvious in one frame.

⚠️ **Long renders exceed `run_command`'s timeout and get killed mid-file**,
leaving a truncated MP4 that ffprobe reports as valid. Use `start_process` for
anything over a minute of footage, then `check_process` / `wait_for_output`, and
add `-progress pipe:1 -nostats` so there is something to watch. Always `-y` or
an existing output file makes ffmpeg sit at an interactive prompt until the
timeout kills it — which reads as "ffmpeg hung".

## ⚠️ What this cannot do

- **No editorial judgement.** Where to cut, which take is better, whether the
  music fits: FFmpeg cannot answer any of that and neither can a frame grab.
- **No transcription or subtitle generation.** Burning an `.srt` is a filter;
  producing one needs a speech model. `transcribe` may be available — check
  before promising captions.
- **No colour grading of consequence.** `eq`, `curves` and a LUT via `lut3d` are
  there; matching two cameras is a human job.
- **Hardware encoders (`h264_nvenc`, `videotoolbox`) are 5–10× faster and worse
  per bit.** Fine for a preview, not for the deliverable.
- **Codec support varies by build.** `libx264` and `aac` are in nearly every
  build; `libx265`, `libsvtav1` and `libfdk_aac` often are not. Check
  `ffmpeg -encoders | grep <name>` before you write a command around one.
