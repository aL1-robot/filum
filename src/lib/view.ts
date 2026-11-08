/** Board-view pan and zoom. Coordinates only. */

export type View = { s: number; ox: number; oy: number }

export function fitView(width: number, height: number, bedWidth: number, bedHeight: number): View {
  const s = Math.min(width / (bedWidth + 30), height / (bedHeight + 30))
  return {
    s,
    ox: (width - bedWidth * s) / 2,
    oy: height - (height - bedHeight * s) / 2,
  }
}

export function zoomAt(view: View, x: number, y: number, deltaY: number): View {
  const k = Math.exp(-deltaY * 0.0015)
  return {
    s: view.s * k,
    ox: x - (x - view.ox) * k,
    oy: y - (y - view.oy) * k,
  }
}

export function panBy(view: View, dx: number, dy: number): View {
  return { s: view.s, ox: view.ox + dx, oy: view.oy + dy }
}
