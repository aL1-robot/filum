/** Nail geometry, calibration fit, loop toolpath, and calibration queues. No DOM. */

export const TAU = Math.PI * 2
const DEG = Math.PI / 180

export type Vec = [number, number]

export type RawParams = {
  n: number
  ib: number
  sa: number
  ao: number
  cw: boolean
  base: number
  tilt: number
  nh: number
  nd: number
  cd: number
  ct: number
  rin: number
  rout: number
  ndl: number
  nz: number
  lin: number
  lout: number
  lw: number
  lr: number
  lm: number
  pd: number
  pa: number
  pn: number
  cu: number
  cv: number
  bw: number
  bh: number
  f: number
  tf: number
  dx: number
  dy: number
  dr: number
}

export type Params = RawParams & {
  t: number
  Rh: number
  so: number
  ang: (i: number) => number
}

export type Anchor = { nail: number; x: number; y: number }

export type Calib = {
  th: number
  tx: number
  ty: number
  res: number
  rc: number
  ae: number[]
}

export type Gap = { gap: number; path: Vec[]; footprint: Vec[] }

export type Measurements = Record<number, Vec>

export type Plan = {
  p: Params
  cal: Calib
  warnings: string[]
  ccw: Gap
  cw: Gap
  mp: Vec[]
  route: Vec[]
  exit: Vec[]
  vend: number[]
  visits: number
  pullDowns: number
  length: number
  /** Measured minus predicted, machine frame, keyed by nail index. */
  residuals: Record<number, Vec>
  /** Interpolated machine-frame offset at every nail. */
  offset: Vec[]
  /** Same offset, rotated into the path frame used before calibration transform. */
  offsetPath: Vec[]
  measuredCount: number
}

export const DEFAULT_RAW: RawParams = {
  n: 270,
  ib: 0,
  sa: -90,
  ao: -90,
  cw: true,
  base: 259.85,
  tilt: 35,
  nh: 14.5,
  nd: 1.5,
  cd: 3,
  ct: 0.85,
  rin: 250,
  rout: 290,
  ndl: 1,
  nz: 8,
  lin: 3,
  lout: 7.28,
  lw: 3,
  lr: 1.5,
  lm: 0.3,
  pd: 13.4,
  pa: 13.4,
  pn: 1,
  cu: 6.28,
  cv: 0,
  bw: 595,
  bh: 595,
  f: 2000,
  tf: 3000,
  dx: 0,
  dy: 0,
  dr: 0,
}

type FieldSpec = { key: keyof RawParams; label: string; check?: boolean }

export const FIELD_GROUPS: { title: string; open: boolean; fields: FieldSpec[]; kind?: 'loop' | 'contact' }[] = [
  {
    title: 'Nails and ring',
    open: true,
    fields: [
      { key: 'n', label: 'Nail count' },
      { key: 'ib', label: 'First nail number in file' },
      { key: 'sa', label: 'Ring nail 0 angle (deg)' },
      { key: 'ao', label: 'File nail 0 lands at angle (deg)' },
      { key: 'cw', label: 'Clockwise numbering', check: true },
      { key: 'base', label: 'Nail axis radius at ring face' },
      { key: 'tilt', label: 'Nail lean outward (deg)' },
      { key: 'nh', label: 'Height, face to cap tip' },
      { key: 'nd', label: 'Nail diameter' },
      { key: 'cd', label: 'Cap diameter' },
      { key: 'ct', label: 'Cap thickness' },
      { key: 'rin', label: 'Ring inner radius (drawing)' },
      { key: 'rout', label: 'Ring outer radius (drawing)' },
    ],
  },
  {
    title: 'Needle',
    open: true,
    fields: [
      { key: 'ndl', label: 'Needle diameter' },
      { key: 'nz', label: 'Needle tip height' },
    ],
  },
  {
    title: 'Loop around each nail',
    open: true,
    kind: 'loop',
    fields: [
      { key: 'lin', label: 'Inner travel depth' },
      { key: 'lout', label: 'Outer reach' },
      { key: 'lw', label: 'Half width' },
      { key: 'lr', label: 'Corner fillet radius' },
      { key: 'lm', label: 'Minimum gap to nail' },
      { key: 'pd', label: 'Pull-down reach, inward (0 = off)' },
      { key: 'pa', label: 'Pull down if inward pull is under' },
      { key: 'pn', label: 'Pull-down strokes' },
    ],
  },
  {
    title: 'Calibration: needle touching the cap',
    open: true,
    kind: 'contact',
    fields: [
      { key: 'cu', label: 'Contact offset, radial' },
      { key: 'cv', label: 'Contact offset, sideways' },
    ],
  },
  {
    title: 'Machine and nudge',
    open: false,
    fields: [
      { key: 'bw', label: 'Bed width X' },
      { key: 'bh', label: 'Bed height Y' },
      { key: 'f', label: 'Thread feed' },
      { key: 'tf', label: 'Travel feed' },
      { key: 'dx', label: 'Nudge X' },
      { key: 'dy', label: 'Nudge Y' },
      { key: 'dr', label: 'Nudge rotation (deg)' },
    ],
  },
]

