/** G-code text for a computed plan. No DOM. */

import type { Plan, Vec } from './planner.ts'

export function jobBaseName(value: string): string {
  return String(value || '').trim().replace(/\.(gcode|gc|nc|ngc|tap|txt)$/i, '').replace(/[^\w.-]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 60) || 'string_art'
}

export function nameKey(file: string): string {
  return String(file).replace(/^\/+/, '').toLowerCase()
}

export function boardPath(file: string): string {
  return '/' + String(file).replace(/^\/+/, '')
}

export function buildGcode(plan: Plan): string {
  const p = plan.p
  const line = (q: Vec) => `G53 G1 X${q[0].toFixed(3)} Y${q[1].toFixed(3)}`
  const rows = [
    '; String Art path, rounded loops around leaning nails',
    '; Starts at machine home (0,0), approaches and returns outside the nail ring; machine coordinates start at bottom-left (0,0)',
    '; G53 machine-coordinate moves; no Z-axis moves',
    `; Needle tip ${p.nz} mm above the ring face; nail lean ${p.tilt} deg; fillet ${p.lr} mm`,
    '; At M0, attach the thread to the first nail and resume',
    'G21',
    'G90',
    'G17',
    'G94',
    `G53 G1 X0.000 Y0.000 F${p.tf}`,
  ]
  let last = ''
  const add = (next: string) => {
    if (next !== last) {
      rows.push(next)
      last = next
    }
  }
  for (const q of plan.route) add(line(q))
  rows.push('M0')
  last = ''
  plan.mp.slice(1).forEach((q, i) => add(line(q) + (i ? '' : ` F${p.f}`)))
  if (plan.exit.length) {
    rows.push('; Leave outward along the last leg, then return to home outside the nails')
    last = ''
    plan.exit.forEach((q, i) => add(line(q) + (i ? '' : ` F${p.tf}`)))
  }
  rows.push('M2')
  return rows.join('\n') + '\n'
}

/** Motion lines split at the thread-attach pause. Comments and the final M2 are dropped. */
export function splitRun(text: string): { approach: string[]; rest: string[] } | null {
  const all = text.split('\n').map(l => l.trim()).filter(l => l && l[0] !== ';' && l !== 'M2')
  const pause = all.indexOf('M0')
  if (pause < 0) return null
  return { approach: all.slice(0, pause), rest: all.slice(pause + 1) }
}
