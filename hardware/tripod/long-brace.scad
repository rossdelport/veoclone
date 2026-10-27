// Longer leg brace: replaces the 20 cm metal strips between the brace hub
// and each leg, to push the legs further out for the 6 m pole. Same idea as
// the metal ones (a flat strip with a bolt hole at each end), but thicker,
// with a stiffening rib along the outside so it doesn't bend.
// Laid corner to corner so it fits the 22 x 22 cm bed (longest that fits:
// about 27 cm hole to hole). Print 6: two per leg, rib facing up, PETG
// (PLA goes soft in hot sun), 4 walls, 40% infill, built-in brim.
// Fit with the flat side facing the hub arm / leg, rib on the outside.

hole_to_hole = 260;  // centre of one bolt hole to the other           <-- SET
width        = 14;   // strip width
plate        = 4;    // flat strip thickness
rib          = 6;    // extra height of the stiffening rib
rib_width    = 5;
rib_gap      = 16;   // rib stops this far from each hole (room for the bolt head)
hole         = 5.5;  // bolt holes (M5)

brim        = 6;
brim_height = 0.4;
$fn = 60;

module brace() {
  difference() {
    union() {
      hull() for (x = [0, hole_to_hole]) translate([x, 0, 0]) cylinder(h = plate, d = width);
      translate([rib_gap, -rib_width / 2, 0]) cube([hole_to_hole - 2 * rib_gap, rib_width, plate + rib]);
    }
    for (x = [0, hole_to_hole]) translate([x, 0, -1]) cylinder(h = plate + rib + 2, d = hole);
  }
}

// Corner to corner on the bed, centred.
rotate([0, 0, 45]) translate([-hole_to_hole / 2, 0, 0]) {
  brace();
  if (brim > 0)
    linear_extrude(height = brim_height)
      difference() {
        offset(r = brim) projection(cut = true) translate([0, 0, -0.1]) brace();
        for (x = [0, hole_to_hole]) translate([x, 0]) circle(d = hole);
      }
}
// Bed outline check (not printed): uncomment to see it on the 220 x 220 bed.
// %translate([-110, -110, -1]) cube([220, 220, 1]);
