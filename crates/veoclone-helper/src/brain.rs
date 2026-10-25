//! The tracking brain behind "Follow the ball" (DESIGN.md 4.13).
//!
//! Reco's ball mode follows whatever its `BallTracker` holds on to, frame by
//! frame: the first ball-like thing it sees at confidence 0.25 or more, then
//! the nearest one within 0.5 rad. A white spot on the grass that the AI
//! keeps "seeing" holds it for the rest of the match, it stands still while
//! the ball is lost, and it centres the ball at a fixed zoom, so a ball near
//! the camera fills the picture with grass. The brain works on the whole
//! match at once, from what the AI saw (crate::seen), so it can look both
//! ways in time:
//!
//! 1. **Sightings.** Every ball the AI found on the pitch (the pitch
//!    outline as Reco applies it), in world yaw/pitch (Reco's
//!    `camera_to_panorama`); two in the same frame closer than
//!    `same_spot_deg` count once.
//! 2. **Not the ball.** A spot seen for `static_secs` or longer without
//!    moving is not the ball in play (a mark or a light on the grass, a
//!    spare ball by the goal): all its sightings are dropped. When the real
//!    ball lies still for a free kick the camera frames the players around
//!    it instead, which shows the same.
//! 3. **One track.** The best single path through the remaining sightings,
//!    found by dynamic programming over time (like Viterbi): every sighting
//!    earns its confidence; going from one sighting to the next costs more
//!    the faster the ball would have had to move, and is impossible beyond
//!    the fastest kick at that distance (the distance comes from how tall
//!    the players look there); starting a new piece of track costs
//!    `new_track_cost`, so a lone flicker is never worth following. Gaps up
//!    to `gap_secs` inside a piece are filled in a straight line.
//! 4. **Where to look.** While the track has the ball the camera aims at it
//!    like a TV camera: the ball in the lower middle of the picture
//!    (`ball_height`), pulled towards the players around it so they are in
//!    the picture, never more than `grass_below` of the picture below the
//!    ball and those players; the zoom fits the players near the ball.
//!    Without the ball (longer than the gaps it fills) the camera follows the
//!    main group of players (Reco's density cluster), changing over
//!    `blend_secs`.
//! 5. **How it moves.** A dead zone (no twitching for small moves), a speed
//!    limit run forwards and backwards in time (so it starts early instead of
//!    catching up late), then a centred average over `smooth_secs`, twice:
//!    smooth starts and stops, with the acceleration bounded by
//!    `2 × top speed / smooth_secs`.
//!
//! The output is the AI camera path (`ai_path.bin`), world poses before the
//! editor's zoom and clamp, never wider than the widest view.

use reco_core::calibration::MatchCalibration;
use reco_core::detect::detector::{CameraId, Detection};
use reco_core::projection::CoverageBoundary;
use reco_core::render::scene::SceneGeometry;
use serde::{Deserialize, Serialize};

use crate::seen::{PitchFilter, RepanSettings, RepanStats, SeenMeta};

/// Changes whenever the brain decides differently (in the AI report).
pub const VERSION: u32 = 1;

/// The output picture's width / height (always 16:9, DESIGN.md 3).
const ASPECT: f32 = 16.0 / 9.0;
/// How tall a player looks when there is no one to measure (about 3.4°:
/// a player some 30 m away).
const DEFAULT_PLAYER_RAD: f32 = 0.06;
/// At most this many ball candidates per frame are considered.
const MAX_PER_FRAME: usize = 8;

/// The brain's knobs. Every field has a default; the dev tool
/// (`scripts/ai_report.py --set name=value`) changes them for tuning.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct BrainConfig {
    /// Ball detections below this confidence are not used (the recording
    /// keeps everything from 0.10).
    pub min_confidence: f32,
    /// Two sightings closer than this (degrees) are the same spot.
    pub same_spot_deg: f32,
    /// A spot seen this long (seconds) without moving is not the ball in
    /// play.
    pub static_secs: f32,
    /// The fastest the ball moves (m/s, a hard shot).
    pub max_ball_speed: f32,
    /// How tall a player is (m), to tell how far away something is.
    pub player_height: f32,
    /// Gaps between sightings up to this long (seconds) are filled in.
    pub gap_secs: f32,
    /// What a second of sightings at confidence 1 earns.
    pub reward_per_sec: f32,
    /// What starting a new piece of ball track costs.
    pub new_track_cost: f32,
    /// What moving from one sighting to the next costs per second, times
    /// (speed / fastest possible)².
    pub speed_cost: f32,
    /// The share of its reward a sighting earns with no player within
    /// `near_players_deg` (the ball is usually near someone).
    pub lonely_reward: f32,
    /// How far (degrees) a detection may be off on top of the fastest kick.
    pub noise_deg: f32,
    /// Where the ball sits in the picture, from the bottom (0..1).
    pub ball_height: f32,
    /// Keep the ball at least this far (degrees) inside the picture.
    pub ball_margin_deg: f32,
    /// How much the players around the ball pull the camera up or down
    /// (0: aim by the ball alone, 1: at the players' middle).
    pub player_pull: f32,
    /// Players this close to the ball (degrees) are "around the ball".
    pub near_players_deg: f32,
    /// At most this share of the picture is below the lowest of the ball
    /// and the players being filmed (grass).
    pub grass_below: f32,
    /// Reco's density cluster: players this close (degrees) are neighbours.
    pub cluster_bandwidth_deg: f32,
    /// Added to the players' middle when following the players (degrees;
    /// Reco's pitch bias).
    pub cluster_pitch_bias_deg: f32,
    /// The zoom range (vertical field of view, degrees); the widest view
    /// caps `fov_wide_deg`.
    pub fov_tight_deg: f32,
    pub fov_wide_deg: f32,
    /// The zoom when there are no players to fit.
    pub fov_default_deg: f32,
    /// Room (degrees) left beside the players the zoom fits.
    pub frame_margin_deg: f32,
    /// Switching between the ball and the players takes this long
    /// (seconds).
    pub blend_secs: f32,
    /// Centred averaging (seconds, applied twice) of the aim and the zoom.
    pub smooth_secs: f32,
    pub zoom_smooth_secs: f32,
    /// Top speeds (degrees per second).
    pub max_pan_deg_per_sec: f32,
    pub max_tilt_deg_per_sec: f32,
    pub max_zoom_deg_per_sec: f32,
    /// Moves smaller than these (degrees) are ignored.
    pub dead_zone_pan_deg: f32,
    pub dead_zone_tilt_deg: f32,
    pub dead_zone_zoom_deg: f32,
}

impl Default for BrainConfig {
    fn default() -> Self {
        BrainConfig {
            min_confidence: 0.10,
            same_spot_deg: 0.5,
            static_secs: 1.5,
            max_ball_speed: 30.0,
            player_height: 1.8,
            gap_secs: 2.5,
            reward_per_sec: 3.0,
            new_track_cost: 1.0,
            speed_cost: 2.0,
            lonely_reward: 0.5,
            noise_deg: 0.3,
            ball_height: 0.38,
            ball_margin_deg: 3.0,
            player_pull: 0.35,
            near_players_deg: 20.0,
            grass_below: 0.30,
            cluster_bandwidth_deg: 0.30f32.to_degrees(),
            cluster_pitch_bias_deg: 0.05f32.to_degrees(),
            fov_tight_deg: 22.0,
            fov_wide_deg: 58.0,
            fov_default_deg: 34.0,
            frame_margin_deg: 5.0,
            blend_secs: 1.0,
            smooth_secs: 1.0,
            zoom_smooth_secs: 2.0,
            max_pan_deg_per_sec: 35.0,
            max_tilt_deg_per_sec: 12.0,
            max_zoom_deg_per_sec: 6.0,
            dead_zone_pan_deg: 1.5,
            dead_zone_tilt_deg: 1.0,
            dead_zone_zoom_deg: 2.0,
        }
    }
}

