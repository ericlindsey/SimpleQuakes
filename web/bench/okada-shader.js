// GLSL ES 3.00 (WebGL2) port of okada85.displacement, plus InSAR LOS + fringe
// colormap. fp32 throughout (browser shaders have no f64). Branches key only on
// `u_vertical`, a uniform derived from dip, so control flow never diverges
// across pixels -- the GPU-friendly property that makes the nonlinear Okada
// kernel parallelize cleanly.
//
// Exported as strings so the harness (okada-bench.html) can compile them.

export const VERT_SRC = `#version 300 es
// Fullscreen triangle from gl_VertexID; no attribute buffers needed.
void main() {
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0,
                (gl_VertexID == 2) ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

export const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform vec2  u_resolution;  // drawing buffer size (px)
uniform vec2  u_extent;      // half-extent of the view in km (ex, ey)
uniform vec2  u_origin;      // view center offset in km (pan)

uniform float u_depth, u_L, u_W, u_nu;
uniform float u_sstr, u_cstr, u_sdip, u_cdip;  // sin/cos of strike, dip
uniform float u_U1s, u_U2s, u_U3s;             // pre-scaled slip components
uniform int   u_vertical;                      // 1 if cos(dip) ~ 0
uniform vec3  u_look;                           // InSAR LOS unit vector (E,N,U)
uniform float u_fringe;                         // range change per fringe (km)
uniform int   u_mode;                           // 0 = colormap, 1 = raw floats

out vec4 outColor;

const float XI_EPS = 1.0e-12; // turns exact xi==0 into a tiny nonzero value

// --- I... subfunctions [Okada eqs (28)-(29)]; branch on uniform u_vertical ---
float I5f(float xi, float eta, float q, float R, float db) {
  float X = sqrt(xi * xi + q * q);
  float xs = (xi == 0.0) ? XI_EPS : xi;
  if (u_vertical == 0) {
    return (1.0 - 2.0 * u_nu) * 2.0 / u_cdip *
      atan((eta * (X + q * u_cdip) + X * (R + X) * u_sdip) /
           (xs * (R + X) * u_cdip));
  }
  return -(1.0 - 2.0 * u_nu) * xi * u_sdip / (R + db);
}
float I4f(float db, float eta, float q, float R) {
  if (u_vertical == 0) {
    return (1.0 - 2.0 * u_nu) / u_cdip *
      (log(R + db) - u_sdip * log(R + eta));
  }
  return -(1.0 - 2.0 * u_nu) * q / (R + db);
}
float I3f(float eta, float q, float R, float i4) {
  float yb = eta * u_cdip + q * u_sdip;
  float db = eta * u_sdip - q * u_cdip;
  if (u_vertical == 0) {
    return (1.0 - 2.0 * u_nu) * (yb / (u_cdip * (R + db)) - log(R + eta)) +
      u_sdip / u_cdip * i4;
  }
  return (1.0 - 2.0 * u_nu) / 2.0 *
    (eta / (R + db) + yb * q / ((R + db) * (R + db)) - log(R + eta));
}
float I1f(float xi, float eta, float q, float R, float i5) {
  float db = eta * u_sdip - q * u_cdip;
  if (u_vertical == 0) {
    return (1.0 - 2.0 * u_nu) * (-xi / (u_cdip * (R + db))) -
      u_sdip / u_cdip * i5;
  }
  return -(1.0 - 2.0 * u_nu) / 2.0 * xi * q / ((R + db) * (R + db));
}

struct Sub { vec3 ss; vec3 ds; vec3 tf; };

// All nine displacement subfunctions at one Chinnery corner (xi, eta, q).
Sub subAt(float xi, float eta, float q) {
  float sd = u_sdip, cd = u_cdip;
  float R = sqrt(xi * xi + eta * eta + q * q);
  float db = eta * sd - q * cd;
  float yb = eta * cd + q * sd;
  float Re = R + eta;
  float Rx = R + xi;
  float at = atan(xi * eta / (q * R));

  float i5 = I5f(xi, eta, q, R, db);
  float i4 = I4f(db, eta, q, R);
  float i3 = I3f(eta, q, R, i4);
  float i2 = (1.0 - 2.0 * u_nu) * (-log(Re)) - i3;
  float i1 = I1f(xi, eta, q, R, i5);

  Sub s;
  // strike-slip [eq (25)]
  s.ss = vec3(
    xi * q / (R * Re) + at + i1 * sd,
    (eta * cd + q * sd) * q / (R * Re) + q * cd / Re + i2 * sd,
    db * q / (R * Re) + q * sd / Re + i4 * sd);
  // dip-slip [eq (26)]
  s.ds = vec3(
    q / R - i3 * sd * cd,
    (eta * cd + q * sd) * q / (R * Rx) + cd * at - i1 * sd * cd,
    db * q / (R * Rx) + sd * at - i5 * sd * cd);
  // tensile [eq (27)]
  s.tf = vec3(
    q * q / (R * Re) - i3 * sd * sd,
    -db * q / (R * Rx) - sd * (xi * q / (R * Re) - at) - i1 * sd * sd,
    (eta * cd + q * sd) * q / (R * Rx) + cd * (xi * q / (R * Re) - at) -
      i5 * sd * sd);
  return s;
}

// Returns surface displacement (ue, un, uz) at east/north offset (e, n) km.
vec3 okadaDisp(float e, float n) {
  float d = u_depth + u_sdip * u_W * 0.5;
  float ec = e + u_cstr * u_cdip * u_W * 0.5;
  float nc = n - u_sstr * u_cdip * u_W * 0.5;
  float x = u_cstr * nc + u_sstr * ec + u_L * 0.5;
  float y = u_sstr * nc - u_cstr * ec + u_cdip * u_W;
  float p = y * u_cdip + d * u_sdip;
  float q = y * u_sdip - d * u_cdip;
  if (abs(q) < 1.0e-12) q = 1.0e-12; // avoid 0/0 in the atan term on q=0 plane

  Sub a = subAt(x, p, q);
  Sub b = subAt(x, p - u_W, q);
  Sub c = subAt(x - u_L, p, q);
  Sub dd = subAt(x - u_L, p - u_W, q);
  vec3 ss = a.ss - b.ss - c.ss + dd.ss;
  vec3 ds = a.ds - b.ds - c.ds + dd.ds;
  vec3 tf = a.tf - b.tf - c.tf + dd.tf;

  vec3 u = -u_U1s * ss - u_U2s * ds + u_U3s * tf; // (ux, uy, uz)
  return vec3(u_sstr * u.x - u_cstr * u.y,   // ue
              u_cstr * u.x + u_sstr * u.y,   // un
              u.z);                          // uz
}

// Cyclic colormap for wrapped fringes.
vec3 fringeColor(float t) {
  float a = 6.28318530718 * t;
  return 0.5 + 0.5 * vec3(cos(a), cos(a - 2.09439510239), cos(a - 4.18879020479));
}

void main() {
  vec2 ndc = gl_FragCoord.xy / u_resolution;       // 0..1, pixel centers
  float e = u_origin.x + (ndc.x * 2.0 - 1.0) * u_extent.x;
  float n = u_origin.y + (ndc.y * 2.0 - 1.0) * u_extent.y;

  vec3 disp = okadaDisp(e, n);
  float los = dot(disp, u_look);

  if (u_mode == 1) {
    outColor = vec4(disp, los);                    // raw, for validation
    return;
  }
  float phase = fract(los / u_fringe);
  outColor = vec4(fringeColor(phase), 1.0);
}`;
