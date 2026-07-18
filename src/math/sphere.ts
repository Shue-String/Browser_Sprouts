/**
 * Sphere coordinate math and projection.
 *
 * Convention:
 *   SpherePoint  - a point on the unit sphere in Cartesian (x, y, z)
 *   CanvasPoint  - a 2D point in canvas/screen space (px, py)
 *
 * Two projections are provided (see `project` / `projectRect` below):
 *   - Lambert azimuthal equal-area (sphere → disk), the default renderer view,
 *     centered on the south pole.
 *   - A squircle-rect variant (Lambert composed with the Shirley-Chiu disk↔square
 *     map) that fills the whole rectangle with no wraparound seam.
 * The exact forward/inverse formulas are documented on each function.
 *
 * The "camera" is a rotation applied to all sphere points before projection,
 * letting the user spin the sphere by dragging.
 */

export interface SpherePoint {
  x: number;
  y: number;
  z: number;
}

export interface CanvasPoint {
  px: number;
  py: number;
}

// 3x3 rotation matrix, row-major
export type RotationMatrix = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export function identityRotation(): RotationMatrix {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/** Rotate a sphere point by a rotation matrix (world → camera). */
export function rotateSpherePoint(p: SpherePoint, m: RotationMatrix): SpherePoint {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2] * p.z,
    y: m[3] * p.x + m[4] * p.y + m[5] * p.z,
    z: m[6] * p.x + m[7] * p.y + m[8] * p.z,
  };
}

/**
 * Apply the inverse (transpose) of a rotation matrix (camera → world).
 * Since rotation matrices are orthogonal, M^{-1} = M^T.
 * Use this to convert a camera-space sphere point back to world space.
 */
export function unrotateSpherePoint(p: SpherePoint, m: RotationMatrix): SpherePoint {
  return {
    x: m[0] * p.x + m[3] * p.y + m[6] * p.z,
    y: m[1] * p.x + m[4] * p.y + m[7] * p.z,
    z: m[2] * p.x + m[5] * p.y + m[8] * p.z,
  };
}

/**
 * Compose two rotation matrices: returns m1 * m2.
 * Apply m2 first, then m1.
 */
export function composeRotations(m1: RotationMatrix, m2: RotationMatrix): RotationMatrix {
  return [
    m1[0]*m2[0] + m1[1]*m2[3] + m1[2]*m2[6],
    m1[0]*m2[1] + m1[1]*m2[4] + m1[2]*m2[7],
    m1[0]*m2[2] + m1[1]*m2[5] + m1[2]*m2[8],

    m1[3]*m2[0] + m1[4]*m2[3] + m1[5]*m2[6],
    m1[3]*m2[1] + m1[4]*m2[4] + m1[5]*m2[7],
    m1[3]*m2[2] + m1[4]*m2[5] + m1[5]*m2[8],

    m1[6]*m2[0] + m1[7]*m2[3] + m1[8]*m2[6],
    m1[6]*m2[1] + m1[7]*m2[4] + m1[8]*m2[7],
    m1[6]*m2[2] + m1[7]*m2[5] + m1[8]*m2[8],
  ];
}

/**
 * Build a rotation matrix for angle radians around the X axis.
 * Used to tilt the sphere up/down in response to vertical drag.
 */