impl BrainConfig {
    /// Refuse numbers the brain cannot work with (for the dev tool).
    pub fn check(&self) -> Result<(), String> {
        let v = serde_json::to_value(self).map_err(|e| e.to_string())?;
        for (name, value) in v.as_object().into_iter().flatten() {
            let x = value.as_f64().unwrap_or(f64::NAN);
            if !x.is_finite() || x < 0.0 {
                return Err(format!("{name} must be a number of 0 or more, not {value}"));
            }
        }
        let positive = [
            ("sameSpotDeg", self.same_spot_deg),
            ("maxBallSpeed", self.max_ball_speed),
            ("playerHeight", self.player_height),
            ("rewardPerSec", self.reward_per_sec),
            ("fovTightDeg", self.fov_tight_deg),
            ("maxPanDegPerSec", self.max_pan_deg_per_sec),
            ("maxTiltDegPerSec", self.max_tilt_deg_per_sec),
            ("maxZoomDegPerSec", self.max_zoom_deg_per_sec),
            ("clusterBandwidthDeg", self.cluster_bandwidth_deg),
        ];
        if let Some((name, _)) = positive.iter().find(|(_, x)| *x <= 0.0) {
            return Err(format!("{name} must be more than 0"));
        }
        if self.ball_height > 1.0 || self.player_pull > 1.0 || self.grass_below > 1.0 {
            return Err("ballHeight, playerPull and grassBelow are shares from 0 to 1".into());
        }
        if self.fov_tight_deg > self.fov_wide_deg || self.fov_wide_deg >= 170.0 {
            return Err("the zoom range must have fovTightDeg <= fovWideDeg < 170".into());
        }
        Ok(())
    }
}

/// A person the AI found on the pitch: where (world yaw/pitch of the box
/// centre, radians) and how sure.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Person {
    pub yaw: f32,
    pub pitch: f32,
    pub conf: f32,
}

/// A ball the AI found on the pitch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sighting {
    pub yaw: f32,
    pub pitch: f32,
    pub conf: f32,
}

/// What the AI found in one frame it looked at.
#[derive(Debug, Clone, Default)]
pub struct Look {
    pub persons: Vec<Person>,
    pub balls: Vec<Sighting>,
}

/// Everything the brain needs, in world space.
#[derive(Debug, Clone)]
pub struct Scene {
    pub fps: f32,
    /// Frames of the match.
    pub frames: usize,
    /// The AI looked at every `every`th frame: `looks[k]` is frame
    /// `k * every`.
    pub every: usize,
    pub looks: Vec<Look>,
    /// `(feet pitch, height)` in radians of some of the players: how tall
    /// people look at each distance.
    pub sizes: Vec<(f32, f32)>,
    /// The widest zoom allowed (the widest view's limit and the coverage's
    /// widest, degrees); `None`: only the config's own.
    pub fov_cap: Option<f32>,
    /// Where the cameras show something (the editor clamps to it too).
    pub coverage: Option<CoverageBoundary>,
}

/// How the AI's sightings of the ball turned out (kept with the AI run,
/// shown in the editor). Shares are of all the frames of the match, 0..1.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BallStats {
    pub frames: u64,
    /// Frames where the AI found anything it took for a ball on the pitch.
    pub detected: f32,
    /// Frames with a sighting on the ball track.
    pub seen: f32,
    /// Frames the ball track covers (sightings and the gaps filled in): a
    /// "Follow the ball" camera follows the ball here, the players elsewhere.
    pub followed: f32,
    /// Ball sightings looked at, and those dropped: spots that never moved,
    /// and the rest that were not on the track (jumps no ball can make,
    /// lone flickers).
    pub sightings: u64,
    pub rejected_static: u64,
    pub rejected_other: u64,
}

/// The brain's result.
#[derive(Debug, Clone)]
pub struct Plan {
    /// The AI camera path: `[yaw, pitch, fov]` per frame.
    pub path: Vec<[f32; 3]>,
    pub stats: BallStats,
    /// Per frame: the ball on the track (`None`: not on it), and how much
    /// the camera follows the ball rather than the players (0..1).
    pub ball: Vec<Option<[f32; 2]>>,
    pub weight: Vec<f32>,
}

// ---------------------------------------------------------------------------
// From the recording to world space
// ---------------------------------------------------------------------------

/// Turn a recording (crate::seen) into a [`Scene`]: the detection frames
/// `settings.every` asks for, on the pitch, in world yaw/pitch.
pub fn observe(
    cal: &MatchCalibration,
    meta: &SeenMeta,
    frames: &[Vec<Detection>],
    settings: &RepanSettings,
) -> Result<(Scene, RepanStats), String> {
    let n = meta.frames as usize;
    if settings.every == 0 || meta.every == 0 || !settings.every.is_multiple_of(meta.every) {
        return Err(format!(
            "recorded every {} frames, asked for every {}",
            meta.every, settings.every
        ));
    }
    if frames.len() < n.div_ceil(meta.every as usize) {
        return Err(format!(
            "recording has {} detection frames, {n} frames need {}",
            frames.len(),
            n.div_ceil(meta.every as usize)
        ));
    }
    let classes = meta.classes;
    let mut filter = PitchFilter::new(
        settings.roi.clone(),
        classes.roi_person,
        cal.left.width,
        cal.left.height,
    );
    let scene = SceneGeometry::from_layout_with_aspect(
        &cal.layout,
        cal.left.width as f32 / cal.left.height as f32,
    );
    let to_world = |camera: CameraId, x: f32, y: f32| {
        reco_core::projection::camera_to_panorama(camera, x, y, cal, &scene)
            .filter(|p| p.yaw.is_finite() && p.pitch.is_finite())
    };
    let every = settings.every as usize;
    let fps = if meta.fps.is_finite() && meta.fps > 0.0 {
        meta.fps
    } else {
        30.0
    };
    // Measure the players' size about twice a second.
    let size_every = ((fps / every as f32 / 2.0).round() as usize).max(1);
    let mut stats = RepanStats::default();
    let mut looks = Vec::with_capacity(n.div_ceil(every));
    let mut sizes = Vec::new();
    for (k, i) in (0..n).step_by(every).enumerate() {
        let raw = &frames[i / meta.every as usize];
        stats.seen += raw.len() as u64;
        let found = filter.apply(raw.clone())?;
        stats.outside_pitch += raw.len() as u64 - found.len() as u64;
        stats.kept += found.len() as u64;
        let mut look = Look::default();
        for d in &found {
            if d.class_id == classes.ball {
                if let Some(p) = to_world(d.camera, d.center_x, d.center_y) {
                    look.balls.push(Sighting {
                        yaw: p.yaw,
                        pitch: p.pitch,
                        conf: d.confidence,
                    });
                }
            } else if Some(d.class_id) == classes.person
                && let Some(p) = to_world(d.camera, d.center_x, d.center_y)
            {
                look.persons.push(Person {
                    yaw: p.yaw,
                    pitch: p.pitch,
                    conf: d.confidence,
                });
                if k.is_multiple_of(size_every)
                    && let Some(feet) = to_world(d.camera, d.center_x, d.center_y + d.height / 2.0)
                {
                    let tall = 2.0 * (p.pitch - feet.pitch);
                    if tall > 0.0 && tall < 1.0 {
                        sizes.push((feet.pitch, tall));
                    }
                }
            }
        }
        looks.push(look);
    }
    let aspect = cal.left.width as f32 / cal.left.height as f32;
    let coverage = CoverageBoundary::from_calibration(
        cal,
        &SceneGeometry::from_layout_with_aspect(&cal.layout, aspect),
    );
    let cap = settings
        .widest
        .max_fov_deg()
        .map_or(coverage.max_fov_degrees(), |w| {
            w.min(coverage.max_fov_degrees())
        });
    Ok((
        Scene {
            fps,
            frames: n,
            every,
            looks,
            sizes,
            fov_cap: Some(cap),
            coverage: Some(coverage),
        },
        stats,
    ))
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/// The angle between two directions given as yaw/pitch (radians), close
/// enough for the small angles between things on one pitch.
fn angle(a: (f32, f32), b: (f32, f32)) -> f32 {
    let dy = (a.0 - b.0) * (0.5 * (a.1 + b.1)).cos();
    let dp = a.1 - b.1;
    (dy * dy + dp * dp).sqrt()
}

/// The vertical field of view (radians) whose picture is `half_width`
/// (radians) wide on each side of its centre.
fn vfov_for_half_width(half_width: f32) -> f32 {
    2.0 * (half_width.min(1.5).tan() / ASPECT).atan()
}

/// The `q` quantile (0..1) of `v` (sorted in place); 0 when empty.
fn quantile(v: &mut [f32], q: f32) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[((v.len() - 1) as f32 * q).round() as usize]
}

