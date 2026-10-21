// WebGL2 preview renderers. One fragment shader casts a ray per pixel into
// Reco's two camera planes (the same maths as projection.ts / fisheye.wgsl)
// and samples the stacked proxy video: left camera in the top half, right
// camera in the bottom half.
import { globalYawRange } from "./clamp";
import { buildRig, cameraBasis, type Rig, type RigCamera } from "./projection";
import type { CalibInfo, Pose } from "./types";

const VERTEX_SHADER = `#version 300 es
void main() {
  // One triangle that covers the whole canvas.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform vec2 uResolution;
uniform int uMode;            // 0 = camera view, 1 = whole-pitch overview
uniform vec3 uEye;
uniform vec3 uF, uR, uU;      // camera view: forward, right, up
uniform vec2 uScale;          // camera view: tan(fov/2) * aspect, tan(fov/2)
uniform vec3 uBaseF, uBaseR;  // overview: yaw/pitch basis
uniform vec4 uMap;            // overview: yawMax, yawSpan, pitchMax, pitchSpan
uniform float uPlaneAspect, uBlend, uCorrection;
uniform vec3 uOrigin[2], uEx[2], uEy[2], uN[2];
uniform vec4 uIntr[2], uDist[2];
out vec4 outColor;

// Source uv (v = 0 at the top) and alpha of camera i for a ray; alpha < 0 = miss.
vec3 sampleCamera(int i, vec3 ray) {
  float denom = dot(ray, uN[i]);
  if (abs(denom) < 1e-6) return vec3(0.0, 0.0, -1.0);
  vec3 toPlane = uOrigin[i] - uEye;
  float t = dot(toPlane, uN[i]) / denom;
  if (t <= 0.0) return vec3(0.0, 0.0, -1.0);
  vec3 rel = t * ray - toPlane;
  vec2 tex = vec2(dot(rel, uEx[i]) + 0.5, 0.5 - dot(rel, uEy[i]) * uPlaneAspect);
  if (tex.x < 0.0 || tex.x > 1.0 || tex.y < 0.0 || tex.y > 1.0) return vec3(0.0, 0.0, -1.0);

  // fisheye.wgsl: extended uv, KB4 lens distortion.
  vec2 uv = tex * 2.0 - 0.5;
  vec4 k = uIntr[i];
  vec4 d = uDist[i];
  float x = (uv.x - k.z) / k.x;
  float y = (uv.y - k.w) / k.y;
  float r = sqrt(x * x + y * y);
  float theta = atan(r);
  float t2 = theta * theta;
  float thetaFull = theta * (1.0 + d.x * t2 + d.y * t2 * t2 + d.z * t2 * t2 * t2 + d.w * t2 * t2 * t2 * t2);
  float thetaD = mix(theta, thetaFull, uCorrection);
  float scale = r > 0.0 ? thetaD / r : 1.0;
  vec2 src = vec2(k.x * x * scale + k.z, k.y * y * scale + k.w);
  if (src.x < 0.0 || src.x > 1.0 || src.y < 0.0 || src.y > 1.0) return vec3(0.0, 0.0, -1.0);

  float alpha = (i == 1 && uBlend > 0.0) ? smoothstep(0.0, uBlend, uv.x) : 1.0;
  return vec3(src, alpha);
}

// Sample camera i's tile, staying half a texel inside it so the other
// camera never bleeds in.
vec3 tileColor(int i, vec2 uv) {
  vec2 halfTexel = 0.5 / uTexSize;
  float u = clamp(uv.x, halfTexel.x, 1.0 - halfTexel.x);
  float v = clamp(uv.y * 0.5, halfTexel.y, 0.5 - halfTexel.y) + 0.5 * float(i);
  return texture(uTex, vec2(u, v)).rgb;
}

void main() {
  vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
  vec3 ray;
  if (uMode == 0) {
    ray = uF + ndc.x * uScale.x * uR + ndc.y * uScale.y * uU;
  } else {
    float yaw = uMap.x - (ndc.x * 0.5 + 0.5) * uMap.y;
    float pitch = uMap.z - (0.5 - ndc.y * 0.5) * uMap.w;
    ray = cos(pitch) * (cos(yaw) * uBaseF - sin(yaw) * uBaseR) + vec3(0.0, sin(pitch), 0.0);
  }
  // Composite over black: left camera first, right camera on top.
  vec3 col = vec3(0.0);
  vec3 s = sampleCamera(0, ray);
  if (s.z >= 0.0) col = mix(col, tileColor(0, s.xy), s.z);
  s = sampleCamera(1, ray);
  if (s.z >= 0.0) col = mix(col, tileColor(1, s.xy), s.z);
  outColor = vec4(col, 1.0);
}`;