export function rotationX(angle: number): RotationMatrix {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

/**
 * Build a rotation matrix for angle radians around the Y axis.
 * Used to spin the sphere left/right in response to horizontal drag.
 */
export function rotationY(angle: number): RotationMatrix {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/**
 * Lambert azimuthal equal-area projection: sphere → canvas.
 *
 * Maps the entire unit sphere to a disk of radius `diskRadius` on screen.
 * Centered at the south pole (0,0,-1) — that point maps to the screen center.
 * The north pole (0,0,1) maps to the boundary of the disk.
 *
 * Forward formula:
 *   k  = sqrt(2 / (1 - z))      [k → 1 at south pole, → ∞ at north pole]
 *   nx = x * k                  [normalized coords, disk radius = 2]
 *   ny = y * k
 *   px = cx + nx * (diskRadius / 2)
 *   py = cy + ny * (diskRadius / 2)
 *
 * Near the north pole (z → 1), x and y → 0 at the same rate, so nx and ny
 * stay bounded (magnitude → 2). We clamp to avoid sqrt of zero.
 */
export function project(p: SpherePoint, diskRadius: number, cx: number, cy: number): CanvasPoint {
  const z = Math.max(p.z, -1 + 1e-9);
  const k = Math.sqrt(2 / (1 - z));
  return {
    px: cx + p.x * k * (diskRadius / 2),
    py: cy + p.y * k * (diskRadius / 2),
  };
}

/**
 * Inverse Lambert projection: canvas point → sphere point.
 *
 * Inverse formula:
 *   u  = (px - cx) / (diskRadius / 2)   [normalized, disk radius = 2]
 *   v  = (py - cy) / (diskRadius / 2)
 *   r2 = u*u + v*v                       [clamped to [0, 4]]
 *   z  = r2 / 2 - 1                      [-1 at center, +1 at boundary]
 *   x  = u * sqrt(1 - r2/4)
 *   y  = v * sqrt(1 - r2/4)
 *
 * Points outside the disk (r2 > 4) are clamped to the boundary (north pole).
 */
export function unproject(px: number, py: number, diskRadius: number, cx: number, cy: number): SpherePoint {
  const half = diskRadius / 2;
  const u  = (px - cx) / half;
  const v  = (py - cy) / half;
  const r2 = Math.min(u * u + v * v, 4 - 1e-9); // clamp to disk
  const z  = r2 / 2 - 1;
  const f  = Math.sqrt(Math.max(0, 1 - r2 / 4));
  return { x: u * f, y: v * f, z };
}

// ---------------------------------------------------------------------------
// Shirley-Chiu concentric disk ↔ square mapping
// Maps the unit disk bijectively to the unit square.
// The disk boundary maps exactly to the square boundary — corners included.
// Reference: Shirley & Chiu, "A Low Distortion Map Between Disk and Square" (1997)
// ---------------------------------------------------------------------------

/**
 * Unit disk → unit square  (needed for the forward projection: sphere → screen).
 * Input: (u,v) with u²+v² ≤ 1.  Output: (a,b) with |a|,|b| ≤ 1.
 *
 * Uses polar angle to determine which edge of the square to land on,
 * then scales r to the appropriate axis distance.
 */
function diskToSquare(u: number, v: number): [number, number] {
  const r = Math.sqrt(u * u + v * v);
  if (r === 0) return [0, 0];

  let phi = Math.atan2(v, u);                          // [-π, π]
  if (phi < -Math.PI / 4) phi += 2 * Math.PI;          // → [-π/4, 7π/4]

  let a: number, b: number;
  if (phi <= Math.PI / 4) {                            // right edge: a = r
    a = r;
    b = r * phi / (Math.PI / 4);
  } else if (phi <= 3 * Math.PI / 4) {                 // top edge: b = r
    b = r;
    a = r * (Math.PI / 2 - phi) / (Math.PI / 4);
  } else if (phi <= 5 * Math.PI / 4) {                 // left edge: a = -r
    a = -r;
    b = r * (Math.PI - phi) / (Math.PI / 4);
  } else {                                              // bottom edge: b = -r
    b = -r;
    a = r * (phi - 3 * Math.PI / 2) / (Math.PI / 4);
  }
  return [a, b];
}

/**
 * Unit square → unit disk  (needed for the inverse: screen → sphere).
 * Input: (a,b) with |a|,|b| ≤ 1.  Output: (u,v) with u²+v² ≤ 1.
 *
 * The original Shirley-Chiu formula: branch on whichever axis dominates.
 */
function squareToDisk(a: number, b: number): [number, number] {
  if (a === 0 && b === 0) return [0, 0];
  let r: number, phi: number;
  if (Math.abs(a) >= Math.abs(b)) {
    r   = a;
    phi = (Math.PI / 4) * (b / a);
  } else {
    r   = b;
    phi = Math.PI / 2 - (Math.PI / 4) * (a / b);
  }
  return [r * Math.cos(phi), r * Math.sin(phi)];
}

/**
 * Squircle-rect projection: sphere → canvas rectangle.
 *
 * Composes Lambert azimuthal (sphere → unit disk) with the Shirley-Chiu
 * concentric mapping (unit disk → unit square).  The sphere boundary maps
 * to the rectangle boundary — corners included — with no wraparound seam.
 */
export function projectRect(p: SpherePoint, width: number, height: number): CanvasPoint {
  // Lambert: sphere → unit disk
  const z  = Math.max(p.z, -1 + 1e-9);
  const k  = Math.sqrt(2 / (1 - z));
  const u  = p.x * k / 2;   // Lambert normalized / 2 → unit disk
  const v  = p.y * k / 2;

  // Shirley-Chiu: unit disk → unit square
  const [sx, sy] = diskToSquare(u, v);

  return {
    px: width  / 2 + sx * width  / 2,
    py: height / 2 + sy * height / 2,
  };
}

/**
 * Inverse squircle-rect: canvas point → sphere point.
 *
 * Applies Shirley-Chiu (unit square → unit disk) then inverse Lambert
 * (unit disk → sphere).  Points outside the canvas are clamped.
 */
export function unprojectRect(px: number, py: number, width: number, height: number): SpherePoint {
  // Canvas → unit square (clamped)
  const a = Math.max(-1, Math.min(1, (px - width  / 2) / (width  / 2)));
  const b = Math.max(-1, Math.min(1, (py - height / 2) / (height / 2)));

  // Shirley-Chiu: unit square → unit disk
  const [u, v] = squareToDisk(a, b);

  // Inverse Lambert: unit disk → sphere
  const r2 = Math.min(u * u + v * v, 1 - 1e-9);  // clamp to disk
  // Lambert normalized = 2*(u,v), so r2_norm = 4*r2
  const r2n = 4 * r2;
  const z   = r2n / 2 - 1;
  const f   = Math.sqrt(Math.max(0, 1 - r2n / 4));
  return { x: 2 * u * f, y: 2 * v * f, z };
}

/**
 * Build a rotation matrix from an axis (unit vector) and angle (radians).
 * Uses Rodrigues' rotation formula.
 */
export function axisAngleRotation(axis: SpherePoint, angle: number): RotationMatrix {
  const { x: ux, y: uy, z: uz } = axis;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    c + ux*ux*t,       ux*uy*t - uz*s,  ux*uz*t + uy*s,
    uy*ux*t + uz*s,    c + uy*uy*t,     uy*uz*t - ux*s,
    uz*ux*t - uy*s,    uz*uy*t + ux*s,  c + uz*uz*t,
  ];
}

/** Normalize a sphere point back onto the unit sphere (corrects floating-point drift). */
export function normalize(p: SpherePoint): SpherePoint {
  const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  return { x: p.x / len, y: p.y / len, z: p.z / len };
}

/** Sum a set of sphere points and renormalize onto the unit sphere. */
export function sphereCentroid(points: SpherePoint[]): SpherePoint {
  let cx = 0, cy = 0, cz = 0;
  for (const p of points) { cx += p.x; cy += p.y; cz += p.z; }
  return normalize({ x: cx, y: cy, z: cz });
}

/** Spherical linear interpolation between two sphere points. */
export function slerp(a: SpherePoint, b: SpherePoint, t: number): SpherePoint {
  const dot = Math.max(-1, Math.min(1, a.x*b.x + a.y*b.y + a.z*b.z));
  const omega = Math.acos(dot);
  if (Math.abs(omega) < 1e-9) return a; // nearly identical points
  const sinOmega = Math.sin(omega);
  const wa = Math.sin((1 - t) * omega) / sinOmega;
  const wb = Math.sin(t * omega) / sinOmega;
  return normalize({ x: wa*a.x + wb*b.x, y: wa*a.y + wb*b.y, z: wa*a.z + wb*b.z });
}

/**
 * True if two spherical arcs (great-circle segments, each shorter than a
 * half-circle) cross.
 *
 * The two straddle tests below (does b0-b1 straddle a's great-circle plane,
 * and does a0-a1 straddle b's) are individually valid, but on a sphere two
 * great circles always meet at *two* antipodal points — the plain 2D
 * "double orientation test" doesn't distinguish "both arcs cross at the same
 * point" from "arc a crosses at X while arc b crosses at -X", which are
 * unrelated. Passing both straddle tests is therefore necessary but not
 * sufficient; the candidate intersection point must additionally be checked
 * to fall within *both* arcs' short spans (checking either antipodal
 * candidate, since we don't yet know which one the straddle tests found).
 */
export function arcsCross(a0: SpherePoint, a1: SpherePoint, b0: SpherePoint, b1: SpherePoint): boolean {
  const nax = a0.y*a1.z - a0.z*a1.y, nay = a0.z*a1.x - a0.x*a1.z, naz = a0.x*a1.y - a0.y*a1.x;
  const sb0 = b0.x*nax + b0.y*nay + b0.z*naz;
  const sb1 = b1.x*nax + b1.y*nay + b1.z*naz;
  if (sb0 * sb1 >= 0) return false;
  const nbx = b0.y*b1.z - b0.z*b1.y, nby = b0.z*b1.x - b0.x*b1.z, nbz = b0.x*b1.y - b0.y*b1.x;
  const sa0 = a0.x*nbx + a0.y*nby + a0.z*nbz;
  const sa1 = a1.x*nbx + a1.y*nby + a1.z*nbz;
  if (sa0 * sa1 >= 0) return false;

  // Candidate intersection direction — the line where the two great-circle
  // planes meet. Its antipode (-px,-py,-pz) is the other candidate; exactly
  // one of the two (if either) is the actual shared point of both arcs.
  const px = nay*nbz - naz*nby, py = naz*nbx - nax*nbz, pz = nax*nby - nay*nbx;

  const isBetween = (p0: SpherePoint, p1: SpherePoint, nx: number, ny: number, nz: number, qx: number, qy: number, qz: number): boolean => {
    // q lies on the minor arc p0->p1 (whose plane normal is (nx,ny,nz)) iff
    // cross(p0,q) and cross(q,p1) both point the same way as that normal.
    const c1x = p0.y*qz - p0.z*qy, c1y = p0.z*qx - p0.x*qz, c1z = p0.x*qy - p0.y*qx;
    const c2x = qy*p1.z - qz*p1.y, c2y = qz*p1.x - qx*p1.z, c2z = qx*p1.y - qy*p1.x;
    const d1 = c1x*nx + c1y*ny + c1z*nz;
    const d2 = c2x*nx + c2y*ny + c2z*nz;
    return d1 >= 0 && d2 >= 0;
  };

  const matchesCandidate = (qx: number, qy: number, qz: number): boolean =>
    isBetween(a0, a1, nax, nay, naz, qx, qy, qz) && isBetween(b0, b1, nbx, nby, nbz, qx, qy, qz);

  return matchesCandidate(px, py, pz) || matchesCandidate(-px, -py, -pz);
}

/**
 * True if the great-circle segment a0->a1 crosses any segment of the spherical
 * polyline. Camera-independent (works directly on sphere points), so unlike a
 * projected 2D test it can't false-positive/negative on far-side overlaps.
 *
 * `skipFirst` / `skipLast` skip that many segments at the polyline's start / end
 * — used to ignore near-vertex segments that share an endpoint with the tested segment.
 */
export function segCrossesPolylineSphere(
  a0: SpherePoint, a1: SpherePoint,
  polyline: SpherePoint[],
  skipLast = 0, skipFirst = 0,
): boolean {
  const limit = polyline.length - 1 - skipLast;
  for (let i = skipFirst; i < limit; i++) {
    if (arcsCross(a0, a1, polyline[i], polyline[i + 1])) return true;
  }
  return false;
}

