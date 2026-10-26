// Test rings to find the right hole size for the 45 mm pole.
// One 50 mm ring, flat (2 mm tall, 6 mm wall) so it grips the bed well.
// Print in PLA, 0.2 mm layers, no supports. Slide it onto the pole:
// it should slide on easily without wobbling.

holes  = [50.0];             // inner diameter, mm
wall   = 6;                  // ring wall thickness, mm
height = 2;                  // ring height, mm
gap    = 8;                  // space between rings, mm
$fn    = 180;

module ring(d, notches) {
  difference() {
    cylinder(h = height, d = d + 2 * wall);
    translate([0, 0, -1]) cylinder(h = height + 2, d = d);
    // Notches on the outside edge to tell the rings apart.
    for (i = [0 : notches - 1])
      rotate([0, 0, i * 12])
        translate([d / 2 + wall - 1.2, -1, -1]) cube([2, 2, height + 2]);
  }
}

for (i = [0 : len(holes) - 1])
  translate([i * (holes[i] + 2 * wall + gap), 0, 0]) ring(holes[i], i + 1);
