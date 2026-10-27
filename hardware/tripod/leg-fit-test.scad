// Fit test for the tripod leg tube (the legs are about 13 mm across).
// One flat plate with three holes: 13.6, 14.0 and 14.4 mm, marked with
// 1, 2 and 3 notches. Push the end of a leg into each hole: the right size
// slides on by hand without wobbling. Use that size as leg_hole in
// leg-joiner.scad and leg-foot.scad.
// Print in PLA, 0.2 mm layers, no supports.

holes  = [13.6, 14.0, 14.4];
plate  = [66, 26, 8];   // plate size, mm (big flat base so it sticks)
$fn    = 120;

difference() {
  translate([0, -plate[1] / 2, 0]) cube(plate);
  for (i = [0 : len(holes) - 1]) {
    translate([12 + i * 21, 0, -1]) cylinder(h = plate[2] + 2, d = holes[i]);
    // Notches on the front edge: 1, 2 or 3 to tell the holes apart.
    for (n = [0 : i])
      translate([12 + i * 21 - 4 + n * 3, -plate[1] / 2 - 1, plate[2] - 2])
        cube([1.5, 3, 3]);
  }
}