export function prepare(raw: RawParams): Params {
  const t = raw.tilt * DEG
  const Rh = raw.base + raw.nz * Math.tan(t)
  const d = raw.cw ? -1 : 1
  const so = raw.n > 0
    ? (((Math.round((raw.ao - raw.sa) / (d * 360 / raw.n)) % raw.n) + raw.n) % raw.n)
    : 0
  const ang = (i: number) => (raw.n > 0 ? raw.sa * DEG + d * TAU * i / raw.n : 0)
  return { ...raw, t, Rh, so, ang }
}

/** Shaft and cap cross-sections in the nail frame: [radial, sideways, radial radius, sideways radius]. */
export function footprint(p: Params): number[][] {
  const t = p.t
  const c = Math.cos(t)
  const e: number[][] = []
  const L = p.nh / c
  for (let j = 0; j <= 7; j++) {
    const z = p.nz + (p.nh - p.nz) * j / 7
    e.push([(z - p.nz) * Math.tan(t), 0, p.nd / 2 / c, p.nd / 2])
  }
  if (p.cd > p.nd && p.ct > 0) {
    for (let j = 0; j <= 2; j++) {
      e.push([(L - p.ct * j / 2) * Math.sin(t) - p.nz * Math.tan(t), 0, p.cd / 2 * c, p.cd / 2])
    }
  }
  return e
}

function reach(p: Params): number {
  return Math.max(...footprint(p).map(a => a[0] + a[2]))
}

export function autoLoop(p: Params): Pick<RawParams, 'lout' | 'lin' | 'lw' | 'lr' | 'pd' | 'pa'> {
  const pdv = p.tilt > 0 ? p.nz / Math.tan(p.tilt * DEG) + 2 : 0
  return {
    lout: Number((reach(p) + p.ndl / 2 + 1).toFixed(2)),
    lin: 3,
    lw: Number((Math.PI * p.Rh / p.n - 0.1).toFixed(2)),
    lr: 1.5,
    pd: Number(pdv.toFixed(1)),
    pa: Number(pdv.toFixed(1)),
  }
}

export function contactOuter(p: Params): { cu: number; cv: number } {
  return { cu: Number((reach(p) + p.ndl / 2).toFixed(2)), cv: 0 }
}

export function contactInner(p: Params): { cu: number; cv: number } {
  return { cu: Number((-(p.nd / 2 / Math.cos(p.t) + p.ndl / 2)).toFixed(2)), cv: 0 }
}

export function idealAnchors(p: Params): Anchor[] {
  const cx = p.bw / 2
  const cy = p.bh / 2
  return [1, 2, 3].map(j => {
    const i = Math.round((j - 1) * p.n / 3)
    const f = p.ang(i)
    const ur = [Math.cos(f), Math.sin(f)]
    const vt = [-ur[1], ur[0]]
    return {
      nail: i + p.ib,
      x: Number((cx + (p.Rh + p.cu) * ur[0] + p.cv * vt[0]).toFixed(3)),
      y: Number((cy + (p.Rh + p.cu) * ur[1] + p.cv * vt[1]).toFixed(3)),
    }
  })
}

