// Leg joiner: a sleeve that joins a new piece of tube to the bottom of each
// tripod leg, to make the legs longer for the 6 m pole. The old leg goes in
// the top, the new tube in the bottom; a stop ring in the middle keeps both
// 60 mm deep. Drill each tube through the bolt holes and fit an M5 bolt and
// nyloc nut (or a 5 mm pin) at each end.
// Print standing up, PETG (or PLA), 4 walls, 40% infill, built-in brim.
// Print 3 (one per leg).

leg_hole  = 14.0;  // tube hole: the size that fitted on leg-fit-test  <-- SET
wall      = 4.5;   // sleeve wall
depth     = 60;    // how far each tube goes in
stop      = 4;     // stop ring in the middle: height
stop_lip  = 1.5;   // how far the stop ring sticks in
bolt      = 5.5;   // bolt hole (M5)
bolt_in   = 25;    // bolt hole: distance from each end

brim        = 8;
brim_height = 0.4;
$fn = 120;

length = 2 * depth + stop;
d_out  = leg_hole + 2 * wall;

module joiner() {
  difference() {
    cylinder(h = length, d = d_out);
    // Tube holes from both ends, leaving the stop ring in the middle.
    translate([0, 0, -1]) cylinder(h = depth + 1, d = leg_hole);
    translate([0, 0, depth + stop]) cylinder(h = depth + 1, d = leg_hole);
    cylinder(h = length, d = leg_hole - 2 * stop_lip);
    // Bolt holes, one near each end, straight through.
    for (z = [bolt_in, length - bolt_in])
      translate([0, 0, z]) rotate([90, 0, 0]) cylinder(h = 50, d = bolt, center = true);
  }
}

joiner();
if (brim > 0)
  linear_extrude(height = brim_height)
    difference() {
      circle(d = d_out + 2 * brim);
      circle(d = leg_hole - 1);
    }
