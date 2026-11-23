# Air Instruments

Play a **harp**, a **doira** (Uzbek frame drum), a **theremin** and an **air piano** in mid-air with your bare hands. All you need is a webcam.

- Free and open: no account, no backend, no paid service.
- **Your video never leaves your device.** The hand tracking runs inside your browser; nothing is uploaded.
- All sound is made in code (Web Audio). There are no sample files.

<!-- GIF: record a short clip with the Record button in the app (or press V), convert it with e.g.
     ffmpeg -i clip.webm -vf "fps=15,scale=640:-1" docs/demo.gif  and show it here with ![demo](docs/demo.gif) -->

## Try it

Open the page in the latest **Chrome** or **Edge** on a laptop, click **Start** and allow the camera.
The camera needs `https://` (or `localhost`), so use the hosted link or run it locally (see below).

For the best experience:

- **Put light on your hands** (a lamp, or face a window). In a dim room most webcams slow down to 15 frames per second and tracking gets jumpy. The app tells you when it sees this.
- Sit a little back so **both hands** are in the picture, palms toward the camera.
- Wear headphones or use speakers: the sound has a light reverb.

## How to play

Switch instrument with the buttons at the top or the keys **1 2 3 4**. The **?** button (or the `?` key) shows how to play the current instrument again.

### 1. Harp: strings of light

| Do this | What happens |
|---|---|
| Pinch with **both hands** (thumb to index) in empty space and pull them apart, then open the fingers | A string of light is fixed between your two pinch points. |
| Pinch with one hand, drag, open | A string from where you started to where you let go. |
| Move a finger **across** a string | It is plucked. A faster move is louder; touching near the end sounds brighter. |
| Pinch **near** a string and move | You carry the string. Flick it fast off the screen to remove it. |
| Hold both open palms **still** for 1.5 s | Clears all strings (a ring fills up). |
| `Z` / `C` or the buttons | Undo / clear. |

A longer string is a lower note. The notes always come from a scale (D major pentatonic by default, so everything sounds good). You can change the scale below the strings. Up to 12 strings.

### 2. Doira: frame drum

- Hit the drum with your **palm**: move it into the drum fast, or slam down inside it and stop. Louder when faster.
- **Middle of the drum = deep "bum", near the edge = sharp "tak".** Hard hits add the jingles.
- Flick your **fingers** over the drum for soft taps. Finger rolls work.
- **Pinch** the drum and drag to move it.

### 3. Theremin

- **Right hand height = pitch**, **left hand height = volume** (low = silent).
- The first time, you are asked to show your lowest and highest hand position for 2 seconds. Press **K** to do it again.
- **Wobble your right hand sideways** for vibrato. Hold a note and a gentle vibrato appears by itself.
- **Pinch** with the right hand to stop the sound (to separate notes).

### 4. Air piano

- Hold your palm toward the camera, fingers up, above the keys.
- **Bend a finger toward your palm** like pressing a button. The ring on the fingertip fills up and the note plays; straighten the finger to stop it. Use several fingers for chords.
- Moving the whole hand along the keys plays nothing.
- If notes are missed, press **Easy**; if you get accidental notes, press **Strict**. The octave buttons move the keys.

## Record and share

Press **V** (or the **Record** button) to record your performance, picture and sound, to a `.webm` video. Press again to stop; the file downloads. The recording is made in your browser and is never uploaded.

## Keys

`1`-`4` instrument · `?` help · `V` record video · `F` fullscreen · `H` show hand skeletons · `D` debug panel (numbers, test settings, **Copy report**).

## If something does not work

| Problem | What to do |
|---|---|
| "The camera is blocked" | Click the camera icon in the address bar, choose Allow, press **Try again**. |
| "The camera is busy" | Close Zoom / Teams / other tabs that use the camera. |
| Slow, jumpy, hands lost | More light on your hands; step back a little; close heavy tabs. |
| The first start takes long | It downloads about 11 MB once (the hand model). Later starts are quick. |
| Phones and tablets | Not supported yet: the app is made for a laptop with a webcam. |

## Run it on your computer

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev        # http://localhost:5173 (the camera works on localhost)
npm test           # unit tests (gesture logic, sound, layout)
npm run build      # production build into dist/
npm run preview    # serve the production build at http://localhost:4173
```

## Put it online (free)

The build is plain static files (`dist/`), so any free static host works. Asset paths are relative, so it works in a sub-folder such as `https://you.github.io/air-instruments/`.

**GitHub Pages** (a workflow is included in `.github/workflows/pages.yml`):

1. Push the repository to GitHub.
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main` (or run the workflow by hand). The page appears at `https://<you>.github.io/<repository>/`.

**Vercel** (free plan): import the repository, framework preset **Vite**, build command `npm run build`, output directory `dist`.

The hand tracking files are downloaded from public addresses (the model from Google's storage, the WebAssembly files from jsDelivr), pinned to one exact version. The page must not set a strict Content-Security-Policy that blocks them or blocks `eval` inside the tracking worker (GitHub Pages and Vercel do not set one by default).

## How it is built

- **Vite + TypeScript** (strict), no UI framework. Exact dependency versions.
- **MediaPipe HandLandmarker** (`@mediapipe/tasks-vision`) in a **Web Worker**, GPU with CPU fallback. Hands are smoothed with a One Euro filter.
- **Canvas 2D** for the lights (additive blending), the camera is a normal `<video>` under it.
- **Web Audio** with an AudioWorklet (Karplus-Strong strings), FM electric piano, synthesized drum and theremin, a generated reverb.
- **Vitest**: the gesture and instrument logic is pure code, tested with synthetic hands.

`PLAN.md` is the project contract (goals, architecture, stages) and `HANDOFF.md` is the log of what was built and measured.

## Credits

Hand tracking: [MediaPipe](https://developers.google.com/mediapipe) by Google (Apache 2.0). The idea of "strings of light" was inspired by a popular viral demo; this is an independent implementation.
