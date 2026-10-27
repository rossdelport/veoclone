// Tripod foot: a cap on the bottom of each leg with a wide, flat pad so the
// leg doesn't sink into the grass, plus two holes for tent pegs to hold the
// tripod down in wind. The pad is tilted to match the leg angle, so it sits
// flat on the ground when the tripod is set up.
// Print with the pad flat on the bed (as drawn), PETG (or PLA), 4 walls,
// 40% infill, no supports. Print 3 (one per leg).

leg_hole  = 14.0;  // tube hole: the size that fitted on leg-fit-test  <-- SET
leg_angle = 25;    // leg lean from straight up, degrees (about 20-30)
wall      = 4.5;   // socket wall
depth     = 45;    // how far the tube goes in
bolt      = 5.5;   // bolt hole (M5) to stop the foot falling off
pad       = 80;    // pad diameter
pad_h     = 6;     // pad thickness
peg       = 7;     // tent peg holes
$fn = 120;

d_out = leg_hole + 2 * wall;

difference() {
  union() {
    // Pad with a rounded top edge.
    hull() {
      cylinder(h = pad_h - 2, d = pad);
      cylinder(h = pad_h, d = pad - 4);
    }
    // Socket leaning at the leg angle, with a solid base.
    hull() {
      cylinder(h = pad_h, d = d_out + 16);
      rotate([0, leg_angle, 0]) translate([0, 0, pad_h + 4]) cylinder(h = 1, d = d_out);
    }
    rotate([0, leg_angle, 0]) cylinder(h = pad_h + 6 + depth, d = d_out);
  }
  // Tube hole.
  rotate([0, leg_angle, 0]) translate([0, 0, pad_h + 6]) cylinder(h = depth + 1, d = leg_hole);
  // Bolt hole through the socket.
  rotate([0, leg_angle, 0]) translate([0, 0, pad_h + 6 + depth - 15])
    rotate([90, 0, 0]) cylinder(h = 50, d = bolt, center = true);
  // Tent peg holes on either side.
  for (s = [-1, 1]) translate([0, s * (pad / 2 - 9), -1]) cylinder(h = pad_h + 2, d = peg);
  // Flat bottom (cuts anything below the bed).
  translate([-100, -100, -50]) cube([200, 200, 50]);
}
