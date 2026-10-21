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
videos (Try again then works); "slow" makes its jobs 10 times slower.
`GET /__mock/state` shows what the editor sent (edits, last export with a
summary of the camera path, "Show in folder" calls); `POST /__mock/reset`
(`?seed` for the example match) forgets everything.

To use another helper address, open the editor with `?helper=http://127.0.0.1:PORT`
(remembered in the browser; `?helper=` with no value forgets it).

## Fixtures

Made by the real helper from the synthetic footage (two overlapping views of a
football picture, 20 s, 30 fps, right phone started 12 frames early):

- `calib.json`, `ai_path.bin`: the helper's own output (`PROJECT_ID` in the
  proxy URL is filled in per match).
- `proxy.mp4`: the helper's stacked preview (1280x1440, left camera on top,
  600 frames), re-encoded as VP9 + Opus because Playwright's Chromium cannot
  play H.264. The real helper makes H.264.
- `lenses.json`: the real helper's `/api/lenses` list.
- `left-small.mp4`, `right-small.mp4`: tiny clips for upload tests.

## UI tests

```sh
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:ui
```

Builds the editor, starts it with `vite preview` and the mock helper, and runs
`tests/ui/*.spec.ts` in Chromium with software WebGL. Set
`UI_SHOTS_DIR=/some/folder` to save a screenshot of each page.