export function baseFromCircle(p: Params, rc: number): number | null {
  if (!(rc > 0)) return null
  const r = Math.sqrt(Math.max(rc * rc - p.cv * p.cv, 0)) - p.cu
  return Number((r - p.nz * Math.tan(p.t)).toFixed(2))
}

export function demoSequence(ib: number): number[] {
  const a: number[] = []
  for (let k = 0; k < 90; k++) a.push((k * 37) % 270 + ib)
  return a
}

export function calibrationSequence(n: number, ib: number): number[] {
  const count = Math.max(1, n | 0)
  const a: number[] = []
  for (let k = 0; k < count; k++) a.push(ib + k)
  for (let k = count - 2; k >= 0; k--) a.push(ib + k)
  return a
}

export function startingPoint(): { raw: RawParams; anchors: Anchor[]; sequence: string } {
  const loop = autoLoop(prepare(DEFAULT_RAW))
  const withLoop = { ...DEFAULT_RAW, ...loop }
  const contact = contactOuter(prepare(withLoop))
  const raw = { ...withLoop, ...contact }
  return {
    raw,
    anchors: idealAnchors(prepare(raw)),
    sequence: demoSequence(raw.ib).join('\n'),
  }
}

export function calibrate(p: Params, anchors: Anchor[]): Calib {
  const A = anchors.map(a => ({ i: a.nail - p.ib, x: a.x, y: a.y }))
  if (!A.every(a => Number.isInteger(a.i) && a.i >= 0 && a.i < p.n)) {
    return { th: 0, tx: 0, ty: 0, res: NaN, rc: NaN, ae: [] }
  }
  const L = A.map(a => [p.Rh * Math.cos(p.ang(a.i)), p.Rh * Math.sin(p.ang(a.i))] as Vec)
  let th = 0
  let tx = 0
  let ty = 0
  let res = 0
  for (let it = 0; it < 5; it++) {
    const c = Math.cos(th)
    const s = Math.sin(th)
    const M = A.map(a => {
      const f = p.ang(a.i)
      const ox = p.cu * Math.cos(f) - p.cv * Math.sin(f)
      const oy = p.cu * Math.sin(f) + p.cv * Math.cos(f)
      return [a.x - (c * ox - s * oy), a.y - (s * ox + c * oy)] as Vec
    })
    const mean = (Q: Vec[], k: 0 | 1) => Q.reduce((u, q) => u + q[k], 0) / 3
    const lx = mean(L, 0)
    const ly = mean(L, 1)
    const mx = mean(M, 0)
    const my = mean(M, 1)
    let sa = 0
    let sd = 0
    for (let k = 0; k < 3; k++) {
      const ax = L[k][0] - lx
      const ay = L[k][1] - ly
      const bx = M[k][0] - mx
      const by = M[k][1] - my
      sa += ax * by - ay * bx
      sd += ax * bx + ay * by
    }
    th = Math.atan2(sa, sd)
    const c2 = Math.cos(th)
    const s2 = Math.sin(th)
    tx = mx - (c2 * lx - s2 * ly)
    ty = my - (s2 * lx + c2 * ly)
    res = Math.max(...L.map((l, k) => Math.hypot(c2 * l[0] - s2 * l[1] + tx - M[k][0], s2 * l[0] + c2 * l[1] + ty - M[k][1])))
  }
  let rc = NaN
  const ae: number[] = []
  {
    const [a, b, c] = A
    const dd = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
    if (Math.abs(dd) > 1e-9) {
      const q = (z: { x: number; y: number }) => z.x * z.x + z.y * z.y
      const ux = (q(a) * (b.y - c.y) + q(b) * (c.y - a.y) + q(c) * (a.y - b.y)) / dd
      const uy = (q(a) * (c.x - b.x) + q(b) * (a.x - c.x) + q(c) * (b.x - a.x)) / dd
      rc = Math.hypot(a.x - ux, a.y - uy)
      const wrap = (x: number) => ((x + 3 * Math.PI) % TAU) - Math.PI
      const an = (z: { x: number; y: number }) => Math.atan2(z.y - uy, z.x - ux)
      for (const [u, v] of [[a, b], [b, c]] as const) {
        ae.push(wrap(wrap(an(v) - an(u)) - wrap(p.ang(v.i) - p.ang(u.i))) * rc)
      }
    }
  }
  return { th: th + p.dr * DEG, tx: tx + p.dx, ty: ty + p.dy, res, rc, ae }
}