const UNIFORMS = [
  "uTex", "uTexSize", "uResolution", "uMode", "uEye", "uF", "uR", "uU", "uScale", "uBaseF", "uBaseR",
  "uMap", "uPlaneAspect", "uBlend", "uCorrection", "uOrigin", "uEx", "uEy", "uN", "uIntr", "uDist",
] as const;
type UniformName = (typeof UNIFORMS)[number];

/** Pixel size of anything WebGL can upload as a texture. */
function sourceSize(src: TexImageSource): [number, number] {
  if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight];
  if (src instanceof HTMLImageElement) return [src.naturalWidth, src.naturalHeight];
  if (typeof VideoFrame !== "undefined" && src instanceof VideoFrame) return [src.displayWidth, src.displayHeight];
  return [(src as { width: number }).width, (src as { height: number }).height];
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`Preview shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

/** Shared WebGL plumbing for both renderers. */
abstract class ProxyRenderer {
  protected readonly canvas: HTMLCanvasElement;
  protected readonly rig: Rig;
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private loc = {} as Record<UniformName, WebGLUniformLocation | null>;
  private texSize: [number, number] = [1, 1];
  private source: TexImageSource | null = null;
  private lost = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, calib: CalibInfo) {
    this.canvas = canvas;
    this.rig = buildRig(calib);
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      throw new Error(
        "This browser can't show the video preview because 3D graphics (WebGL 2) are turned off or not supported. Please use the latest Chrome, Edge or Firefox.",
      );
    }
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.lost = gl.isContextLost();
    if (!this.lost) this.init();
  }

  private onLost = (e: Event): void => {
    e.preventDefault(); // tells the browser we want the context back
    this.lost = true;
  };

  private onRestored = (): void => {
    if (this.disposed) return;
    this.lost = false;
    this.init();
    if (this.source) this.updateVideoFrame(this.source);
    this.redraw();
  };

  /** Draw again with the last inputs (after the GPU context comes back). */
  protected abstract redraw(): void;

  private init(): void {
    const gl = this.gl;
    const program = gl.createProgram()!;
    const shaders = [compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER), compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)];
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`Preview shader failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    for (const name of UNIFORMS) this.loc[name] = gl.getUniformLocation(program, name);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Black until the first video frame arrives.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.texSize = [1, 1];

    // Rig constants.
    const rig = this.rig;
    const cams: RigCamera[] = [rig.cameras.left, rig.cameras.right];
    gl.useProgram(program);
    gl.uniform1i(this.loc.uTex, 0);
    gl.uniform3fv(this.loc.uEye, rig.eye);
    gl.uniform3fv(this.loc.uBaseF, rig.baseForward);
    gl.uniform3fv(this.loc.uBaseR, rig.baseRight);
    gl.uniform1f(this.loc.uPlaneAspect, rig.planeAspect);
    gl.uniform1f(this.loc.uBlend, rig.blendWidth);
    gl.uniform1f(this.loc.uCorrection, rig.lensCorrection);
    gl.uniform3fv(this.loc.uOrigin, cams.flatMap((c) => c.origin));
    gl.uniform3fv(this.loc.uEx, cams.flatMap((c) => c.ex));
    gl.uniform3fv(this.loc.uEy, cams.flatMap((c) => c.ey));
    gl.uniform3fv(this.loc.uN, cams.flatMap((c) => c.n));
    gl.uniform4fv(this.loc.uIntr, cams.flatMap((c) => c.intrinsics));
    gl.uniform4fv(this.loc.uDist, cams.flatMap((c) => c.d));
  }

  /**
   * Upload the video's current frame (call from requestVideoFrameCallback).
   * A video from another origin needs crossOrigin = "anonymous" (and CORS
   * headers) or the browser refuses the upload. Any texture source works
   * (a canvas or image too), which tests use.
   */
  updateVideoFrame(video: HTMLVideoElement | TexImageSource): void {
    if (this.disposed) return;
    this.source = video;
    if (this.lost || (video instanceof HTMLVideoElement && video.readyState < 2)) return;
    const [w, h] = sourceSize(video);
    if (!(w > 0 && h > 0)) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    this.texSize = [w, h];
  }

  /** Match the drawing buffer to the canvas's on-screen size (sharp on HiDPI screens). */
  private resize(): [number, number] {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    if (c.clientWidth > 0 && c.clientHeight > 0) {
      const w = Math.max(1, Math.round(c.clientWidth * dpr));
      const h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
    }
    return [c.width, c.height];
  }

  /** Draw one frame; `setup` sets the mode-specific uniforms for a w x h drawing buffer. */
  protected draw(setup: (gl: WebGL2RenderingContext, loc: Record<UniformName, WebGLUniformLocation | null>, w: number, h: number) => void): void {
    if (this.lost || this.disposed || !this.program) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const [w, h] = this.resize();
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform2f(this.loc.uTexSize, this.texSize[0], this.texSize[1]);
    gl.uniform2f(this.loc.uResolution, w, h);
    setup(gl, this.loc, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source = null;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    const gl = this.gl;
    if (!gl.isContextLost()) {
      gl.deleteTexture(this.texture);
      gl.deleteProgram(this.program);
    }
    this.texture = null;
    this.program = null;
  }
}

