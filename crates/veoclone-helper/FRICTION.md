# VeoClone helper: Reco API friction

Friction points met while building the VeoClone helper against reco-io.

## Active

### V1. Chained input: a start time past the first file is not frame-exact

**Impact**: Medium. `StitchJob::start_time` on an `InputPath::Chained`
seeks by time through the ffconcat manifest, whose `duration` lines are
each file's container duration. A GoPro chapter's sound runs a little past
its picture, so later files start slightly late on the joined clock and a
seek can land a frame off. The helper works around it: each export part
reads the chain from the file holding its first frame, with `start_time`
and `sync_offset` counted from there (`export::reads`, DESIGN.md 4.10).
A frame-count seek for chained sources (or video-stream durations in the
manifest) would remove that.

### V2. Chained audio passthrough trims only the first file

**Impact**: Medium. `forward_audio_packets_until` (reco-io encoder)
applies the start-time trim to the first segment only. Reading the code,
with a start past the first file every packet of it is dropped and the next
file's sound is appended from its own beginning, so the export's sound
would come from the wrong moment. Avoided by the same per-part chain as V1.

## Fixed

### V3. ffconcat manifest did not escape quotes

`VideoDecoder::open_chained` wrote `file '<path>'` as is, so a path with
an apostrophe (`C:\Users\O'Brien\…`) broke chained input. Now escaped
(`concat_file_line`, unit tested).
