import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  footprint,
  predict,
  type Anchor,
  type Measurements,
  type Plan,
  type Vec,
} from './lib/planner.ts'
import { fitView, panBy, zoomAt, type View } from './lib/view.ts'
import type { Progress } from './lib/progress.ts'

type Props = {
  plan: Plan
  theme: 'light' | 'dark'
  anchors: Anchor[]
  measurements: Measurements
  machinePosition: Vec | null
  selectedNail: number | null
  progress: Progress
  showDoneOnly: boolean
  visibleVisits: number
  pickingAnchor: boolean
  fitRequest: number
  onAnchorPoint: (point: Vec) => void
  previewSidebar: ReactNode
  previewSidebarOpen: boolean
  onTogglePreviewSidebar: () => void
}

const COLORS = {
  bed: '#c7cbd4',
  label: '#6e7480',
  nail: '#6d6d68',
  path: '#ff7025',
  approach: '#1971c2',
  exit: '#9c36b5',
  measured: '#239667',
  active: '#c02960',
  machine: '#17151d',
  white: '#fff',
}

function canvasColors(canvas: HTMLCanvasElement) {
  const styles = getComputedStyle(canvas)
  return {
    ...COLORS,
    bed: styles.getPropertyValue('--canvas-bed').trim() || COLORS.bed,
    label: styles.getPropertyValue('--canvas-label').trim() || COLORS.label,
    nail: styles.getPropertyValue('--nail').trim() || COLORS.nail,
    path: styles.getPropertyValue('--accent').trim() || COLORS.path,
    approach: styles.getPropertyValue('--approach').trim() || COLORS.approach,
    exit: styles.getPropertyValue('--exit').trim() || COLORS.exit,
    measured: styles.getPropertyValue('--success').trim() || COLORS.measured,
    active: styles.getPropertyValue('--danger').trim() || COLORS.active,
    machine: styles.getPropertyValue('--canvas-machine').trim() || COLORS.machine,
  }
}

function resizeCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (!width || !height) return null
  const ratio = window.devicePixelRatio || 1
  const pixelWidth = Math.round(width * ratio)
  const pixelHeight = Math.round(height * ratio)
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return { ctx, width, height }
}

function drawPolyline(
  ctx: CanvasRenderingContext2D,
  points: Vec[],
  x: (value: number) => number,
  y: (value: number) => number,
  color: string,
  width: number,
  dash: number[] = [],
) {
  if (points.length < 2) return
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.setLineDash(dash)
  ctx.beginPath()
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(x(point[0]), y(point[1]))
    else ctx.lineTo(x(point[0]), y(point[1]))
  })
  ctx.stroke()
  ctx.setLineDash([])
}