/// How tall a player looks (radians) with their feet at a pitch: a straight
/// line fitted to the median per degree of pitch (farther away is higher
/// up and smaller), kept within the sizes measured.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Heights {
    a: f32,
    b: f32,
    lo: f32,
    hi: f32,
}

impl Heights {
    fn fit(sizes: &[(f32, f32)]) -> Heights {
        let constant = |h: f32| Heights {
            a: h,
            b: 0.0,
            lo: h,
            hi: h,
        };
        if sizes.len() < 20 {
            return constant(DEFAULT_PLAYER_RAD);
        }
        let bin = 1f32.to_radians();
        let mut bins: std::collections::BTreeMap<i32, Vec<(f32, f32)>> = Default::default();
        for &(p, h) in sizes {
            if p.is_finite() && h.is_finite() {
                bins.entry((p / bin).floor() as i32)
                    .or_default()
                    .push((p, h));
            }
        }
        // Per degree of pitch: the mean pitch, the median height, how many.
        let rows: Vec<(f32, f32, f32)> = bins
            .into_values()
            .filter(|v| v.len() >= 3)
            .map(|v| {
                let mean = v.iter().map(|s| s.0).sum::<f32>() / v.len() as f32;
                let mut h: Vec<f32> = v.iter().map(|s| s.1).collect();
                (mean, quantile(&mut h, 0.5), v.len() as f32)
            })
            .collect();
        let mut all: Vec<f32> = sizes.iter().map(|s| s.1).collect();
        let median = quantile(&mut all, 0.5);
        if rows.len() < 2 {
            return constant(median);
        }
        let w: f32 = rows.iter().map(|r| r.2).sum();
        let mx = rows.iter().map(|r| r.0 * r.2).sum::<f32>() / w;
        let my = rows.iter().map(|r| r.1 * r.2).sum::<f32>() / w;
        let sxx: f32 = rows.iter().map(|r| r.2 * (r.0 - mx).powi(2)).sum();
        let sxy: f32 = rows.iter().map(|r| r.2 * (r.0 - mx) * (r.1 - my)).sum();
        let lo = rows.iter().map(|r| r.1).fold(f32::INFINITY, f32::min);
        let hi = rows.iter().map(|r| r.1).fold(0.0, f32::max);
        let b = if sxx > 0.0 { sxy / sxx } else { 0.0 };
        if !b.is_finite() || b >= 0.0 {
            return constant(median);
        }
        Heights {
            a: my - b * mx,
            b,
            lo: lo * 0.7,
            hi: hi * 1.3,
        }
    }

    fn at(&self, pitch: f32) -> f32 {
        (self.a + self.b * pitch).clamp(self.lo, self.hi)
    }
}

// ---------------------------------------------------------------------------
// The ball track
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Fate {
    Unused,
    Static,
    Track,
}

#[derive(Debug, Clone, Copy)]
struct Node {
    /// The look (detection frame) it was seen in.
    k: usize,
    yaw: f32,
    pitch: f32,
    reward: f64,
    /// The fastest the ball can move here (radians per second).
    omega: f32,
    fate: Fate,
}

/// The ball candidates of every look: confident enough, one per spot, the
/// most confident first; `starts[k]..starts[k + 1]` are look `k`'s.
fn candidates(scene: &Scene, cfg: &BrainConfig, heights: &Heights) -> (Vec<Node>, Vec<usize>) {
    let spot = cfg.same_spot_deg.to_radians();
    let near = cfg.near_players_deg.to_radians();
    let secs_per_look = scene.every as f32 / scene.fps;
    let mut nodes = Vec::new();
    let mut starts = Vec::with_capacity(scene.looks.len() + 1);
    for (k, look) in scene.looks.iter().enumerate() {
        starts.push(nodes.len());
        let mut balls: Vec<&Sighting> = look
            .balls
            .iter()
            .filter(|b| b.conf >= cfg.min_confidence && b.yaw.is_finite() && b.pitch.is_finite())
            .collect();
        balls.sort_by(|a, b| b.conf.total_cmp(&a.conf));
        let first = nodes.len();
        for b in balls {
            let here = (b.yaw, b.pitch);
            let taken = nodes[first..]
                .iter()
                .any(|n: &Node| angle((n.yaw, n.pitch), here) < spot);
            if taken || nodes.len() - first >= MAX_PER_FRAME {
                continue;
            }
            let lonely = !look
                .persons
                .iter()
                .any(|p| angle((p.yaw, p.pitch), here) <= near);
            let share = if lonely { cfg.lonely_reward } else { 1.0 };
            nodes.push(Node {
                k,
                yaw: b.yaw,
                pitch: b.pitch,
                reward: (b.conf * cfg.reward_per_sec * secs_per_look * share) as f64,
                omega: cfg.max_ball_speed * heights.at(b.pitch) / cfg.player_height,
                fate: Fate::Unused,
            });
        }
    }
    starts.push(nodes.len());
    (nodes, starts)
}

/// Mark the sightings of spots seen for `static_secs` or longer without
/// moving (sightings at most `gap_secs` apart count as one stay) while little
/// else was seen around them: a ball moving about in a small space (shielded
/// at a player's feet) comes back to the same spots too, but is seen all
/// around them.
fn mark_static(nodes: &mut [Node], starts: &[usize], scene: &Scene, cfg: &BrainConfig) {
    struct Stay {
        yaw: f32,
        pitch: f32,
        first: usize,
        last: usize,
        members: Vec<usize>,
    }
    let spot = cfg.same_spot_deg.to_radians();
    let looks_per_sec = scene.fps / scene.every as f32;
    let gap = (cfg.gap_secs * looks_per_sec).ceil() as usize;
    let cell = |yaw: f32, pitch: f32| ((yaw / spot).floor() as i64, (pitch / spot).floor() as i64);
    let mut grid: std::collections::HashMap<(i64, i64), Vec<usize>> = Default::default();
    let mut stays: Vec<Stay> = Vec::new();
    for (i, n) in nodes.iter().enumerate() {
        let (cx, cy) = cell(n.yaw, n.pitch);
        let mut found: Option<(usize, f32)> = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for &s in grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    let st = &stays[s];
                    let d = angle((st.yaw, st.pitch), (n.yaw, n.pitch));
                    if st.last + gap >= n.k
                        && st.last < n.k
                        && d < spot
                        && found.is_none_or(|(_, best)| d < best)
                    {
                        found = Some((s, d));
                    }
                }
            }
        }
        match found {
            Some((s, _)) => {
                stays[s].last = n.k;
                stays[s].members.push(i);
            }
            None => {
                grid.entry((cx, cy)).or_default().push(stays.len());
                stays.push(Stay {
                    yaw: n.yaw,
                    pitch: n.pitch,
                    first: n.k,
                    last: n.k,
                    members: vec![i],
                });
            }
        }
    }
    let around = 4.0 * spot;
    for st in stays {
        if ((st.last - st.first) as f32) < cfg.static_secs * looks_per_sec {
            continue;
        }
        let others = (starts[st.first]..starts[st.last + 1])
            .filter(|i| st.members.binary_search(i).is_err())
            .filter(|&i| angle((st.yaw, st.pitch), (nodes[i].yaw, nodes[i].pitch)) < around)
            .count();
        if others <= st.members.len() {
            for i in st.members {
                nodes[i].fate = Fate::Static;
            }
        }
    }
}