export function predict(p: Params, cal: Calib, k: number): Vec {
  const f = p.ang(k)
  const X = (p.Rh + p.cu) * Math.cos(f) - p.cv * Math.sin(f)
  const Y = (p.Rh + p.cu) * Math.sin(f) + p.cv * Math.cos(f)
  const cs = Math.cos(cal.th)
  const sn = Math.sin(cal.th)
  return [cs * X - sn * Y + cal.tx, sn * X + cs * Y + cal.ty]
}

function loopPoints(p: Params, i: number, ccw: boolean): Vec[] {
  const f = p.ang(i)
  const ur = [Math.cos(f), Math.sin(f)]
  const vt = [-ur[1], ur[0]]
  const s = ccw ? -1 : 1
  return [[-p.lin, s * p.lw], [p.lout, s * p.lw], [p.lout, -s * p.lw], [-p.lin, -s * p.lw]].map(([u, v]) => [
    (p.Rh + u) * ur[0] + v * vt[0],
    (p.Rh + u) * ur[1] + v * vt[1],
  ])
}

function pullPoints(p: Params, i: number, ccw: boolean): Vec[] {
  const f = p.ang(i)
  const ur = [Math.cos(f), Math.sin(f)]
  const vt = [-ur[1], ur[0]]
  const v1 = (ccw ? -1 : 1) * -p.lw
  const at = (u: number, v: number): Vec => [(p.Rh + u) * ur[0] + v * vt[0], (p.Rh + u) * ur[1] + v * vt[1]]
  const o: Vec[] = [at(-p.pd, v1), at(-p.pd, 0)]
  for (let k = 1; k < Math.max(1, p.pn | 0); k++) o.push(at(-p.lin, 0), at(-p.pd, 0))
  return o
}

function fillet(P: Vec[], r: number): { o: Vec[]; m: number[] } {
  const o: Vec[] = [P[0]]
  const m: number[] = [0]
  for (let i = 1; i < P.length - 1; i++) {
    const A = P[i - 1]
    const B = P[i + 1]
    const V = P[i]
    let u: Vec = [A[0] - V[0], A[1] - V[1]]
    let w: Vec = [B[0] - V[0], B[1] - V[1]]
    const d1 = Math.hypot(...u)
    const d2 = Math.hypot(...w)
    u = [u[0] / d1, u[1] / d1]
    w = [w[0] / d2, w[1] / d2]
    const al = Math.acos(Math.max(-1, Math.min(1, u[0] * w[0] + u[1] * w[1])))
    if (r <= 0 || al > Math.PI - 1e-3 || al < 1e-3) {
      o.push(V)
      m[i] = o.length - 1
      continue
    }
    const tl = Math.min(r / Math.tan(al / 2), 0.5 * Math.min(d1, d2))
    const re = tl * Math.tan(al / 2)
    const T1: Vec = [V[0] + u[0] * tl, V[1] + u[1] * tl]
    const T2: Vec = [V[0] + w[0] * tl, V[1] + w[1] * tl]
    let bx = u[0] + w[0]
    let by = u[1] + w[1]
    const bl = Math.hypot(bx, by)
    const k = re / Math.sin(al / 2)
    const C: Vec = [V[0] + bx / bl * k, V[1] + by / bl * k]
    const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0])
    let sw = Math.atan2(T2[1] - C[1], T2[0] - C[0]) - a1
    sw = (sw + 3 * Math.PI) % TAU - Math.PI
    const ns = Math.max(2, Math.ceil(Math.abs(sw) / (12 * DEG)))
    for (let j = 0; j <= ns; j++) {
      const a = a1 + sw * j / ns
      o.push([C[0] + re * Math.cos(a), C[1] + re * Math.sin(a)])
    }
    m[i] = o.length - 1
  }
  o.push(P[P.length - 1])
  m[P.length - 1] = o.length - 1
  return { o, m }
}

