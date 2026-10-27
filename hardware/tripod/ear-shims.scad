// Shims and washers for the collar's leg bolts (M6, 6.5 mm hole).
// The leg ends are 13 mm wide in a 15 mm gap, so up to 2 mm of shims per ear.
// Rows, front to back: 0.4, 0.6, 0.8, 1.0 mm shims (6 of each), then
// 2 mm outer washers (6, two per bolt: under the head and under the nut).
// Print flat in PLA or PETG, 0.2 mm layers, glue stick on the bed.

hole        = 6.5;               // same as the collar's leg bolt holes
shim_od     = 12;                // shims sit between the leg end and a tab
shims       = [0.4, 0.6, 0.8, 1.0];
washer_od   = 16;
washer_t    = 2;
per_row     = 6;
pitch       = 20;                // spacing between parts
$fn = 72;

module ring(od, t) difference() {
  cylinder(h = t, d = od);
  translate([0, 0, -1]) cylinder(h = t + 2, d = hole);
}

for (r = [0 : len(shims) - 1], c = [0 : per_row - 1])
  translate([c * pitch, r * pitch, 0]) ring(shim_od, shims[r]);
for (c = [0 : per_row - 1])
  translate([c * pitch, len(shims) * pitch, 0]) ring(washer_od, washer_t);
