/** Map controller position and SD percent onto the thread path. No DOM. */

import type { Vec } from './planner.ts'

export type Progress = {
  show: boolean
  idx: number
  path: Vec[] | null
  live: boolean
  sdRun: boolean
  pct: number
  size: number
  offs: number[]
  m0: number
  cum: number[]
  l2p: number[]
}

export type RunHint = {
  paused: boolean
  done: number
  approachLines: number
} | null

export type ProgressSample = {
  pos: Vec | null
  sd: string | null
  state: string
  streaming: boolean
  run: RunHint
  /** Current plan to adopt when an SD job appears and nothing is already live. */
  adopt: { path: Vec[]; text: string; size: number } | null
}

export function emptyProgress(): Progress {
  return {
    show: false,
    idx: 0,
    path: null,
    live: false,
    sdRun: false,
    pct: 0,
    size: 0,
    offs: [],
    m0: -1,
    cum: [],
    l2p: [],
  }
}

export function beginProgress(prev: Progress, path: Vec[], text: string, size: number): Progress {
  let o = 0
  let m0 = -1
  const offs = text.split('\n').map((line, i) => {
    o += line.length + 1
    if (m0 < 0 && line.trim() === 'M0') m0 = i
    return o
  })
  const cum = [0]
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]))
  }
  const l2p = new Array<number>(offs.length).fill(-1)
  let li = m0 + 1
  let last = ''
  for (let i = 1; i < path.length; i++) {
    const formatted = 'G53 G1 X' + path[i][0].toFixed(3) + ' Y' + path[i][1].toFixed(3)
    if (formatted !== last) {
      if (i > 1) li++
      last = formatted
    }
    l2p[li] = i
  }
  return {
    show: prev.show,
    idx: 0,
    path,
    live: true,
    sdRun: false,
    pct: 0,
    size: size || text.length,
    offs,
    m0,
    cum,
    l2p,
  }
}

export function finishProgress(pg: Progress): Progress {
  if (!pg.path?.length) return { ...pg, live: false }
  return { ...pg, live: false, idx: pg.path.length - 1 }
}

export function haltProgress(pg: Progress): Progress {
  return { ...pg, live: false }
}

function segPos(P: Vec, A: Vec, B: Vec): [number, number] {
  const dx = B[0] - A[0]
  const dy = B[1] - A[1]
  const L2 = dx * dx + dy * dy
  let t = L2 > 0 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2 : 0
  t = Math.max(0, Math.min(1, t))
  return [Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy), t]
}

function track(pg: Progress, pos: Vec, run: RunHint): Progress | null {
  const mp = pg.path
  if (!mp) return null
  const N = mp.length - 1
  if (N < 1) return null
  const mapL = (l: number) => (l <= pg.m0 ? 0 : (pg.l2p[l] > 0 ? pg.l2p[l] : N))
  let hint: number
  if (run) hint = run.paused ? 0 : mapL(pg.m0 + Math.max(0, run.done - run.approachLines))
  else {
    const bytes = pg.pct / 100 * pg.size
    let line = pg.offs.findIndex(o => o >= bytes)
    if (line < 0) line = pg.offs.length
    hint = mapL(line)
  }
  const est = hint - 17
  const recover = pg.idx > est + 150
  const lo = Math.max(0, Math.floor(est) - 100, recover ? 0 : Math.floor(pg.idx) - 1)
  const hi = Math.min(N - 1, Math.max(lo, Math.ceil(est) + 100))
  let best = -1
  let bestKey = 1e9
  let bestDist = 1e9
  let bestAny = 0
  for (let i = lo; i <= hi; i++) {
    const [dist, t] = segPos(pos, mp[i], mp[i + 1])
    const q = i + t
    if (dist < 0.8) {
      const key = Math.abs(q - est)
      if (key < bestKey) {
        bestKey = key
        best = q
      }
    } else if (dist < bestDist) {
      bestDist = dist
      bestAny = q
    }
  }
  if (best < 0 && bestDist < 3) best = bestAny
  if (best >= 0 && (best > pg.idx || recover)) return { ...pg, idx: best }
  return null
}

export function stepProgress(pg: Progress, sample: ProgressSample): Progress {
  let next = pg
  if (sample.sd != null) {
    let pct = parseFloat(sample.sd) || 0
    if (!next.sdRun) {
      if (!next.live && !sample.streaming && sample.adopt && sample.adopt.path.length) {
        next = beginProgress(next, sample.adopt.path, sample.adopt.text, sample.adopt.size)
        pct = 0
      }
      next = { ...next, pct, sdRun: true }
    } else if (pct !== next.pct) {
      next = { ...next, pct }
    }
  } else if (next.sdRun) {
    let idx = next.idx
    if (next.path && /^Idle/.test(sample.state) && next.pct >= 95) idx = next.path.length - 1
    return { ...next, sdRun: false, live: false, idx }
  }
  if (!next.live || !next.path || !sample.pos) return next
  return track(next, sample.pos, sample.run) ?? next
}

export function progressLabel(pg: Progress): string {
  if (!pg.show) return ''
  if (!pg.path) return 'no job has run yet'
  const k = Math.min(Math.floor(pg.idx), pg.path.length - 2)
  const total = pg.cum[pg.cum.length - 1] || 1
  let covered = 0
  if (k >= 0 && pg.path.length > 1) covered = pg.cum[k] + (pg.cum[k + 1] - pg.cum[k]) * (pg.idx - k)
  return (pg.live ? 'job running: ' : 'last job: ') + (covered / 1000).toFixed(2) + ' of ' + (total / 1000).toFixed(2) + ' m of thread (' + Math.round(covered / total * 100) + '%)'
}