function foot(p: Params, k: number): Vec[] {
  const f = k * TAU / p.n
  const ur = [Math.cos(f), Math.sin(f)]
  const vt = [-ur[1], ur[0]]
  const N: Vec = [p.Rh * ur[0], p.Rh * ur[1]]
  const out: Vec[] = []
  for (const e of footprint(p)) {
    for (let j = 0; j < 48; j++) {
      const a = j / 48 * TAU
      const du = e[0] + e[2] * Math.cos(a)
      const dv = e[1] + e[3] * Math.sin(a)
      out.push([N[0] + du * ur[0] + dv * vt[0], N[1] + du * ur[1] + dv * vt[1]])
    }
  }
  return out
}

function gapCheck(p: Params, ccw: boolean): Gap {
  const s = ccw ? -1 : 1
  const P: Vec[] = [[-p.lin - 9, 0], [-p.lin, s * p.lw], [p.lout, s * p.lw], [p.lout, -s * p.lw], [-p.lin, -s * p.lw], [-p.lin - 9, 0]].map(([u, v]) => [p.Rh + u, v])
  const path = fillet(P, p.lr).o
  const footprintPts: Vec[] = []
  for (let k = -2; k <= 2; k++) footprintPts.push(...foot(p, k))
  let g = 1e9
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.4))
    for (let j = 0; j <= n; j++) {
      const x = a[0] + (b[0] - a[0]) * j / n
      const y = a[1] + (b[1] - a[1]) * j / n
      for (const q of footprintPts) {
        const d = (q[0] - x) ** 2 + (q[1] - y) ** 2
        if (d < g) g = d
      }
    }
  }
  return { gap: Math.sqrt(g) - p.ndl / 2, path, footprint: footprintPts }
}

function applyMeasurements(p: Params, cal: Calib, measured: Measurements): Pick<Plan, 'residuals' | 'offset' | 'offsetPath' | 'measuredCount'> {
  const residuals: Record<number, Vec> = {}
  const offset: Vec[] = []
  const offsetPath: Vec[] = []
  if (Number.isNaN(cal.res)) return { residuals, offset, offsetPath, measuredCount: 0 }
  const ks = Object.keys(measured).map(Number).filter(k => k >= 0 && k < p.n).sort((a, b) => a - b)
  for (const k of ks) {
    const q = predict(p, cal, k)
    const m = measured[k]
    residuals[k] = [m[0] - q[0], m[1] - q[1]]
  }
  const c = Math.cos(cal.th)
  const s = Math.sin(cal.th)
  for (let k = 0; k < p.n; k++) {
    let d: Vec = [0, 0]
    if (ks.length) {
      const j = ks.findIndex(v => v >= k)
      let a: number
      let b: number
      if (j < 0) {
        a = ks[ks.length - 1]
        b = ks[0] + p.n
      } else {
        b = ks[j]
        a = j ? ks[j - 1] : ks[ks.length - 1] - p.n
      }
      const ra = residuals[(a + p.n) % p.n]
      const rb = residuals[b % p.n]
      const t = b === a ? 0 : (k - a) / (b - a)
      d = [ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t]
    }
    offset[k] = d
    offsetPath[k] = [c * d[0] + s * d[1], -s * d[0] + c * d[1]]
  }
  return { residuals, offset, offsetPath, measuredCount: ks.length }
}

