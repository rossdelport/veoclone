// First-layer test for the Ender-3 V3 SE (220 x 220 bed).
// Five flat squares, one layer thick (0.2 mm): four near the corners and one
// in the middle. Watch them print: every square should come out as a smooth,
// flat, joined sheet. Round separate lines = nozzle too high (lower Z offset);
// thin, see-through or scraped = too low; good in some squares but not others
// = bed not level (run auto-levelling again) or dirty in those spots.

size  = 30;   // square size, mm
layer = 0.2;  // one layer
margin = 25;  // distance from the bed edge
bed   = 220;

for (p = [[margin, margin], [bed - margin - size, margin],
          [margin, bed - margin - size], [bed - margin - size, bed - margin - size],
          [(bed - size) / 2, (bed - size) / 2]])
  translate([p[0], p[1], 0]) cube([size, size, layer]);
