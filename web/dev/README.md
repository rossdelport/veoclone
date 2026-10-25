# Working on the editor without the helper

`mock-helper.mjs` is a pretend VeoClone helper: the same HTTP API as
`crates/veoclone-helper` (docs/veoclone/DESIGN.md 4.5), zero dependencies,
everything in memory. Processing and exports are faked with timers.

```sh
cd web
npm run mock          # mock helper on http://127.0.0.1:47863 (where the editor looks by default)
npm run dev           # editor on http://localhost:5173
```

It starts with one ready "Example match" so the editor opens straight away.
Options: `--port N`, `--empty` (no matches), `--speed X` (fake jobs X times
faster), `--web DIR` (also serve a built editor, like the real helper).

Test hooks: a match whose name contains "fail" fails once while lining up the
videos (Try again then works; a re-run of a ready match goes back to ready
with a warning instead, like the real helper, DESIGN.md 4.7); "slow" makes its
jobs 10 times slower; "gopro" gives its calibration a level measured by the
camera (`rig_tilt` 0.12, `rig_roll` -0.03 rad), like Reco does for GoPro and
DJI footage. Like the real helper it refuses to delete a match while
a video is still arriving, and it supports `POST /api/projects/:id/swap` and
`rightLensId` (a lens per phone; swapping swaps the two lenses). New matches
get the Natural widest view, while the example match has none (made before
the setting, so the editor offers its tip); a re-run that can reuse what
the AI saw is quick, and `ai-path.bin` is the fixture path limited to the
widest view the AI ran with (docs/veoclone/DESIGN.md 4.12).
`GET /__mock/state` shows what the editor sent (edits, last export with a
summary of the camera path incl. its widest frame, the "Straighten picture" angles and the text PNGs, "Show in folder" calls,
swaps, AI path downloads); like the real helper it checks the text PNGs (size, times) and adds
an "Adding text" step to exports with text. `POST /__mock/reset`
(`?seed` for the example match) forgets everything.

Updates (docs/veoclone/DESIGN.md 4.11): `/api/health` reports a build and
"up to date"; `POST /__mock/update` with `{ status?, version? }` changes that
(for example `{"status": {"state": "ready"}}`), and `GET /__mock/update`
shows it with the settings the editor sent. **Install now** on a ready
update shows "installing" for 3 s, then the pretend helper is gone for 4 s
(like the real one restarting) and comes back as a newer build.
`GET/PATCH /api/settings` and `POST /api/update/check` work too.

To use another helper address, open the editor with `?helper=http://127.0.0.1:PORT`
(remembered in the browser; `?helper=` with no value forgets it). Only
`http://127.0.0.1:PORT` and `http://localhost:PORT` are accepted, so a link
can never send someone's videos to another computer.

## Fixtures

Made by the real helper from the synthetic footage (two overlapping views of a
football picture, 20 s, 30 fps, right phone started 12 frames early):

- `calib.json`, `ai_path.bin`: the helper's own output (`PROJECT_ID` in the
  proxy URL is filled in per match).
- `proxy.mp4`: the helper's stacked preview (1280x1440, left camera on top,
  600 frames), re-encoded as VP9 + Opus because Playwright's Chromium cannot
  play H.264. The real helper makes H.264.
- `lenses.json`: lens choices in the `/api/lenses` format (DESIGN.md 4.6:
  "Not sure" first, then the iPhones newest first, Ultra wide and Normal each).
- `left-small.mp4`, `right-small.mp4`: tiny clips for upload tests.

## UI tests

```sh
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:ui
```

Builds the editor, starts it with `vite preview` and the mock helper, and runs
`tests/ui/*.spec.ts` in Chromium with software WebGL. Set
`UI_SHOTS_DIR=/some/folder` to save a screenshot of each page.