function homeArc(ex: Vec, C: Vec, Rt: number, hd: number, ha: number, of: number): Vec[] {
  {
    const L2 = ex[0] * ex[0] + ex[1] * ex[1]
    const t = L2 > 0 ? Math.max(0, Math.min(1, (C[0] * ex[0] + C[1] * ex[1]) / L2)) : 0
    if (Math.hypot(ex[0] * t - C[0], ex[1] * t - C[1]) >= Math.min(Rt, Math.hypot(ex[0] - C[0], ex[1] - C[1])) - 0.25) return []
  }
  const ta = Math.atan2(ex[1] - C[1], ex[0] - C[0])
  let best: { len: number; r: Vec[] } | null = null
  for (const t0 of [ha + of, ha - of]) {
    const sw = (ta - t0 + Math.PI + TAU * 2) % TAU - Math.PI
    const cn = Math.max(1, Math.ceil(Math.abs(sw) * Rt / 5))
    const len = hd * Math.sin(of) + Math.abs(sw) * Rt
    if (!best || len < best.len) {
      best = {
        len,
        r: Array.from({ length: cn + 1 }, (_, j) => [C[0] + Rt * Math.cos(t0 + sw * j / cn), C[1] + Rt * Math.sin(t0 + sw * j / cn)] as Vec),
      }
    }
  }
  return best ? best.r : []
}

