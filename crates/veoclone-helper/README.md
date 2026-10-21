# veoclone-helper

The VeoClone helper: a local web server (127.0.0.1:47863) that stores the
user's matches on disk and runs calibration, AI tracking and export through
the Reco libraries. The contract with the editor is
[docs/veoclone/DESIGN.md](../../docs/veoclone/DESIGN.md) section 4.

## Build

```bash
cargo build --release -p veoclone-helper                          # links ONNX Runtime
cargo build --release -p veoclone-helper --features load-dynamic  # loads onnxruntime at run time (Windows release)
```

On Windows the DirectML provider is compiled in automatically (target-specific
dependencies, as in reco-gui).

## Run

```bash
veoclone-helper [--port 47863] [--data-dir DIR] [--web-dir DIR] [--model FILE]
                [--allow-origin ORIGIN]... [--no-open]
```

- `ffmpeg`/`ffprobe` are taken from next to the program, then from PATH.
- The AI model is `--model`, else `VEOCLONE_MODEL`, else
  `models/yolo26n.onnx` (or `models/yolo26n_640.onnx`) next to the program.
- Matches are stored in `--data-dir`, else `VEOCLONE_HOME`, else
  `<Videos>/VeoClone`.
- With `load-dynamic`, `onnxruntime.dll` must sit next to the program (or set
  `ORT_DYLIB_PATH`).

## Test

```bash
cargo test -p veoclone-helper
# Renders real video (needs ffmpeg on PATH and a GPU; llvmpipe works):
cargo test -p veoclone-helper -- --ignored export_frame_alignment
# Whole HTTP flow against a release binary (Python 3, ffprobe on PATH):
python3 crates/veoclone-helper/scripts/e2e.py --helper target/release/veoclone-helper \
  --left left.mp4 --right right.mp4 --model yolo26n_640.onnx --work /tmp/veoclone-e2e
```

## API notes beyond DESIGN.md

- `POST /api/projects` and `POST /api/projects/:id/exports` answer `201`.
- `DELETE` routes, `PUT /edits` and `POST /open-folder` answer `{ "ok": true }`
  (export `DELETE` returns the updated `ProjectMeta`).
- `POST /process` and `POST /cancel` return the `ProjectMeta`.
- `X-Filename` may be percent-encoded (`encodeURIComponent`) for non-ASCII
  names.
- `ExportMeta.error` is a plain string.
- Export accepts any even 16:9 size from 320 to 3840 pixels wide.
- `/api/health` `gpu.name`/`gpu.backend` are empty and `ai.provider` is
  `"checking"` for the first second or two after start; `ai.provider` is
  `"DirectML"`, `"CPU"` or `"none"`.
- Changing `lensId` with `PATCH` keeps the old results until the next
  `process`, which then re-calibrates; uploading a new file deletes all
  results made from the old one.