function drawMain(
  canvas: HTMLCanvasElement,
  view: View,
  props: Props,
) {
  const dimensions = resizeCanvas(canvas)
  if (!dimensions) return
  const { ctx } = dimensions
  const colors = canvasColors(canvas)
  const { plan, anchors, measurements, machinePosition, selectedNail, progress } = props
  const x = (value: number) => view.ox + value * view.s
  const y = (value: number) => view.oy - value * view.s
  const center: Vec = [plan.cal.tx, plan.cal.ty]

  ctx.save()
  ctx.strokeStyle = colors.bed
  ctx.lineWidth = 1
  ctx.setLineDash([5, 4])
  ctx.strokeRect(x(0), y(plan.p.bh), plan.p.bw * view.s, plan.p.bh * view.s)
  ctx.setLineDash([])
  ctx.fillStyle = colors.label
  ctx.font = '12px system-ui, sans-serif'
  ctx.fillText('home (0,0)', x(0) + 5, y(0) - 6)
  ctx.beginPath()
  ctx.arc(x(0), y(0), 3, 0, Math.PI * 2)
  ctx.fill()

  if (Number.isFinite(plan.cal.res)) {
    ctx.strokeStyle = colors.bed
    for (const radius of [plan.p.rin, plan.p.rout]) {
      ctx.beginPath()
      ctx.arc(x(center[0]), y(center[1]), radius * view.s, 0, Math.PI * 2)
      ctx.stroke()
    }

    const shaft = footprint(plan.p)
    const cos = Math.cos(plan.cal.th)
    const sin = Math.sin(plan.cal.th)
    ctx.fillStyle = colors.nail
    ctx.globalAlpha = 0.18
    for (let nail = 0; nail < plan.p.n; nail++) {
      const angle = plan.p.ang(nail)
      const radial: Vec = [Math.cos(angle), Math.sin(angle)]
      const tangent: Vec = [-radial[1], radial[0]]
      const offset = plan.offset[nail] ?? [0, 0]
      for (const section of shaft) {
        const bx = (plan.p.Rh + section[0]) * radial[0] + section[1] * tangent[0]
        const by = (plan.p.Rh + section[0]) * radial[1] + section[1] * tangent[1]
        const px = cos * bx - sin * by + center[0] + offset[0]
        const py = sin * bx + cos * by + center[1] + offset[1]
        ctx.beginPath()
        ctx.ellipse(
          x(px),
          y(py),
          Math.max(section[2] * view.s, 0.35),
          Math.max(section[3] * view.s, 0.35),
          -(angle + plan.cal.th),
          0,
          Math.PI * 2,
        )
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  if (plan.route.length) drawPolyline(ctx, [[0, 0], ...plan.route], x, y, colors.approach, 1.4, [6, 4])
  if (plan.exit.length && plan.mp.length) {
    drawPolyline(ctx, [plan.mp[plan.mp.length - 1], ...plan.exit], x, y, colors.exit, 1.4, [6, 4])
  }
  if (plan.mp.length) {
    ctx.fillStyle = colors.approach
    ctx.beginPath()
    ctx.arc(x(plan.mp[0][0]), y(plan.mp[0][1]), 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillText('M0: attach thread', x(plan.mp[0][0]) + 7, y(plan.mp[0][1]) + 13)
  }

  if (props.showDoneOnly && progress.path) {
    const end = Math.max(0, Math.min(progress.idx, progress.path.length - 1))
    const index = Math.floor(end)
    const partial = progress.path.slice(0, index + 1)
    if (index < progress.path.length - 1) {
      const fraction = end - index
      const a = progress.path[index]
      const b = progress.path[index + 1]
      partial.push([a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction])
    }
    drawPolyline(ctx, partial, x, y, colors.path, 2)
  } else if (plan.mp.length && props.visibleVisits > 0) {
    const lastIndex = Math.min(plan.visits, Math.floor(props.visibleVisits)) - 1
    const end = plan.vend[lastIndex]
    if (end != null && end >= 0) {
      const start = lastIndex > 0 ? plan.vend[lastIndex - 1] : 0
      drawPolyline(ctx, plan.mp.slice(0, start + 1), x, y, colors.path, 1.2)
      drawPolyline(ctx, plan.mp.slice(start, end + 1), x, y, colors.path, 2.4)
      ctx.strokeStyle = colors.machine
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(x(plan.mp[end][0]), y(plan.mp[end][1]), Math.max(plan.p.ndl / 2 * view.s, 2), 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  for (const anchor of anchors) {
    const px = x(anchor.x)
    const py = y(anchor.y)
    ctx.strokeStyle = colors.measured
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(px - 5, py)
    ctx.lineTo(px + 5, py)
    ctx.moveTo(px, py - 5)
    ctx.lineTo(px, py + 5)
    ctx.stroke()
    ctx.fillStyle = colors.measured
    ctx.fillText(String(anchor.nail), px + 6, py - 6)
    if (measurements[anchor.nail - plan.p.ib]) {
      ctx.beginPath()
      ctx.arc(px, py, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  for (const [key, measured] of Object.entries(measurements)) {
    const nail = Number(key)
    const predicted = predict(plan.p, plan.cal, nail)
    ctx.strokeStyle = colors.measured
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x(predicted[0]), y(predicted[1]))
    ctx.lineTo(x(predicted[0] + (measured[0] - predicted[0]) * 20), y(predicted[1] + (measured[1] - predicted[1]) * 20))
    ctx.stroke()
    ctx.fillStyle = colors.measured
    ctx.beginPath()
    ctx.arc(x(measured[0]), y(measured[1]), 2.5, 0, Math.PI * 2)
    ctx.fill()
  }

  if (selectedNail != null && Number.isFinite(plan.cal.res)) {
    const predicted = predict(plan.p, plan.cal, selectedNail)
    const offset = plan.offset[selectedNail] ?? [0, 0]
    ctx.strokeStyle = colors.active
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x(predicted[0] + offset[0]), y(predicted[1] + offset[1]), 9, 0, Math.PI * 2)
    ctx.stroke()
  }
  if (machinePosition) {
    const px = x(machinePosition[0])
    const py = y(machinePosition[1])
    ctx.strokeStyle = colors.machine
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(px, py, Math.max(plan.p.ndl / 2 * view.s + 2, 5), 0, Math.PI * 2)
    ctx.moveTo(px - 9, py)
    ctx.lineTo(px + 9, py)
    ctx.moveTo(px, py - 9)
    ctx.lineTo(px, py + 9)
    ctx.stroke()
  }

  ctx.font = '12px system-ui, sans-serif'
  ctx.restore()
}

function drawLocal(canvas: HTMLCanvasElement, plan: Plan) {
  const dimensions = resizeCanvas(canvas)
  if (!dimensions) return
  const { ctx, width, height } = dimensions
  const colors = canvasColors(canvas)
  const scale = Math.min(width, height * 2.1) / 36
  const x = (value: number) => width / 2 + (value - plan.p.Rh - 2) * scale
  const y = (value: number) => height / 2 - value * scale
  ctx.save()
  ctx.fillStyle = colors.nail
  ctx.globalAlpha = 0.3
  for (const point of plan.ccw.footprint) {
    ctx.beginPath()
    ctx.arc(x(point[0]), y(point[1]), 1.4, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  drawPolyline(ctx, plan.ccw.path, x, y, colors.path, 2)
  drawPolyline(ctx, plan.cw.path, x, y, colors.approach, 2)
  ctx.restore()
}

export default function PlannerCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<View | null>(null)
  const pointer = useRef<{ x: number; y: number; dragged: boolean } | null>(null)
  const suppressClick = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => {
      setView(fitView(canvas.clientWidth, canvas.clientHeight, props.plan.p.bw, props.plan.p.bh))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()
    return () => observer.disconnect()
  }, [props.plan.p.bw, props.plan.p.bh])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    setView(fitView(canvas.clientWidth, canvas.clientHeight, props.plan.p.bw, props.plan.p.bh))
  }, [props.fitRequest, props.plan.p.bw, props.plan.p.bh])

  useEffect(() => {
    const main = canvasRef.current
    if (!main) return
    if (!view) setView(fitView(main.clientWidth, main.clientHeight, props.plan.p.bw, props.plan.p.bh))
    else drawMain(main, view, props)
  }, [props, props.theme, view])

  function fit() {
    const canvas = canvasRef.current
    if (canvas) setView(fitView(canvas.clientWidth, canvas.clientHeight, props.plan.p.bw, props.plan.p.bh))
  }

  function handleClick(event: MouseEvent<HTMLCanvasElement>) {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    if (!props.pickingAnchor || !view) return
    const bounds = event.currentTarget.getBoundingClientRect()
    props.onAnchorPoint([
      (event.clientX - bounds.left - view.ox) / view.s,
      (view.oy - (event.clientY - bounds.top)) / view.s,
    ])
  }

  return (
    <div className="canvas-layout">
      <div className={`main-canvas-wrap ${props.pickingAnchor ? 'picking' : ''} ${props.previewSidebarOpen ? 'with-preview-sidebar' : ''}`}>
        <div className="canvas-stage">
          <canvas
            ref={canvasRef}
            className="main-canvas"
            aria-label="Machine bed and generated thread path"
            title={props.pickingAnchor
              ? 'Click to place the selected calibration anchor. Drag to pan; use the mouse wheel to zoom.'
              : 'Drag to pan, use the mouse wheel to zoom, and double-click to fit the machine bed.'}
            onClick={handleClick}
            onDoubleClick={fit}
            onWheel={event => {
              if (!view) return
              const bounds = event.currentTarget.getBoundingClientRect()
              setView(zoomAt(view, event.clientX - bounds.left, event.clientY - bounds.top, event.deltaY))
            }}
            onPointerDown={event => {
              pointer.current = { x: event.clientX, y: event.clientY, dragged: false }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={event => {
              const start = pointer.current
              if (!start || !view) return
              const dx = event.clientX - start.x
              const dy = event.clientY - start.y
              if (Math.hypot(dx, dy) > 3) start.dragged = true
              if (start.dragged) {
                setView(panBy(view, dx, dy))
                pointer.current = { x: event.clientX, y: event.clientY, dragged: true }
              }
            }}
            onPointerUp={() => {
              suppressClick.current = pointer.current?.dragged ?? false
              pointer.current = null
            }}
            onPointerCancel={() => { pointer.current = null }}
          />
          {props.pickingAnchor && <span className="canvas-instruction">Click the board to place the selected anchor</span>}
          <div className="canvas-legend" aria-label="Toolpath legend">
            <span><i className="thread-line" />Thread path</span>
            <span><i className="approach-line" />Approach from home</span>
            <span><i className="exit-line" />Return to home</span>
          </div>
          <div className="canvas-zoom">
            <button title="Zoom in." aria-label="Zoom in" onClick={() => {
              const canvas = canvasRef.current
              if (canvas && view) setView(zoomAt(view, canvas.clientWidth / 2, canvas.clientHeight / 2, -1))
            }}>+</button>
            <button title="Zoom out." aria-label="Zoom out" onClick={() => {
              const canvas = canvasRef.current
              if (canvas && view) setView(zoomAt(view, canvas.clientWidth / 2, canvas.clientHeight / 2, 1))
            }}>−</button>
          </div>
        </div>
        {props.previewSidebarOpen ? (
          <aside className="preview-sidebar" aria-label="Preview details">
            <div className="preview-sidebar-header">
              <span>Preview details</span>
              <button
                title="Collapse preview details."
                aria-label="Collapse preview details"
                aria-expanded="true"
                onClick={props.onTogglePreviewSidebar}
              >›</button>
            </div>
            <div className="preview-sidebar-content">{props.previewSidebar}</div>
          </aside>
        ) : (
          <button
            className="preview-sidebar-open"
            title="Show local view and plan summary."
            aria-label="Show preview details"
            aria-expanded="false"
            onClick={props.onTogglePreviewSidebar}
          >‹ Details</button>
        )}
      </div>
    </div>
  )
}

export function PlannerLocalView({ plan }: { plan: Plan }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => drawLocal(canvas, plan)
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    draw()
    return () => observer.disconnect()
  }, [plan])

  return (
    <div className="local-view">
      <canvas ref={canvasRef} aria-label="Nail footprint and loop clearance" title="Local view of the nail footprint, neighboring nails, and loop paths." />
      <div className="local-notes">
        <div className="local-legend">
          <span className="ccw">CCW wrap</span>
          <span className="cw">CW wrap</span>
          <span>→ outward</span>
        </div>
        <p>One nail footprint, neighboring nails, and both loop directions</p>
      </div>
    </div>
  )
}