export function computePlan(raw: RawParams, sequenceText: string, anchors: Anchor[], measured: Measurements): Plan {
  const p = prepare(raw)
  const cal = calibrate(p, anchors)
  const warnings: string[] = []
  const measuredPart = applyMeasurements(p, cal, measured)
  const rawNums = sequenceText.split(/[\s,;]+/).filter(Boolean).map(Number)
  const seq: number[] = []
  let bad = 0
  for (const v of rawNums) {
    const i = v - p.ib
    if (!Number.isInteger(i) || i < 0 || i >= p.n) bad++
    else {
      const j = (i + p.so) % p.n
      if (!seq.length || seq[seq.length - 1] !== j) seq.push(j)
    }
  }
  if (bad) warnings.push(bad + ' sequence entries are not valid nail numbers (check count and first nail number) and were skipped')
  const ccw = p.n >= 1 ? gapCheck(p, true) : { gap: NaN, path: [], footprint: [] }
  const cw = p.n >= 1 ? gapCheck(p, false) : { gap: NaN, path: [], footprint: [] }
  const gm = Math.min(ccw.gap, cw.gap)
  if (gm < p.lm) warnings.push('Needle gap to a nail or cap is ' + gm.toFixed(2) + ' mm, below your minimum ' + p.lm)
  if (p.n > 0 && p.lw > Math.PI * p.Rh / p.n) warnings.push('Half width is larger than half the nail pitch: loops of neighbouring nails overlap')
  if (Number.isNaN(cal.res)) warnings.push('Calibration nail numbers are invalid')
  else if (cal.res > 0.5) {
    warnings.push(
      'Calibration residual is ' + cal.res.toFixed(2) + ' mm'
      + (Number.isNaN(cal.rc) ? '' : '. Your 3 needle points lie on a circle of radius ' + cal.rc.toFixed(2) + ' mm, the model expects ' + (p.Rh + p.cu).toFixed(2) + ' mm (difference ' + (cal.rc - p.Rh - p.cu).toFixed(2) + ' mm). If that difference is large, set Contact offset radial to about ' + (cal.rc - p.Rh).toFixed(2) + ' (with sideways = 0), or fix tilt, needle tip height, nail base radius or machine steps/mm. Arc errors between points: ' + cal.ae.map(e => e.toFixed(2)).join(', ') + ' mm')
      + '. Otherwise re-measure, or check numbering direction and angle. If you changed the angle or direction after typing anchors, press "Reset anchors to ideal placement"',
    )
  }

  let mp: Vec[] = []
  let route: Vec[] = []
  let exit: Vec[] = []
  let vend: number[] = []
  let visits = 0
  let pullDowns = 0
  if (seq.length > 1 && !Number.isNaN(cal.res)) {
    const nails = seq.map(i => [p.Rh * Math.cos(p.ang(i)), p.Rh * Math.sin(p.ang(i))] as Vec)
    const n = seq.length
    const side = new Array<number>(n).fill(0)
    for (let i = 1; i < n - 1; i++) {
      const a = nails[i - 1]
      const b = nails[i]
      const c = nails[i + 1]
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
      side[i] = Math.abs(cr) > 1e-9 ? (cr > 0 ? 1 : -1) : 0
    }
    if (n > 2) {
      side[0] = side[1] || 1
      side[n - 1] = side[n - 2] || 1
    } else side[0] = side[1] = 1
    for (let i = 1; i < n - 1; i++) if (!side[i]) side[i] = side[i - 1] || 1
    const pts: Vec[] = []
    const ends: number[] = []
    const inward = (k: number) => {
      if (!(p.pd > 0) || k >= n - 1) return false
      const f = p.ang(seq[k])
      const ur = [Math.cos(f), Math.sin(f)]
      const pull = (j: number) => (nails[k][0] - nails[j][0]) * ur[0] + (nails[k][1] - nails[j][1]) * ur[1]
      return pull(k + 1) + (k > 0 ? pull(k - 1) : 0) < p.pa
    }
    seq.forEach((i, k) => {
      const add = (q0: Vec) => {
        const q: Vec = [q0[0] + measuredPart.offsetPath[i][0], q0[1] + measuredPart.offsetPath[i][1]]
        const last = pts[pts.length - 1]
        if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) pts.push(q)
      }
      for (const q of loopPoints(p, i, side[k] > 0)) add(q)
      if (inward(k)) {
        pullDowns++
        for (const q of pullPoints(p, i, side[k] > 0)) add(q)
      }
      ends.push(pts.length - 1)
    })
    const fl = fillet(pts, p.lr)
    const c = Math.cos(cal.th)
    const s = Math.sin(cal.th)
    const transform = (q: Vec): Vec => [c * q[0] - s * q[1] + cal.tx, s * q[0] + c * q[1] + cal.ty]
    mp = fl.o.map(transform)
    vend = ends.map(i => fl.m[i])
    visits = n
    if (mp.length >= 2) {
      const P0 = mp[0]
      const P1 = mp[1]
      const C: Vec = [cal.tx, cal.ty]
      const Rt = p.Rh + p.lout + 3
      const dl = Math.hypot(P1[0] - P0[0], P1[1] - P0[1])
      const k = Math.max(Rt - Math.hypot(P1[0] - C[0], P1[1] - C[1]), 0) + 0.001
      const ext: Vec = [P1[0] + (P1[0] - P0[0]) / dl * k, P1[1] + (P1[1] - P0[1]) / dl * k]
      const hd = Math.hypot(C[0], C[1])
      if (hd <= Rt + 1) warnings.push('Machine home (0,0) is inside the board travel circle')
      else {
        const ha = Math.atan2(-C[1], -C[0])
        const of = Math.acos(Rt / hd)
        route = [...homeArc(ext, C, Rt, hd, ha, of), ext, P0]
        const last = mp[mp.length - 1]
        const prev = mp[mp.length - 2]
        const de = Math.hypot(prev[0] - last[0], prev[1] - last[1])
        if (de > 1e-9) {
          const ke = Math.max(Rt - Math.hypot(last[0] - C[0], last[1] - C[1]), 0) + 0.001
          const out: Vec = [last[0] + (prev[0] - last[0]) / de * ke, last[1] + (prev[1] - last[1]) / de * ke]
          exit = [out, ...homeArc(out, C, Rt, hd, ha, of).slice().reverse(), [0, 0]]
        }
      }
      const all = route.concat(mp, exit)
      if (all.some(q => q[0] < 0 || q[1] < 0 || q[0] > p.bw || q[1] > p.bh)) warnings.push('Toolpath leaves the machine bed')
    }
  }
  let length = 0
  for (let i = 1; i < mp.length; i++) length += Math.hypot(mp[i][0] - mp[i - 1][0], mp[i][1] - mp[i - 1][1])
  return {
    p,
    cal,
    warnings,
    ccw,
    cw,
    mp,
    route,
    exit,
    vend,
    visits,
    pullDowns,
    length,
    ...measuredPart,
  }
}

