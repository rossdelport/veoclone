// Test rings to find the right hole size for the 45 mm pole.
// Three rings: 1 notch = 45.5 mm, 2 notches = 46.0 mm, 3 notches = 46.5 mm.
// Print in PLA, 0.2 mm layers, no supports. Slide each onto the pole and
// pick the one that slides on easily without wobbling.

holes  = [45.5, 46.0, 46.5]; // inner diameters, mm
wall   = 4;                  // ring wall thickness, mm
height = 5;                  // ring height, mm
gap    = 8;                  // space between rings, mm
$fn    = 180;

module ring(d, notches) {
  difference() {
    cylinder(h = height, d = d + 2 * wall);
    translate([0, 0, -1]) cylinder(h = height + 2, d = d);
    // Notches on the outside edge to tell the rings apart.
    for (i = [0 : notches - 1])
      rotate([0, 0, i * 12])
        translate([d / 2 + wall - 1.2, -1, height - 1.5]) cube([2, 2, 2]);
  }
}

for (i = [0 : len(holes) - 1])
  translate([i * (holes[i] + 2 * wall + gap), 0, 0]) ring(holes[i], i + 1);
