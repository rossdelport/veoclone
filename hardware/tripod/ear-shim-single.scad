// One shim for a leg bolt (M6, 6.5 mm hole), 1 mm thick, 16 mm across,
// with a thin built-in brim so it grips the bed. Snap or trim the brim off.

hole        = 6.5;
od          = 16;
t           = 1.0;
brim        = 6;    // brim width around the shim
brim_height = 0.4;  // two layers
brim_gap    = 0.2;  // tiny gap so the brim snaps off cleanly
$fn = 96;

difference() {
  union() {
    cylinder(h = t, d = od);
    // Brim ring, joined to the shim only by its first layers.
    difference() {
      cylinder(h = brim_height, d = od + 2 * brim);
      translate([0, 0, -1]) cylinder(h = brim_height + 2, d = od + 2 * brim_gap);
    }
    // Four small tabs bridging shim and brim so the brim holds it down.
    for (a = [0, 90, 180, 270]) rotate([0, 0, a])
      translate([od / 2 - 1, -1, 0]) cube([brim_gap + 2, 2, brim_height]);
  }
  translate([0, 0, -1]) cylinder(h = t + 2, d = hole);
}
