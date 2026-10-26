// Tripod collar for the 6 m camera pole (DRAFT - measurements to confirm).
// A sleeve slides onto the pole; three "ears" (pairs of tabs) hold the
// tripod legs on a bolt; a clamp screw locks the collar on the pole.
// All sizes in mm. Print standing up (sleeve axis vertical), PETG,
// 4 walls, 40% gyroid infill, glue stick on the bed.

pole_hole   = 48;   // sleeve inner diameter (48 mm test ring fitted perfectly)
sleeve_wall = 8;    // sleeve wall thickness
height      = 30;   // collar height = ear height

legs        = 3;    // number of ears
leg_width   = 13.5; // gap between the two tabs: 13 mm leg end + 0.5 mm clearance
tab         = 6;    // thickness of each tab
ear_reach   = 28;   // how far the ears stick out past the sleeve
bolt        = 6.5;  // bolt hole (6.5 suits an M6 bolt)                  <-- MEASURE
bolt_from_tip = height / 2; // bolt hole centre: middle of the rounded ear end

clamp_bolt  = 6.5;  // clamp screw hole (M6)
clamp_nut   = 11.5; // hex nut pocket across flats (M6 nut is 10 mm + clearance)
clamp_nut_depth = 6;

$fn = 120;
r_out = pole_hole / 2 + sleeve_wall;

module ear() {
  // Two tabs with a gap between them, joined to the sleeve.
  difference() {
    for (s = [-1, 1])
      translate([0, s * (leg_width / 2 + tab / 2) - tab / 2, 0])
        hull() {
          cube([r_out - 4, tab, height]);
          translate([r_out + ear_reach - height / 2, 0, height / 2])
            rotate([-90, 0, 0]) cylinder(h = tab, d = height);
        }
    // Bolt hole through both tabs.
    translate([r_out + ear_reach - bolt_from_tip, -50, height / 2])
      rotate([-90, 0, 0]) cylinder(h = 100, d = bolt);
  }
}

difference() {
  union() {
    cylinder(h = height, r = r_out);
    for (i = [0 : legs - 1]) rotate([0, 0, i * 360 / legs]) ear();
    // Boss for the clamp screw, between two ears.
    rotate([0, 0, 180 / legs]) translate([r_out - 3, -9, 0]) cube([10, 18, height]);
  }
  // Pole hole.
  translate([0, 0, -1]) cylinder(h = height + 2, d = pole_hole);
  // Clamp screw hole and a nut pocket on the outside.
  rotate([0, 0, 180 / legs]) {
    translate([0, 0, height / 2]) rotate([0, 90, 0]) cylinder(h = 100, d = clamp_bolt);
    translate([r_out + 7 - clamp_nut_depth, 0, height / 2]) rotate([0, 90, 0])
      cylinder(h = 20, d = clamp_nut / cos(30), $fn = 6);
  }
}