/// The best single ball track (dynamic programming over the looks, see the
/// module docs): the pieces of track, each a list of node indices in time
/// order. Marks their nodes as [`Fate::Track`].
fn best_track(
    nodes: &mut [Node],
    starts: &[usize],
    scene: &Scene,
    cfg: &BrainConfig,
) -> Vec<Vec<usize>> {
    #[derive(Clone, Copy)]
    enum Prev {
        /// Starts a piece; the best track before it ends at this node.
        Start(Option<usize>),
        Link(usize),
    }
    let looks = starts.len() - 1;
    let secs_per_look = scene.every as f64 / scene.fps as f64;
    let gap = (cfg.gap_secs as f64 / secs_per_look).ceil() as usize;
    let noise = cfg.noise_deg.to_radians();
    let mut best = vec![f64::NEG_INFINITY; nodes.len()];
    let mut prev = vec![Prev::Start(None); nodes.len()];
    // until[k]: the best score of a track ending before look k, and where.
    let mut until = vec![0.0f64; looks + 1];
    let mut until_at: Vec<Option<usize>> = vec![None; looks + 1];
    for k in 0..looks {
        for j in starts[k]..starts[k + 1] {
            if nodes[j].fate == Fate::Static {
                continue;
            }
            let mut score = until[k] - cfg.new_track_cost as f64;
            let mut from = Prev::Start(until_at[k]);
            for i in starts[k.saturating_sub(gap)]..starts[k] {
                if best[i] == f64::NEG_INFINITY {
                    continue;
                }
                let (a, b) = (&nodes[i], &nodes[j]);
                let dt = (b.k - a.k) as f64 * secs_per_look;
                let d = (angle((a.yaw, a.pitch), (b.yaw, b.pitch)) - noise).max(0.0) as f64;
                let speed = d / dt / a.omega.max(b.omega) as f64;
                if speed > 1.0 {
                    continue;
                }
                let s = best[i] - cfg.speed_cost as f64 * speed * speed * dt;
                if s > score {
                    score = s;
                    from = Prev::Link(i);
                }
            }
            best[j] = score + nodes[j].reward;
            prev[j] = from;
        }
        until[k + 1] = until[k];
        until_at[k + 1] = until_at[k];
        for (j, &b) in best.iter().enumerate().take(starts[k + 1]).skip(starts[k]) {
            if b > until[k + 1] {
                until[k + 1] = b;
                until_at[k + 1] = Some(j);
            }
        }
    }
    // Back from the best end.
    let mut pieces: Vec<Vec<usize>> = Vec::new();
    let mut piece = Vec::new();
    let mut at = until_at[looks];
    while let Some(j) = at {
        nodes[j].fate = Fate::Track;
        piece.push(j);
        at = match prev[j] {
            Prev::Link(i) => Some(i),
            Prev::Start(before) => {
                piece.reverse();
                pieces.push(std::mem::take(&mut piece));
                before
            }
        };
    }
    pieces.reverse();
    pieces
}

// ---------------------------------------------------------------------------
// Where to look
// ---------------------------------------------------------------------------

/// Reco's density cluster (`FieldPanner::densest_cluster`, private there):
/// the players within the bandwidth of the player with the most neighbours.
fn densest(persons: &[Person], bandwidth: f32) -> Vec<&Person> {
    let close = |a: &Person, b: &Person| angle((a.yaw, a.pitch), (b.yaw, b.pitch)) <= bandwidth;
    let Some(center) = persons
        .iter()
        .max_by_key(|c| persons.iter().filter(|p| close(c, p)).count())
    else {
        return Vec::new();
    };
    persons.iter().filter(|p| close(center, p)).collect()
}

struct Framer<'a> {
    cfg: &'a BrainConfig,
    heights: Heights,
    tight: f32,
    wide: f32,
}

impl Framer<'_> {
    /// The zoom (vertical fov, radians) that shows the players within the
    /// usual spread around `yaw`, with room beside them.
    fn zoom_for(&self, yaw: f32, players: &[&Person]) -> f32 {
        if players.len() < 2 {
            return self
                .cfg
                .fov_default_deg
                .to_radians()
                .clamp(self.tight, self.wide);
        }
        let mut side: Vec<f32> = players
            .iter()
            .map(|p| ((p.yaw - yaw) * p.pitch.cos()).abs())
            .collect();
        let half = quantile(&mut side, 0.75) + self.cfg.frame_margin_deg.to_radians();
        vfov_for_half_width(half).clamp(self.tight, self.wide)
    }

    /// Never more than `grass_below` of the picture below the lowest of
    /// `lowest` (the ball, the players' feet).
    fn above_grass(&self, aim: f32, fov: f32, lowest: f32) -> f32 {
        aim.max(lowest + fov / 2.0 - self.cfg.grass_below * fov)
    }

    /// Film the ball like a TV camera: `[yaw, pitch, fov]`, radians.
    fn ball(&self, ball: [f32; 2], persons: &[Person]) -> [f32; 3] {
        let near: Vec<&Person> = persons
            .iter()
            .filter(|p| {
                angle((p.yaw, p.pitch), (ball[0], ball[1]))
                    <= self.cfg.near_players_deg.to_radians()
            })
            .collect();
        let fov = self.zoom_for(ball[0], &near);
        // The ball `ball_height` up from the bottom of the picture.
        let below = ((1.0 - 2.0 * self.cfg.ball_height) * (fov / 2.0).tan()).atan();
        let mut aim = ball[1] + below;
        let mut lowest = ball[1];
        if !near.is_empty() {
            let middle = near.iter().map(|p| p.pitch).sum::<f32>() / near.len() as f32;
            aim += self.cfg.player_pull * (middle - aim);
            for p in &near {
                lowest = lowest.min(p.pitch - self.heights.at(p.pitch) / 2.0);
            }
        }
        aim = self.above_grass(aim, fov, lowest);
        // The ball stays in the picture.
        let room = (fov / 2.0 - self.cfg.ball_margin_deg.to_radians()).max(fov * 0.1);
        [ball[0], aim.clamp(ball[1] - room, ball[1] + room), fov]
    }

    /// Film the main group of players, or `None` with fewer than two.
    fn players(&self, persons: &[Person]) -> Option<[f32; 3]> {
        let group = densest(persons, self.cfg.cluster_bandwidth_deg.to_radians());
        if group.len() < 2 {
            return None;
        }
        let total: f32 = group.iter().map(|p| p.conf.max(1e-3)).sum();
        let yaw = group.iter().map(|p| p.yaw * p.conf.max(1e-3)).sum::<f32>() / total;
        let pitch = group
            .iter()
            .map(|p| p.pitch * p.conf.max(1e-3))
            .sum::<f32>()
            / total;
        let fov = self.zoom_for(yaw, &group);
        let lowest = group
            .iter()
            .map(|p| p.pitch - self.heights.at(p.pitch) / 2.0)
            .fold(f32::INFINITY, f32::min);
        let aim = pitch + self.cfg.cluster_pitch_bias_deg.to_radians();
        Some([yaw, self.above_grass(aim, fov, lowest), fov])
    }
}

