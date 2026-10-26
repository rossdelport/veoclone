// Tripod brace hub (the lower "spider" the leg braces attach to).
// A sleeve slides onto the pole; three solid arms take the brace ends on a
// pin through each arm; a clamp screw locks it on the pole.
// All sizes in mm. Print flat (as modelled), PETG, 4 walls, 40% gyroid
// infill, glue stick on the bed. No supports needed.

pole_hole   = 48;   // sleeve inner diameter (48 mm test ring fitted perfectly)
sleeve_wall = 7;    // sleeve wall thickness
height      = 20;   // hub height = arm height                      <-- CHECK

arms        = 3;
arm_width   = 20;   // arm width
arm_reach   = 25;   // how far the arms stick out past the sleeve   <-- CHECK
pin         = 5.5;  // pin hole across each arm (5.5 suits an M5 bolt) <-- CHECK
pin_from_tip = 8;   // pin hole centre, measured in from the arm's tip

clamp_bolt  = 6.5;  // clamp screw hole (M6)
clamp_nut   = 11.5; // hex nut pocket across flats (M6 nut + clearance)
clamp_nut_depth = 6;

brim        = 8;    // built-in brim, peel or cut it off after printing (0 = none)
brim_height = 0.4;

$fn = 120;
r_out = pole_hole / 2 + sleeve_wall;

module arm() {
  difference() {
    translate([0, -arm_width / 2, 0])
      hull() {
        cube([r_out - 4, arm_width, height]);
        translate([r_out + arm_reach - 4, 0, 0]) cube([4, arm_width, height]);
      }
    // Pin hole straight across the arm, side to side.
    translate([r_out + arm_reach - pin_from_tip, -50, height / 2])
      rotate([-90, 0, 0]) cylinder(h = 100, d = pin);
  }
}

module hub() {
  difference() {
    union() {
      cylinder(h = height, r = r_out);
      for (i = [0 : arms - 1]) rotate([0, 0, i * 360 / arms]) arm();
      // Boss for the clamp screw, between two arms.
      rotate([0, 0, 180 / arms]) translate([r_out - 3, -9, 0]) cube([10, 18, height]);
    }
    translate([0, 0, -1]) cylinder(h = height + 2, d = pole_hole);
    rotate([0, 0, 180 / arms]) {
      translate([0, 0, height / 2]) rotate([0, 90, 0]) cylinder(h = 100, d = clamp_bolt);
      translate([r_out + 7 - clamp_nut_depth, 0, height / 2]) rotate([0, 90, 0])
        cylinder(h = 20, d = clamp_nut / cos(30), $fn = 6);
    }
  }
}

hub();
if (brim > 0)
  linear_extrude(height = brim_height)
    difference() {
      offset(r = brim) projection(cut = true) translate([0, 0, -0.1]) hub();
      circle(d = pole_hole - 2);
    }
