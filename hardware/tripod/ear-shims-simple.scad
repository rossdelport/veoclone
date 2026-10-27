// Simple set for one leg bolt (M6, 6.5 mm hole): 2 shims + 2 washers.
// The 13 mm leg end sits in a 15 mm gap, so one 1 mm shim each side of the
// leg fills it. Washers go outside the tabs (under the bolt head and the nut).
// Thick enough to print cleanly. Print flat, glue stick on the bed.

hole      = 6.5;
shim_od   = 12;  shim_t   = 1.0;  // between leg end and tab
washer_od = 18;  washer_t = 3.0;  // outside the tabs
pitch     = 24;
$fn = 72;

module ring(od, t) difference() {
  cylinder(h = t, d = od);
  translate([0, 0, -1]) cylinder(h = t + 2, d = hole);
}

for (i = [0 : 1]) translate([i * pitch, 0, 0]) ring(shim_od, shim_t);
for (i = [0 : 1]) translate([i * pitch, pitch, 0]) ring(washer_od, washer_t);