// ---------------------------------------------------------------------------
// How it moves
// ---------------------------------------------------------------------------

/// Centred average over `2 * half + 1` samples, the ends repeated (so the
/// speed and acceleration bounds hold at the ends too).
fn average(x: &[f32], half: usize) -> Vec<f32> {
    let n = x.len();
    if n == 0 || half == 0 {
        return x.to_vec();
    }
    let at = |i: isize| x[i.clamp(0, n as isize - 1) as usize] as f64;
    let w = (2 * half + 1) as f64;
    let mut sum: f64 = (-(half as isize)..=half as isize).map(at).sum();
    let mut out = Vec::with_capacity(n);
    for i in 0..n as isize {
        out.push((sum / w) as f32);
        sum += at(i + half as isize + 1) - at(i - half as isize);
    }
    out
}

/// A dead zone that neither lags nor leads: the average of one run forwards
/// and one backwards, each moving only when the target is more than `dz`
/// away.
fn dead_zone(x: &[f32], dz: f32) -> Vec<f32> {
    let pass = |order: &mut dyn Iterator<Item = usize>| {
        let mut out = vec![0.0f32; x.len()];
        let mut y: Option<f32> = None;
        for i in order {
            let t = x[i];
            let v = match y {
                None => t,
                Some(y) if t > y + dz => t - dz,
                Some(y) if t < y - dz => t + dz,
                Some(y) => y,
            };
            out[i] = v;
            y = Some(v);
        }
        out
    };
    let fwd = pass(&mut (0..x.len()));
    let bwd = pass(&mut (0..x.len()).rev());
    fwd.iter().zip(&bwd).map(|(a, b)| 0.5 * (a + b)).collect()
}

/// At most `step` per frame, run forwards (late) and backwards (early) and
/// averaged, so a big move starts before and ends after the target's.
fn speed_limit(x: &[f32], step: f32) -> Vec<f32> {
    let pass = |order: &mut dyn Iterator<Item = usize>| {
        let mut out = vec![0.0f32; x.len()];
        let mut y: Option<f32> = None;
        for i in order {
            let v = match y {
                None => x[i],
                Some(y) => y + (x[i] - y).clamp(-step, step),
            };
            out[i] = v;
            y = Some(v);
        }
        out
    };
    let fwd = pass(&mut (0..x.len()));
    let bwd = pass(&mut (0..x.len()).rev());
    fwd.iter().zip(&bwd).map(|(a, b)| 0.5 * (a + b)).collect()
}

/// Dead zone, speed limit, then the centred average twice.
fn smooth(x: &[f32], dz: f32, max_per_sec: f32, secs: f32, fps: f32) -> Vec<f32> {
    let half = ((secs * fps) / 2.0).round() as usize;
    let limited = speed_limit(&dead_zone(x, dz), max_per_sec / fps);
    average(&average(&limited, half), half)
}

// ---------------------------------------------------------------------------
// The whole match
// ---------------------------------------------------------------------------

/// Plan the camera for the whole match.
pub fn plan(scene: &Scene, cfg: &BrainConfig) -> Plan {
    let n = scene.frames;
    let every = scene.every.max(1);
    let fps = scene.fps;
    let heights = Heights::fit(&scene.sizes);

    // 1-3. The ball track.
    let (mut nodes, starts) = candidates(scene, cfg, &heights);
    mark_static(&mut nodes, &starts, scene, cfg);
    let pieces = best_track(&mut nodes, &starts, scene, cfg);

    let mut ball: Vec<Option<[f32; 2]>> = vec![None; n];
    // Where the ball was last / will next be, for the change-over.
    let mut held: Vec<[f32; 2]> = vec![[0.0, 0.0]; n];
    let mut ends: Vec<(usize, usize)> = Vec::new();
    for piece in &pieces {
        for pair in piece.windows(2) {
            let (a, b) = (&nodes[pair[0]], &nodes[pair[1]]);
            let (fa, fb) = (a.k * every, b.k * every);
            for (f, slot) in ball.iter_mut().enumerate().take(fb.min(n)).skip(fa) {
                let t = (f - fa) as f32 / (fb - fa) as f32;
                *slot = Some([
                    a.yaw + t * (b.yaw - a.yaw),
                    a.pitch + t * (b.pitch - a.pitch),
                ]);
            }
        }
        let last = &nodes[*piece.last().expect("pieces are not empty")];
        for slot in ball
            .iter_mut()
            .take(((last.k + 1) * every).min(n))
            .skip(last.k * every)
        {
            *slot = Some([last.yaw, last.pitch]);
        }
        let first = nodes[piece[0]].k * every;
        ends.push((first.min(n), ((last.k + 1) * every).min(n)));
    }
    if let (Some(&(first, _)), Some(piece)) = (ends.first(), pieces.first()) {
        let n0 = &nodes[piece[0]];
        for h in held.iter_mut().take(first) {
            *h = [n0.yaw, n0.pitch];
        }
    }
    for (e, &(first, end)) in ends.iter().enumerate() {
        for f in first..end {
            held[f] = ball[f].unwrap_or(held[f]);
        }
        // Up to halfway to the next piece: where this one ended; then where
        // the next one starts.
        let next = ends.get(e + 1).map_or(n, |x| x.0);
        let mid = if e + 1 < ends.len() {
            end + (next - end) / 2
        } else {
            n
        };
        let last = ball[end.saturating_sub(1)].unwrap_or([0.0, 0.0]);
        for h in held.iter_mut().take(mid).skip(end) {
            *h = last;
        }
        if let Some(p) = pieces.get(e + 1) {
            let s = &nodes[p[0]];
            for h in held.iter_mut().take(next).skip(mid) {
                *h = [s.yaw, s.pitch];
            }
        }
    }

    // 4. Where to look: the ball, the players, and the change-over.
    let wide = cfg
        .fov_wide_deg
        .min(scene.fov_cap.unwrap_or(f32::INFINITY))
        .max(1.0)
        .to_radians();
    let framer = Framer {
        cfg,
        heights,
        tight: cfg.fov_tight_deg.to_radians().min(wide),
        wide,
    };
    let following: Vec<f32> = ball.iter().map(|b| f32::from(b.is_some())).collect();
    let weight = average(&following, ((cfg.blend_secs * fps) / 2.0).round() as usize);
    let mut players: Vec<Option<[f32; 3]>> = scene
        .looks
        .iter()
        .map(|l| framer.players(&l.persons))
        .collect();
    // Without a group, hold the last one (or the first one at the start).
    let first_group = players.iter().flatten().next().copied();
    let mut last = first_group;
    for p in players.iter_mut() {
        match p {
            Some(_) => last = *p,
            None => *p = last,
        }
    }
    let empty = Look::default();
    let mut target = [vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]];
    for f in 0..n {
        let k = (f / every).min(scene.looks.len().saturating_sub(1));
        let look = scene.looks.get(k).unwrap_or(&empty);
        let w = weight[f];
        let group = players.get(k).copied().flatten();
        let shot = match group {
            Some(g) if w <= 0.0 => g,
            _ if pieces.is_empty() => group.unwrap_or([
                0.0,
                0.0,
                cfg.fov_default_deg.to_radians().clamp(framer.tight, wide),
            ]),
            _ => {
                let b = framer.ball(held[f], &look.persons);
                match group {
                    Some(g) => std::array::from_fn(|c| w * b[c] + (1.0 - w) * g[c]),
                    None => b,
                }
            }
        };
        let mut fov = shot[2].to_degrees();
        let (mut yaw, mut pitch) = (shot[0], shot[1]);
        if let Some(cov) = &scene.coverage {
            fov = fov.min(cov.max_fov_degrees());
            let c = cov.safe_clamp(yaw, pitch, fov, ASPECT, 0.0);
            (yaw, pitch) = (c.yaw, c.pitch);
        }
        target[0][f] = yaw;
        target[1][f] = pitch;
        target[2][f] = fov;
    }

    // 5. How it moves.
    let yaw = smooth(
        &target[0],
        cfg.dead_zone_pan_deg.to_radians(),
        cfg.max_pan_deg_per_sec.to_radians(),
        cfg.smooth_secs,
        fps,
    );
    let pitch = smooth(
        &target[1],
        cfg.dead_zone_tilt_deg.to_radians(),
        cfg.max_tilt_deg_per_sec.to_radians(),
        cfg.smooth_secs,
        fps,
    );
    let fov = smooth(
        &target[2],
        cfg.dead_zone_zoom_deg,
        cfg.max_zoom_deg_per_sec,
        cfg.zoom_smooth_secs,
        fps,
    );
    let path = (0..n).map(|f| [yaw[f], pitch[f], fov[f]]).collect();

    // What happened to the sightings.
    let frames_of = |k: usize| (n.saturating_sub(k * every)).min(every) as u64;
    let share = |count: u64| if n > 0 { count as f32 / n as f32 } else { 0.0 };
    let detected: u64 = scene
        .looks
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.balls.is_empty())
        .map(|(k, _)| frames_of(k))
        .sum();
    let mut seen_looks: Vec<usize> = nodes
        .iter()
        .filter(|x| x.fate == Fate::Track)
        .map(|x| x.k)
        .collect();
    seen_looks.dedup();
    let rejected_static = nodes.iter().filter(|x| x.fate == Fate::Static).count() as u64;
    let on_track = nodes.iter().filter(|x| x.fate == Fate::Track).count() as u64;
    let stats = BallStats {
        frames: n as u64,
        detected: share(detected),
        seen: share(seen_looks.iter().map(|&k| frames_of(k)).sum()),
        followed: share(ball.iter().filter(|b| b.is_some()).count() as u64),
        sightings: nodes.len() as u64,
        rejected_static,
        rejected_other: nodes.len() as u64 - rejected_static - on_track,
    };
    Plan {
        path,
        stats,
        ball,
        weight,
    }
}