export function polylineLength(points: Vec[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  return total
}

/** Outermost measured-or-predicted nail contact, plus margin. Centre is the calibrated ring centre. */
export function travelRadius(plan: Plan, margin: number): number {
  let m = 0
  const C: Vec = [plan.cal.tx, plan.cal.ty]
  for (let j = 0; j < plan.p.n; j++) {
    const q = predict(plan.p, plan.cal, j)
    const d = plan.offset[j] ?? [0, 0]
    m = Math.max(m, Math.hypot(q[0] + d[0] - C[0], q[1] + d[1] - C[1]))
  }
  return m + (margin || 10)
}

export function approachToNail(
  plan: Plan,
  k: number,
  current: Vec,
  clearance: number,
  margin: number,
): { ok: true; moves: Vec[]; target: Vec } | { ok: false; reason: 'inside' } {
  const p = plan.p
  const cal = plan.cal
  const C: Vec = [cal.tx, cal.ty]
  const Rt = travelRadius(plan, margin)
  const q = predict(p, cal, k)
  const d = plan.offset[k] ?? [0, 0]
  const target: Vec = [q[0] + d[0], q[1] + d[1]]
  const f = p.ang(k) + cal.th
  const cl = clearance || 0
  const approach: Vec = [target[0] + Math.cos(f) * cl, target[1] + Math.sin(f) * cl]
  const rc = Math.hypot(current[0] - C[0], current[1] - C[1])
  if (rc < p.Rh + p.cu - 4) return { ok: false, reason: 'inside' }
  const a0 = Math.atan2(current[1] - C[1], current[0] - C[0])
  const da = ((f - a0) % TAU + TAU + Math.PI) % TAU - Math.PI
  const ns = Math.max(1, Math.ceil(Math.abs(da) * Rt / 5))
  const moves: Vec[] = []
  if (rc > Rt + 0.5 || rc < Rt - 0.5) moves.push([C[0] + Rt * Math.cos(a0), C[1] + Rt * Math.sin(a0)])
  for (let j = 1; j <= ns; j++) moves.push([C[0] + Rt * Math.cos(a0 + da * j / ns), C[1] + Rt * Math.sin(a0 + da * j / ns)])
  moves.push(approach)
  return { ok: true, moves, target }
}

export function ringDirection(center: Vec, pos: Vec, name: 'out' | 'in' | 'ccw' | 'cw'): Vec {
  const r = Math.hypot(pos[0] - center[0], pos[1] - center[1]) || 1
  const u: Vec = [(pos[0] - center[0]) / r, (pos[1] - center[1]) / r]
  if (name === 'out') return u
  if (name === 'in') return [-u[0], -u[1]]
  if (name === 'ccw') return [-u[1], u[0]]
  return [u[1], -u[0]]
}

export function calibrationQueue(n: number, step: number, anchorIndexes: number[], measured: Measurements): number[] {
  const s = Math.max(1, step | 0)
  const rest: number[] = []
  for (let k = 0; k < n; k += s) if (!anchorIndexes.includes(k) && !measured[k]) rest.push(k)
  return [...anchorIndexes, ...rest].filter(k => k >= 0 && k < n)
}

export function refineQueue(n: number, residuals: Record<number, Vec>): number[] {
  const ks = Object.keys(residuals).map(Number).sort((a, b) => a - b)
  const extra: number[] = []
  ks.forEach((a, j) => {
    const b0 = ks[(j + 1) % ks.length]
    const b = b0 + (b0 <= a ? n : 0)
    const ra = residuals[a]
    const rb = residuals[b0]
    if (b - a > 1 && Math.hypot(ra[0] - rb[0], ra[1] - rb[1]) > 0.15) extra.push(Math.floor((a + b) / 2) % n)
  })
  return extra.sort((a, b) => a - b)
}

export function blockingWarning(warnings: string[]): string | undefined {
  return warnings.find(w => /leaves the machine bed|inside the board travel circle|invalid|Calibration nail numbers/.test(w))
}

export function normalizeMeasurements(raw: unknown): Measurements {
  if (!raw || typeof raw !== 'object') return {}
  const out: Measurements = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const i = Number(key)
    if (!Number.isInteger(i) || !Array.isArray(value) || value.length < 2) continue
    const x = Number(value[0])
    const y = Number(value[1])
    if (Number.isFinite(x) && Number.isFinite(y)) out[i] = [x, y]
  }
  return out
}
