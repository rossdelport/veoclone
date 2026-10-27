// Printed thumb screw + nut for the collar and brace hub clamps.
// Fits the parts' 6.5 mm clamp hole and 11.5 mm hex nut pocket.
// The thread is a coarse, rounded 6 mm thread (2 mm pitch) that prints
// cleanly; screw and nut only fit each other (not shop M6 parts).
// Two sets on the plate (one for the collar, one for the hub).
// Print in PETG or PLA, 0.16-0.2 mm layers, screws standing on their knobs,
// glue stick on the bed. No supports.

thread_d   = 6.0;   // outer thread diameter (hole in the parts is 6.5)
pitch      = 2.0;   // mm per turn
depth      = 0.8;   // thread depth
clearance  = 0.4;   // nut thread is this much bigger all round
shank      = 22;    // threaded length: reaches the pole through nut + wall

knob_d     = 26;    // thumb knob
knob_h     = 9;
grips      = 10;    // finger grooves round the knob

nut_af     = 11;    // across flats (pocket is 11.5)
nut_h      = 6;     // pocket is 6 deep

brim        = 5;    // built-in brim under each nut (small parts need help)
brim_height = 0.4;
$fn = 64;

// A rounded thread: an off-centre circle twisted up the screw.
module thread(d, len, extra = 0) {
  r = (d - depth) / 2 + extra;
  linear_extrude(height = len, twist = -360 * len / pitch, slices = len * 12)
    translate([depth / 2, 0]) circle(r = r);
}

module screw() {
  // Knob with finger grooves, flat on the bed.
  difference() {
    cylinder(h = knob_h, d = knob_d);
    for (i = [0 : grips - 1]) rotate([0, 0, i * 360 / grips])
      translate([knob_d / 2 + 1.2, 0, -1]) cylinder(h = knob_h + 2, d = 5);
    // Soft edge on top.
    translate([0, 0, knob_h - 1]) difference() {
      cylinder(h = 2, d = knob_d + 2);
      cylinder(h = 2, d1 = knob_d, d2 = knob_d - 3);
    }
  }
  // Threaded shank with a blunt tip so it doesn't dig into the pole.
  translate([0, 0, knob_h]) intersection() {
    thread(thread_d, shank);
    cylinder(h = shank, d1 = thread_d + 2, d2 = thread_d - 1.2);
    // keep the tip rounded off only near the end
  }
}

module nut() {
  difference() {
    cylinder(h = nut_h, d = nut_af / cos(30), $fn = 6);
    translate([0, 0, -0.01]) thread(thread_d, nut_h + 0.02, clearance);
    // Lead-in chamfers so the screw starts easily.
    translate([0, 0, -0.01]) cylinder(h = 1, d1 = thread_d + 1.4, d2 = thread_d - 0.2);
    translate([0, 0, nut_h - 0.99]) cylinder(h = 1, d1 = thread_d - 0.2, d2 = thread_d + 1.4);
  }
  if (brim > 0)
    linear_extrude(height = brim_height) difference() {
      circle(d = nut_af / cos(30) + 2 * brim, $fn = 6);
      circle(d = thread_d + 2 * clearance + 0.5);
    }
}

for (i = [0 : 1]) {
  translate([i * 36, 0, 0]) screw();
  translate([i * 36, 34, 0]) nut();
}