/// The "Follow the ball" path from a recording, as the helper's AI step
/// makes it (a quick re-run, or right after the AI pass).
pub fn follow(
    cal: &MatchCalibration,
    meta: &SeenMeta,
    frames: &[Vec<Detection>],
    settings: &RepanSettings,
    cfg: &BrainConfig,
) -> Result<(Plan, RepanStats), String> {
    let (scene, stats) = observe(cal, meta, frames, settings)?;
    Ok((plan(&scene, cfg), stats))
}

/// The sentence for the job log.
pub fn describe(stats: &BallStats) -> String {
    let pct = |x: f32| (x * 100.0).round();
    format!(
        "Ball: the AI found something like a ball in {}% of the frames; {}% have a sighting on \
         the ball track, which covers {}% of the match (short gaps filled in); of {} sightings \
         {} stayed on one spot and {} were off the track",
        pct(stats.detected),
        pct(stats.seen),
        pct(stats.followed),
        stats.sightings,
        stats.rejected_static,
        stats.rejected_other
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const FPS: f32 = 30.0;

    /// A synthetic match in world space: `frames` frames, the AI looked at
    /// every frame, a group of players and whatever `balls` says.
    fn scene(
        frames: usize,
        players: impl Fn(usize) -> Vec<Person>,
        balls: impl Fn(usize) -> Vec<Sighting>,
    ) -> Scene {
        let looks: Vec<Look> = (0..frames)
            .map(|f| Look {
                persons: players(f),
                balls: balls(f),
            })
            .collect();
        // Players look 4° tall at pitch -0.1, 2.5° at 0.1 (farther).
        let sizes = (0..200)
            .map(|i| {
                let p = -0.15 + 0.3 * (i as f32 / 199.0);
                (p, (3.25 - 7.5 * p).to_radians())
            })
            .collect();
        Scene {
            fps: FPS,
            frames,
            every: 1,
            looks,
            sizes,
            fov_cap: Some(34.0),
            coverage: None,
        }
    }

    fn person(yaw: f32, pitch: f32) -> Person {
        Person {
            yaw,
            pitch,
            conf: 0.7,
        }
    }

    fn ball(yaw: f32, pitch: f32, conf: f32) -> Sighting {
        Sighting { yaw, pitch, conf }
    }

    /// Ten players around `(yaw, pitch)`.
    fn group(yaw: f32, pitch: f32) -> Vec<Person> {
        (0..10)
            .map(|i| {
                let a = i as f32 * 0.7;
                person(yaw + 0.12 * a.sin(), pitch + 0.03 * a.cos())
            })
            .collect()
    }

    /// The real ball: across the pitch and back in 20 s, a little up and
    /// down; players follow it loosely.
    fn true_ball(f: usize) -> [f32; 2] {
        let t = f as f32 / FPS;
        [
            0.6 * (t * std::f32::consts::TAU / 20.0).cos(),
            -0.02 + 0.03 * (t * 0.9).sin(),
        ]
    }

    fn ball_error_deg(path: &[[f32; 3]], truth: impl Fn(usize) -> [f32; 2]) -> Vec<f32> {
        path.iter()
            .enumerate()
            .map(|(f, p)| (p[0] - truth(f)[0]).abs().to_degrees())
            .collect()
    }

    /// The share of frames whose picture shows the ball (with a margin).
    fn in_picture(path: &[[f32; 3]], truth: impl Fn(usize) -> [f32; 2]) -> f32 {
        let inside = path
            .iter()
            .enumerate()
            .filter(|(f, p)| {
                let b = truth(*f);
                let v = p[2].to_radians() / 2.0;
                let h = (ASPECT * v.tan()).atan();
                (b[0] - p[0]).abs() < h * 0.9 && (b[1] - p[1]).abs() < v * 0.9
            })
            .count();
        inside as f32 / path.len() as f32
    }

    fn max_accel(path: &[[f32; 3]], c: usize) -> f32 {
        path.windows(3)
            .map(|w| (w[2][c] - 2.0 * w[1][c] + w[0][c]).abs() * FPS * FPS)
            .fold(0.0, f32::max)
    }

    #[test]
    fn follows_the_moving_ball_not_the_static_one() {
        // A false "ball" on the grass near the camera in every frame, more
        // confident than the real one.
        let s = scene(
            600,
            |f| group(true_ball(f)[0] * 0.8, 0.0),
            |f| {
                let b = true_ball(f);
                let mut v = vec![ball(-0.35, -0.25, 0.6)];
                if f % 3 != 0 {
                    v.push(ball(b[0], b[1], 0.4));
                }
                v
            },
        );
        let out = plan(&s, &BrainConfig::default());
        let err = ball_error_deg(&out.path, true_ball);
        let mean = err.iter().sum::<f32>() / err.len() as f32;
        assert!(mean < 4.0, "mean yaw error {mean:.1} deg");
        assert!(in_picture(&out.path, true_ball) > 0.97);
        // Never staring at the static spot.
        let stare = out
            .path
            .iter()
            .filter(|p| (p[0] + 0.35).abs() < 0.05 && (p[1] + 0.25).abs() < 0.1)
            .count();
        let ball_there = (0..600)
            .filter(|&f| (true_ball(f)[0] + 0.35).abs() < 0.05)
            .count();
        assert!(stare <= ball_there, "{stare} frames on the static spot");
        assert_eq!(out.stats.rejected_static, 600);
        assert!(out.stats.followed > 0.99, "{:?}", out.stats);
        assert!((out.stats.detected - 1.0).abs() < 1e-6);
        assert!(
            (out.stats.seen - 400.0 / 600.0).abs() < 0.01,
            "{:?}",
            out.stats
        );
    }

    #[test]
    fn long_gaps_fall_back_to_the_players_and_return() {
        // The ball is seen for 6 s, lost for 8 s (the players are at the
        // other end meanwhile), then seen again.
        let lost = |f: usize| (180..420).contains(&f);
        let players_at = |f: usize| if lost(f) { -0.5 } else { true_ball(f)[0] };
        let s = scene(
            600,
            |f| group(players_at(f), 0.0),
            |f| {
                let b = true_ball(f);
                if lost(f) {
                    vec![]
                } else {
                    vec![ball(b[0], b[1], 0.5)]
                }
            },
        );
        let out = plan(&s, &BrainConfig::default());
        // In the middle of the gap the camera is on the players.
        for f in 260..340 {
            assert!(
                (out.path[f][0] + 0.5).abs() < 0.06,
                "frame {f}: {:?}",
                out.path[f]
            );
            assert_eq!(out.ball[f], None);
            assert_eq!(out.weight[f], 0.0);
        }
        // Back on the ball soon after it reappears.
        for f in 480..600 {
            assert!((out.path[f][0] - true_ball(f)[0]).abs() < 0.08, "frame {f}");
        }
        assert!((out.stats.followed - 0.6).abs() < 0.01, "{:?}", out.stats);
        // A short gap is filled in.
        let s = scene(
            600,
            |f| group(true_ball(f)[0], 0.0),
            |f| {
                let b = true_ball(f);
                if (200..260).contains(&f) {
                    vec![]
                } else {
                    vec![ball(b[0], b[1], 0.5)]
                }
            },
        );
        let out = plan(&s, &BrainConfig::default());
        assert!(out.ball[230].is_some());
        assert!((out.stats.followed - 1.0).abs() < 1e-6, "{:?}", out.stats);
    }

    #[test]
    fn noisy_false_positives_are_ignored() {
        // Every 4th frame a confident "ball" somewhere random on the pitch.
        let mut seed = 12345u32;
        let mut rnd = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1u32 << 24) as f32
        };
        let noise: Vec<Option<Sighting>> = (0..600)
            .map(|f| (f % 4 == 1).then(|| ball(-0.9 + 1.8 * rnd(), -0.2 + 0.3 * rnd(), 0.7)))
            .collect();
        let s = scene(
            600,
            |f| group(true_ball(f)[0], 0.0),
            |f| {
                let b = true_ball(f);
                let mut v: Vec<Sighting> = noise[f].into_iter().collect();
                if f % 2 == 0 {
                    v.push(ball(b[0], b[1], 0.3));
                }
                v
            },
        );
        let out = plan(&s, &BrainConfig::default());
        let err = ball_error_deg(&out.path, true_ball);
        let worst = err.iter().fold(0.0f32, |a, &b| a.max(b));
        assert!(worst < 8.0, "worst yaw error {worst:.1} deg");
        assert!(in_picture(&out.path, true_ball) > 0.98);
        assert!(out.stats.rejected_other >= 140, "{:?}", out.stats);
        // On the ball all the time; a confident false one right next to it
        // (closer than a ball moves in a frame) may be taken now and then.
        // (The last frame comes after the last sighting.)
        let off: Vec<f32> = out.ball[..599]
            .iter()
            .enumerate()
            .map(|(f, b)| {
                let b = b.expect("always on the ball");
                angle((b[0], b[1]), (true_ball(f)[0], true_ball(f)[1]))
            })
            .collect();
        assert!(off.iter().all(|&d| d < 3f32.to_radians()));
        assert!(off.iter().filter(|&&d| d < 0.02).count() as f32 >= 0.98 * 599.0);
    }

    #[test]
    fn never_looks_down_at_the_grass() {
        // The ball near the camera (low in the picture) at the edge of a
        // group of players farther up: the camera keeps the players in the
        // picture and the ball in its lower part.
        let s = scene(
            300,
            |_| group(0.0, 0.0),
            |f| vec![ball(0.05 + 0.0005 * f as f32, -0.2, 0.6)],
        );
        let out = plan(&s, &BrainConfig::default());
        for (f, p) in out.path.iter().enumerate().skip(45).take(210) {
            let v = p[2].to_radians() / 2.0;
            // The ball in the lower half of the picture, above the margin.
            assert!(p[1] > -0.2, "frame {f}: aims at or below the ball {p:?}");
            assert!(-0.2 > p[1] - v, "frame {f}: ball out of the picture {p:?}");
            // The players' middle is in the picture.
            assert!(
                0.0 < p[1] + v,
                "frame {f}: players out of the picture {p:?}"
            );
            // No more than grassBelow of the picture under the ball.
            assert!((p[1] - v) > -0.2 - 0.3 * 2.0 * v - 1e-3, "frame {f}: {p:?}");
        }
        // A ball among the players: the ball sits in the lower middle,
        // the aim above it (like a TV camera), not centred on the ball.
        let s = scene(300, |_| group(0.0, 0.0), |_| vec![ball(0.0, -0.02, 0.6)]);
        let out = plan(&s, &BrainConfig::default());
        let p = out.path[150];
        let v: f32 = p[2].to_radians() / 2.0;
        let from_bottom = ((-0.02 - p[1]).tan() / v.tan() + 1.0) / 2.0;
        assert!(
            (0.3..0.5).contains(&from_bottom),
            "ball at {from_bottom:.2} of the height: {p:?}"
        );
        assert!(
            p[2] <= 34.0 + 1e-4,
            "never wider than the widest view: {p:?}"
        );
    }

    #[test]
    fn moves_smoothly() {
        // A ball that jumps about (a pass, then back), seen in bursts.
        let s = scene(
            900,
            |f| group(if f < 450 { -0.3 } else { 0.4 }, 0.0),
            |f| {
                let t = f as f32 / FPS;
                let yaw = if t < 10.0 {
                    -0.3 + 0.02 * (t * 7.0).sin()
                } else {
                    0.4
                };
                if f % 5 == 0 {
                    vec![]
                } else {
                    vec![ball(yaw, -0.03 + 0.01 * (t * 5.0).sin(), 0.5)]
                }
            },
        );
        let cfg = BrainConfig::default();
        let out = plan(&s, &cfg);
        // The acceleration bound of the speed limit and the averaging.
        for (c, top) in [(0, cfg.max_pan_deg_per_sec), (1, cfg.max_tilt_deg_per_sec)] {
            let bound = 2.0 * top.to_radians()
                / (2.0 * ((cfg.smooth_secs * FPS) / 2.0).round() + 1.0)
                * FPS;
            let a = max_accel(&out.path, c);
            assert!(a <= bound * 1.001, "axis {c}: {a} > {bound} rad/s²");
        }
        let speed = out
            .path
            .windows(2)
            .map(|w| (w[1][0] - w[0][0]).abs() * FPS)
            .fold(0.0, f32::max);
        assert!(
            speed <= cfg.max_pan_deg_per_sec.to_radians() * 1.001,
            "{speed}"
        );
        // The small wobble of the ball does not shake the camera.
        let still = out.path[100..200]
            .iter()
            .map(|p| p[0])
            .fold((f32::MAX, f32::MIN), |(a, b), y| (a.min(y), b.max(y)));
        assert!(still.1 - still.0 < 0.01, "camera wobbles {:?}", still);
        // And it is already moving before the pass (it looks ahead).
        assert!(out.path[300][0] > -0.29);
        assert!((out.path[700][0] - 0.4).abs() < 0.02);
    }

    #[test]
    fn heights_fit_and_fall_back() {
        let s = scene(1, |_| vec![], |_| vec![]);
        let h = Heights::fit(&s.sizes);
        assert!(
            (h.at(-0.1) - 4.0f32.to_radians()).abs() < 1e-3,
            "{}",
            h.at(-0.1).to_degrees()
        );
        assert!((h.at(0.1) - 2.5f32.to_radians()).abs() < 1e-3);
        // Kept within what was measured.
        assert!(h.at(1.0) >= 2.0f32.to_radians() * 0.7 * 0.99);
        assert_eq!(Heights::fit(&[]).at(0.3), DEFAULT_PLAYER_RAD);
        // Bigger higher up is not a pitch seen from the side: one size.
        let odd: Vec<(f32, f32)> = (0..100)
            .map(|i| (i as f32 * 0.01, 0.01 + i as f32 * 0.001))
            .collect();
        let h = Heights::fit(&odd);
        assert_eq!(h.at(0.0), h.at(0.9));
    }

    #[test]
    fn smoothing_helpers() {
        let x: Vec<f32> = (0..50).map(|i| if i < 25 { 0.0 } else { 1.0 }).collect();
        let a = average(&x, 2);
        assert_eq!(a[0], 0.0);
        assert!((a[24] - 0.4).abs() < 1e-6 && (a[49] - 1.0).abs() < 1e-6);
        // The dead zone keeps a small wobble still, a ramp exactly.
        let wobble: Vec<f32> = (0..40).map(|i| 0.5 * (i as f32).sin()).collect();
        let d = dead_zone(&wobble, 1.0);
        assert!(d.iter().all(|v| (v - d[0]).abs() < 1e-6));
        let ramp: Vec<f32> = (0..40).map(|i| i as f32).collect();
        let d = dead_zone(&ramp, 2.0);
        assert!(
            d[5..35]
                .iter()
                .zip(&ramp[5..35])
                .all(|(a, b)| (a - b).abs() < 1e-5)
        );
        // The speed limit starts a step early and ends late.
        let s = speed_limit(&x, 0.1);
        assert!(s.windows(2).all(|w| (w[1] - w[0]).abs() <= 0.1 + 1e-6));
        assert!(s[20] > 0.0 && s[29] < 1.0);
        assert!((s[24] + s[25] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn config_checks_and_names() {
        let cfg = BrainConfig::default();
        assert_eq!(cfg.check(), Ok(()));
        let json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(json["staticSecs"], 1.5);
        let tuned: BrainConfig = serde_json::from_str(r#"{"gapSecs": 3}"#).unwrap();
        assert_eq!(tuned.gap_secs, 3.0);
        assert_eq!(tuned.static_secs, 1.5);
        assert!(serde_json::from_str::<BrainConfig>(r#"{"gapSec": 3}"#).is_err());
        let bad = BrainConfig {
            ball_height: 2.0,
            ..cfg.clone()
        };
        assert!(bad.check().is_err());
        let bad = BrainConfig {
            smooth_secs: -1.0,
            ..cfg
        };
        assert!(bad.check().is_err());
        let stats = BallStats {
            frames: 100,
            detected: 0.234,
            seen: 0.2,
            followed: 0.61,
            sightings: 40,
            rejected_static: 10,
            rejected_other: 5,
        };
        assert!(describe(&stats).contains("23% of the frames"));
        let v = serde_json::to_value(stats).unwrap();
        assert_eq!(v["rejectedStatic"], 10);
    }

    /// Through `observe`: recorded detections in camera coordinates on the
    /// synthetic calibration, the pitch outline, every 3rd frame.
    #[test]
    fn from_a_recording() {
        use crate::seen::{Classes, WidestView};
        use reco_core::calibration::FieldRoi;
        let cal: MatchCalibration = serde_json::from_str(crate::calib::tests::SYNTH_MATCH).unwrap();
        let det = |camera, class_id, conf, x: f32, y: f32| Detection {
            camera,
            class_id,
            confidence: conf,
            center_x: x,
            center_y: y,
            width: 0.01,
            height: if class_id == 0 { 0.08 } else { 0.015 },
        };
        let frames: Vec<Vec<Detection>> = (0..300)
            .map(|i| {
                let t = i as f32 / 300.0;
                let mut f: Vec<Detection> = (0..8)
                    .map(|k| det(CameraId::Left, 0, 0.6, 0.3 + 0.05 * k as f32 + 0.2 * t, 0.6))
                    .collect();
                f.push(det(CameraId::Left, 32, 0.4, 0.3 + 0.4 * t, 0.62));
                f.push(det(CameraId::Left, 32, 0.3, 0.1, 0.8)); // a mark on the grass
                f.push(det(CameraId::Right, 0, 0.5, 0.2, 0.2)); // a spectator
                f
            })
            .collect();
        let meta = SeenMeta {
            version: crate::seen::VERSION,
            model: "m.onnx".into(),
            model_bytes: 1,
            classes: Classes {
                person: Some(0),
                ball: 32,
                roi_person: 0,
            },
            fps: 30.0,
            lookahead_frames: 45,
            every: 1,
            frames: 300,
            sync_offset: 0,
        };
        let roi = FieldRoi {
            left: vec![[0.0, 0.3], [1.0, 0.3], [1.0, 1.0], [0.0, 1.0]],
            right: vec![[0.0, 0.3], [1.0, 0.3], [1.0, 1.0], [0.0, 1.0]],
        };
        let settings = RepanSettings {
            style: crate::store::Style::Ball,
            every: 3,
            roi: Some(roi),
            widest: WidestView::Natural,
        };
        let (scene, stats) = observe(&cal, &meta, &frames, &settings).unwrap();
        assert_eq!(scene.looks.len(), 100);
        assert_eq!(
            stats.outside_pitch, 100,
            "the spectator, in each of 100 looks"
        );
        assert!(
            scene
                .looks
                .iter()
                .all(|l| l.persons.len() == 8 && l.balls.len() == 2)
        );
        assert!(!scene.sizes.is_empty());
        let out = plan(&scene, &BrainConfig::default());
        assert_eq!(out.path.len(), 300);
        assert!(
            out.path
                .iter()
                .all(|p| p.iter().all(|v| v.is_finite()) && p[2] <= 34.0 + 1e-4)
        );
        assert_eq!(out.stats.rejected_static, 100);
        assert!(out.stats.followed > 0.95, "{:?}", out.stats);
        // The camera turns with the ball (positive yaw is left: the ball
        // goes right).
        assert!(out.path[290][0] < out.path[10][0] - 0.1);
        let (again, _) = follow(&cal, &meta, &frames, &settings, &BrainConfig::default()).unwrap();
        assert_eq!(again.path, out.path, "deterministic");
        // Asking for every frame from a recording of every 3rd is refused.
        let coarse = SeenMeta {
            every: 3,
            ..meta.clone()
        };
        let every_frame = RepanSettings {
            every: 1,
            ..settings
        };
        assert!(observe(&cal, &coarse, &frames, &every_frame).is_err());
    }
}