/**
 * WebGL2 virtual camera: renders what the export will look like for a pose,
 * sampling the stacked proxy video (left tile on top).
 */
export class CameraViewRenderer extends ProxyRenderer {
  private lastPose: Pose | null = null;

  render(pose: Pose): void {
    this.lastPose = { ...pose };
    this.draw((gl, loc, w, h) => {
      const { F, R, U } = cameraBasis(pose.yaw, pose.pitch, this.rig);
      const t = Math.tan((pose.fov * Math.PI) / 360);
      gl.uniform1i(loc.uMode, 0);
      gl.uniform3fv(loc.uF, F);
      gl.uniform3fv(loc.uR, R);
      gl.uniform3fv(loc.uU, U);
      gl.uniform2f(loc.uScale, t * (w / h), t);
    });
  }

  protected redraw(): void {
    if (this.lastPose) this.render(this.lastPose);
  }
}

/** WebGL2 whole-pitch overview (equirectangular map of the coverage). */
export class OverviewRenderer extends ProxyRenderer {
  /** Angles shown by the map: yawMax at the left edge, pitchMax at the top. */
  readonly extent: { yawMin: number; yawMax: number; pitchMin: number; pitchMax: number };
  private rendered = false;

  constructor(canvas: HTMLCanvasElement, calib: CalibInfo) {
    super(canvas, calib);
    const cov = calib.coverage;
    let [yawMin, yawMax] = globalYawRange(cov);
    let { pitchMin, pitchMax } = cov;
    if (!(yawMax > yawMin)) [yawMin, yawMax] = [-1, 1];
    if (!(pitchMax > pitchMin)) [pitchMin, pitchMax] = [-0.5, 0.5];
    this.extent = { yawMin, yawMax, pitchMin, pitchMax };
  }

  render(): void {
    this.rendered = true;
    const e = this.extent;
    this.draw((gl, loc) => {
      gl.uniform1i(loc.uMode, 1);
      gl.uniform4f(loc.uMap, e.yawMax, e.yawMax - e.yawMin, e.pitchMax, e.pitchMax - e.pitchMin);
    });
  }

  protected redraw(): void {
    if (this.rendered) this.render();
  }

  private cssSize(): [number, number] {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    return [c.clientWidth || c.width / dpr, c.clientHeight || c.height / dpr];
  }

  /** Canvas pixel (CSS px relative to the canvas) for a yaw/pitch. */
  yawPitchToCanvas(yaw: number, pitch: number): { x: number; y: number } {
    const [w, h] = this.cssSize();
    const e = this.extent;
    return {
      x: ((e.yawMax - yaw) / (e.yawMax - e.yawMin)) * w,
      y: ((e.pitchMax - pitch) / (e.pitchMax - e.pitchMin)) * h,
    };
  }

  canvasToYawPitch(x: number, y: number): { yaw: number; pitch: number } {
    const [w, h] = this.cssSize();
    const e = this.extent;
    return {
      yaw: e.yawMax - (x / w) * (e.yawMax - e.yawMin),
      pitch: e.pitchMax - (y / h) * (e.pitchMax - e.pitchMin),
    };
  }
}
