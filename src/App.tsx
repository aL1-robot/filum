import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  FIELD_GROUPS,
  approachToNail,
  autoLoop,
  baseFromCircle,
  calibrationQueue,
  computePlan,
  contactInner,
  contactOuter,
  idealAnchors,
  normalizeMeasurements,
  prepare,
  polylineLength,
  refineQueue,
  ringDirection,
  startingPoint,
  type Anchor,
  type Measurements,
  type RawParams,
  type Vec,
} from './lib/planner.ts'
import { buildGcode, boardPath, jobBaseName, nameKey, splitRun } from './lib/gcode.ts'
import { FluidNC, type BoardFile, type FluidEvent } from './lib/fluidnc.ts'
import {
  beginProgress,
  emptyProgress,
  finishProgress,
  haltProgress,
  progressLabel,
  stepProgress,
  type Progress,
} from './lib/progress.ts'
import PlannerCanvas, { PlannerLocalView } from './PlannerCanvas.tsx'
import './App.css'

const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 5]
const INITIAL = startingPoint()
const THEME_STORAGE_KEY = 'filum-theme'
type ThemePreference = 'system' | 'light' | 'dark'
type AppMenu = 'file' | 'settings' | 'view' | 'machine' | 'help'
type AppAction = 'fit' | 'toggle-done' | 'play' | 'connect' | 'home' | 'stop'
type AppDialogView = 'settings' | 'sequence' | 'gcode' | 'boardFiles' | 'machineConfig' | 'anchors' | 'help'
type AppMenuItem = { label: string; title?: string } & (
  | { dialog: AppDialogView; action?: never }
  | { action: 'open-sequence'; dialog?: never }
  | { action: AppAction; dialog?: never }
)
type AppMenuGroup = { label: string; items: AppMenuItem[] }

function storedThemePreference(): ThemePreference {
  try {
    const preference = window.localStorage.getItem(THEME_STORAGE_KEY)
    return preference === 'system' || preference === 'light' || preference === 'dark'
      ? preference
      : 'system'
  } catch (error) {
    console.warn('Unable to read the saved Filum theme preference.', error)
    return 'system'
  }
}

const APP_MENU_GROUPS: Record<AppMenu, AppMenuGroup[]> = {
  settings: [
    { label: 'Planner', items: [{ label: 'Planner settings', dialog: 'settings' }] },
    { label: 'Machine setup', items: [
      { label: 'Machine configuration', dialog: 'machineConfig' },
      { label: 'Calibration anchors', dialog: 'anchors' },
    ] },
  ],
  file: [
    { label: 'Project', items: [
      { label: 'Open sequence…', action: 'open-sequence', title: 'Choose a .txt sequence file to load into the planner.' },
      { label: 'Nail sequence', dialog: 'sequence' },
      { label: 'G-code job', dialog: 'gcode' },
    ] },
    { label: 'Controller', items: [{ label: 'Board files', dialog: 'boardFiles' }] },
  ],
  view: [{ label: 'Toolpath', items: [
    { label: 'Fit view', action: 'fit', title: 'Fit the full machine bed in the map.' },
    { label: 'Done lines only', action: 'toggle-done', title: 'Show only thread lines the needle has finished.' },
    { label: 'Play toolpath', action: 'play', title: 'Animate the thread path from the first visit to the last.' },
  ] }],
  machine: [
    { label: 'Controller', items: [
      { label: 'Connect / disconnect', action: 'connect', title: 'Connect to or disconnect from FluidNC.' },
      { label: 'Board files', dialog: 'boardFiles' },
    ] },
    { label: 'Machine setup', items: [
      { label: 'Machine configuration', dialog: 'machineConfig' },
      { label: 'Calibration anchors', dialog: 'anchors' },
      { label: 'Home all axes', action: 'home' },
      { label: 'Stop motion', action: 'stop' },
    ] },
  ],
  help: [{ label: 'Help', items: [{
    label: 'Keyboard shortcuts and notes',
    dialog: 'help',
    title: 'Show keyboard shortcuts and map controls',
  }] }],
}

const APP_MENUS: AppMenu[] = ['file', 'settings', 'view', 'machine', 'help']

function renderMenuItems(
  menu: AppMenu,
  onSelect: (dialog: AppDialogView) => void,
  onOpenSequence: () => void,
  onAction: (action: AppAction) => void,
) {
  return APP_MENU_GROUPS[menu].map((group, groupIndex) => (
    <div className="menu-group" key={group.label}>
      {groupIndex > 0 && <div className="menu-separator" role="separator" />}
      <div className="menu-group-label">{group.label}</div>
      {group.items.map(item => (
        <button
          role="menuitem"
          key={item.dialog ?? item.action}
          title={item.title ?? `Open ${item.label.toLowerCase()}.`}
          onClick={() => {
            if (item.action === 'open-sequence') onOpenSequence()
            else if (item.action) onAction(item.action)
            else if (item.dialog) onSelect(item.dialog)
          }}
        >{item.label}</button>
      ))}
    </div>
  ))
}

function AppDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog"
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
      onClose={onClose}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <header className="dialog-header">
        <div>
          <span className="dialog-eyebrow">FILUM</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button className="dialog-close" aria-label="Close dialog" title="Close this dialog" onClick={onClose}>×</button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  )
}

function downloadText(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function formatBytes(size: number): string {
  return size >= 1048576 ? `${(size / 1048576).toFixed(2)} MB` : `${(size / 1024).toFixed(1)} KB`
}

function App() {
  const client = useMemo(() => new FluidNC(), [])
  const [theme, setTheme] = useState<ThemePreference>(storedThemePreference)
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light')
  const [raw, setRaw] = useState<RawParams>(INITIAL.raw)
  const [anchors, setAnchors] = useState<Anchor[]>(INITIAL.anchors)
  const [anchorAuto, setAnchorAuto] = useState(true)
  const [fieldGroupsOpen, setFieldGroupsOpen] = useState(() => Object.fromEntries(FIELD_GROUPS.map(group => [group.title, group.open])))
  const [activePopup, setActivePopup] = useState<AppMenu | null>(null)
  const [activeDialog, setActiveDialog] = useState<AppDialogView | null>(null)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [previewSidebarOpen, setPreviewSidebarOpen] = useState(true)
  const [pickedAnchor, setPickedAnchor] = useState<number | null>(null)
  const [sequence, setSequence] = useState(INITIAL.sequence)
  const [measurements, setMeasurements] = useState<Measurements>({})
  const [machineStatus, setMachineStatus] = useState(client.status)
  const [progress, setProgress] = useState<Progress>(emptyProgress)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [runMessage, setRunMessage] = useState('')
  const [runPaused, setRunPaused] = useState(false)
  const [runWaitingForThread, setRunWaitingForThread] = useState(false)
  const [runDone, setRunDone] = useState(0)
  const [runTotal, setRunTotal] = useState(0)
  const [address, setAddress] = useState('http://192.168.1.32/')
  const [fileName, setFileName] = useState('string_art')
  const [queue, setQueue] = useState<number[]>([])
  const [queueIndex, setQueueIndex] = useState(0)
  const [arrived, setArrived] = useState(false)
  const [acting, setActing] = useState(false)
  const [autoMove, setAutoMove] = useState(true)
  const [measureStep, setMeasureStep] = useState(9)
  const [clearance, setClearance] = useState(1.5)
  const [travelMargin, setTravelMargin] = useState(10)
  const [jogStep, setJogStep] = useState(0.25)
  const [filesKind, setFilesKind] = useState<'SD' | 'LocalFS'>('SD')
  const [files, setFiles] = useState<BoardFile[]>([])
  const [filesInfo, setFilesInfo] = useState('Connect to FluidNC to browse files')
  const [filesOpen, setFilesOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadSeconds, setUploadSeconds] = useState(0)
  const [uploadInfo, setUploadInfo] = useState('')
  const [showDoneOnly, setShowDoneOnly] = useState(false)
  const [visibleVisits, setVisibleVisits] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [previewPaused, setPreviewPaused] = useState(false)
  const [anchorPickMode, setAnchorPickMode] = useState(false)
  const [fitRequest, setFitRequest] = useState(0)
  const primaryActionRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const jogRingRef = useRef<(direction: 'out' | 'in' | 'ccw' | 'cw', shift?: boolean) => void>(() => {})

  useEffect(() => {
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const activeTheme = theme === 'system' ? (colorScheme.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = activeTheme
      setResolvedTheme(activeTheme)
    }

    applyTheme()
    if (theme !== 'system') return
    colorScheme.addEventListener('change', applyTheme)
    return () => colorScheme.removeEventListener('change', applyTheme)
  }, [theme])

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch (error) {
      console.warn('Unable to save the Filum theme preference.', error)
    }
  }, [theme])

  useEffect(() => {
    if (!mobileMenuOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [mobileMenuOpen])

  const plan = useMemo(
    () => computePlan(raw, sequence, anchors, measurements),
    [raw, sequence, anchors, measurements],
  )
  const gcode = useMemo(() => buildGcode(plan), [plan])
  const boardName = `${jobBaseName(fileName)}.gcode`
  const currentNail = queue[queueIndex]
  const measuredCount = Object.keys(plan.residuals).length
  const connected = machineStatus.connected
  const busyWithBoard = client.sdBusy() || uploading
  const boardJobActive = connected && machineStatus.sd != null
  const boardJobPaused = boardJobActive && /^Hold/.test(machineStatus.state)
  const canPauseJob = connected && ((client.running && !runPaused) || (boardJobActive && !boardJobPaused))
  const canResumeJob = connected && (runPaused || boardJobPaused)
  const anchorIndexes = anchors.map(anchor => anchor.nail - plan.p.ib)
  const allAnchorsMeasured = anchorIndexes.every(index => measurements[index] != null)

  useEffect(() => {
    const unsubscribe = client.subscribe((event: FluidEvent) => {
      setMachineStatus({ ...client.status })
      if (event.type === 'run-progress') {
        setRunDone(event.done)
        setRunTotal(event.total)
        setRunMessage(`Running: ${event.done} / ${event.total} lines acknowledged`)
      } else if (event.type === 'run-paused') {
        setRunPaused(true)
        setRunWaitingForThread(event.reason === 'thread-attachment')
        setRunMessage(event.reason === 'thread-attachment' ? 'Waiting for thread attachment' : 'Job paused')
      } else if (event.type === 'run-resumed') {
        setRunPaused(false)
        setRunWaitingForThread(false)
      } else if (event.type === 'machine-error') {
        setMessage(event.text)
        setError(true)
      }
    })
    return () => {
      unsubscribe()
      client.disconnect()
    }
  }, [client])

  useEffect(() => {
    const text = gcode
    const path = plan.mp
    const updateProgress = () => {
      const status = client.status
      setProgress(previous => stepProgress(previous, {
        pos: status.pos,
        sd: status.sd,
        state: status.state,
        streaming: client.running,
        run: client.runInfo,
        adopt: (() => {
          const currentFile = /^[\d.]+\s*,\s*(.+)$/.exec(String(status.sd ?? ''))?.[1]
          if (currentFile && nameKey(currentFile) !== nameKey(boardName)) return null
          return { path, text, size: new Blob([text]).size }
        })(),
      }))
    }
    const unsubscribe = client.subscribe(event => {
      if (event.type === 'status' || event.type === 'run-progress' || event.type === 'run-paused' || event.type === 'run-resumed') {
        updateProgress()
      }
    })
    return unsubscribe
  }, [client, gcode, plan.mp, boardName])

  useEffect(() => {
    if (!playing || plan.visits < 1) return
    const timer = window.setTimeout(() => {
      const next = (visibleVisits ?? 0) + 1
      setVisibleVisits(Math.min(next, plan.visits))
      if (next >= plan.visits) {
        setPlaying(false)
        setPreviewPaused(false)
      }
    }, 60)
    return () => window.clearTimeout(timer)
  }, [playing, visibleVisits, plan.visits])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName))) return
      if (event.key === 'Escape') {
        if (event.defaultPrevented || target instanceof HTMLElement && target.closest('dialog[open]')) return
        if (activeDialog) return
        if (activePopup || mobileMenuOpen) {
          setActivePopup(null)
          setMobileMenuOpen(false)
          return
        }
        if (client.connected) client.stop()
        setArrived(false)
        setActing(false)
        setMessage('Stopped (feed hold + reset). Check position, then Unlock if needed.')
        setError(true)
        return
      }
      if (event.key === 'Enter' && currentNail != null) {
        event.preventDefault()
        void primaryActionRef.current()
        return
      }
      const directions: Record<string, Vec> = {
        ArrowUp: [0, 1],
        ArrowDown: [0, -1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      }
      if (directions[event.key]) {
        event.preventDefault()
        client.jog(...directions[event.key], jogStep * (event.shiftKey ? 10 : 1))
      } else if (event.key === 'w' || event.key === 'W') {
        jogRingRef.current('out', event.shiftKey)
      } else if (event.key === 's' || event.key === 'S') {
        jogRingRef.current('in', event.shiftKey)
      } else if (event.key === 'a' || event.key === 'A') {
        jogRingRef.current('ccw', event.shiftKey)
      } else if (event.key === 'd' || event.key === 'D') {
        jogRingRef.current('cw', event.shiftKey)
      } else if (event.key === '[') {
        setJogStep(current => STEPS[Math.max(0, STEPS.indexOf(current) - 1)])
      } else if (event.key === ']') {
        setJogStep(current => STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(current) + 1)])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [client, currentNail, jogStep, activePopup, activeDialog, mobileMenuOpen])

  function notify(text: string, bad = false) {
    setMessage(text)
    setError(bad)
  }

  function toggleMenu(menu: AppMenu) {
    setActivePopup(current => current === menu ? null : menu)
  }

  function openDialog(dialog: AppDialogView) {
    setActiveDialog(dialog)
    setActivePopup(null)
    setMobileMenuOpen(false)
    if (dialog === 'boardFiles') {
      setFilesOpen(true)
      void refreshFiles()
    }
  }

  function openSequencePicker() {
    setActivePopup(null)
    setMobileMenuOpen(false)
    const picker = document.getElementById('sequence-file-input')
    if (!(picker instanceof HTMLInputElement)) throw new Error('Sequence file picker is not available.')
    picker.click()
  }

  function updateRaw(key: keyof RawParams, value: number | boolean) {
    applyRaw({ ...raw, [key]: value })
  }

  function applyRaw(updated: RawParams) {
    setRaw(updated)
    if (anchorAuto) setAnchors(idealAnchors(prepare(updated)))
  }

  function updateAnchor(index: number, key: keyof Anchor, value: number) {
    setAnchorAuto(false)
    setAnchors(current => current.map((anchor, i) => i === index ? { ...anchor, [key]: value } : anchor))
  }

  function setAnchorPoint(point: Vec) {
    if (pickedAnchor == null) return
    setAnchorAuto(false)
    setAnchors(current => current.map((anchor, index) => index === pickedAnchor ? { ...anchor, x: point[0], y: point[1] } : anchor))
    setPickedAnchor(null)
    setAnchorPickMode(false)
    notify(`Set anchor ${pickedAnchor + 1} to X ${point[0].toFixed(3)}, Y ${point[1].toFixed(3)}.`)
  }

  function jogRing(direction: 'out' | 'in' | 'ccw' | 'cw', shift = false) {
    if (!machineStatus.pos) return
    const vector = ringDirection([plan.cal.tx, plan.cal.ty], machineStatus.pos, direction)
    client.jog(vector[0], vector[1], jogStep * (shift ? 10 : 1))
  }

  async function connect() {
    if (connected) {
      client.disconnect()
      return
    }
    const result = await client.connect(address)
    if (result) notify(result, true)
    else notify('Connected to FluidNC.')
  }

  async function moveToNail(nail: number): Promise<boolean> {
    if (!client.connected || acting || busyWithBoard) return false
    if (!allAnchorsMeasured) {
      notify(`Manual mode: auto-move is disabled until all three anchor nails are measured. Jog to nail ${nail}, touch the cap, then press Record.`)
      return true
    }
    if (plan.p.cu <= 0) {
      notify('Auto-move assumes the needle touches the outer rim of the cap.', true)
      return false
    }
    setActing(true)
    notify(`Moving to nail ${nail}...`)
    try {
      if (!await client.settle() || !client.status.pos) {
        notify('Could not read the machine position before moving.', true)
        return false
      }
      const approach = approachToNail(plan, nail, client.status.pos, clearance, travelMargin)
      if (!approach.ok) {
        notify('Needle is inside the nail ring. Jog it outward by hand first.', true)
        return false
      }
      if (!await client.send('G90 G21')) {
        notify('FluidNC did not acknowledge the positioning mode command.', true)
        return false
      }
      for (const point of approach.moves) {
        if (!await client.send(`G53 G1 X${point[0].toFixed(3)} Y${point[1].toFixed(3)} F${plan.p.tf}`)) {
          notify('FluidNC rejected a calibration move.', true)
          return false
        }
      }
      if (!await client.send(`G53 G1 X${approach.target[0].toFixed(3)} Y${approach.target[1].toFixed(3)} F300`)) {
        notify('FluidNC rejected the final calibration move.', true)
        return false
      }
      const settled = await client.settle()
      if (!settled) notify('The controller did not settle at the calibration point.', true)
      else notify(`At nail ${nail}. Touch the cap, then press Record.`)
      return settled
    } finally {
      setActing(false)
    }
  }

  async function recordNail() {
    if (currentNail == null || !client.connected || acting) return
    setActing(true)
    try {
      if (!await client.settle() || !client.status.pos) {
        notify('Could not read the machine position. Wait for an Idle position report and try again.', true)
        return
      }
      const point: Vec = [client.status.pos[0], client.status.pos[1]]
      setMeasurements(current => ({ ...current, [currentNail]: point }))
      const anchorIndex = anchors.findIndex(anchor => anchor.nail - plan.p.ib === currentNail)
      if (anchorIndex >= 0) {
        setAnchorAuto(false)
        setAnchors(current => current.map((anchor, i) => i === anchorIndex ? { ...anchor, x: point[0], y: point[1] } : anchor))
      }
      setQueueIndex(current => current + 1)
      setArrived(false)
      notify(`Nail ${currentNail} recorded at X ${point[0].toFixed(3)}, Y ${point[1].toFixed(3)}.`)
    } finally {
      setActing(false)
    }
    if (autoMove && queue[queueIndex + 1] != null) {
      const next = queue[queueIndex + 1]
      const ok = await moveToNail(next)
      setArrived(ok)
    }
  }

  async function primaryAction() {
    if (currentNail == null || acting) return
    if (arrived) {
      await recordNail()
    } else {
      const ok = await moveToNail(currentNail)
      setArrived(ok)
    }
  }

  useEffect(() => {
    primaryActionRef.current = primaryAction
    jogRingRef.current = jogRing
  })

  function startCalibration() {
    const next = calibrationQueue(plan.p.n, measureStep, anchorIndexes, measurements)
    setQueue(next)
    setQueueIndex(0)
    setArrived(false)
    notify(`${next.length} nails queued: the three anchors first, then the remaining nails around the ring.`)
  }

  function refineCalibration() {
    const next = refineQueue(plan.p.n, plan.residuals)
    if (!next.length) {
      notify('No gaps with more than 0.15 mm disagreement: calibration looks converged.')
      return
    }
    setQueue(next)
    setQueueIndex(0)
    setArrived(false)
    notify(`${next.length} nails queued where neighboring measurements disagree.`)
  }

  async function runOnMachine() {
    if (!client.connected || acting || busyWithBoard) {
      notify('Connect to FluidNC and wait for any board operation to finish first.', true)
      return
    }
    if (!plan.mp.length || !plan.route.length) {
      notify('Nothing to run: the sequence or approach route is invalid. Check the warnings.', true)
      return
    }
    const blocking = plan.warnings.find(w => /leaves the machine bed|inside the board travel circle|invalid|Calibration nail numbers/.test(w))
    if (blocking) {
      notify(`Cannot run: ${blocking}`, true)
      return
    }
    if (!await client.settle() || !client.status.pos) {
      notify('No position from controller.', true)
      return
    }
    if (!/^Idle/.test(client.status.state)) {
      notify(`Controller is ${client.status.state}, not Idle. Unlock or reset first.`, true)
      return
    }
    if (Math.hypot(...client.status.pos) > 2) {
      notify(`Needle is at X ${client.status.pos[0].toFixed(1)} Y ${client.status.pos[1].toFixed(1)}, not at machine home (0,0). Home the machine first; the approach move must not cross the nails.`, true)
      return
    }
    if (!window.confirm(`Run ${plan.visits} nail visits (${(plan.length / 1000).toFixed(1)} m of thread, about ${(plan.length / plan.p.f).toFixed(0)} min)?\n\nThe needle moves to the ring and pauses so you can attach the thread. Stop at any time with Stop or Esc.${plan.warnings.length ? `\n\nWarnings are showing: ${plan.warnings.length}` : ''}`)) return
    const split = splitRun(gcode)
    if (!split) {
      notify('G-code has no M0 thread-attach pause.', true)
      return
    }
    setProgress(current => beginProgress(current, plan.mp, gcode, 0))
    setRunMessage('Moving to the first nail...')
    setRunDone(0)
    setRunPaused(false)
    setRunWaitingForThread(false)
    setActing(true)
    const result = await client.runGcode(split.approach, split.rest)
    setActing(false)
    setRunPaused(false)
    setRunWaitingForThread(false)
    if (result.ok) {
      setProgress(current => finishProgress(current))
      setRunMessage(`Done: ${result.lines} lines run. Needle is back at home.`)
      notify('Run complete.')
    } else {
      setProgress(current => haltProgress(current))
      setRunMessage(result.reason)
      notify(result.reason, true)
    }
  }

  async function uploadToBoard() {
    if (uploading || client.sdBusy()) return
    setUploading(true)
    setUploadSeconds(0)
    setUploadInfo(`Uploading /${boardName}...`)
    notify(`Uploading /${boardName}...`)
    try {
      const result = await client.uploadAndVerify(address, boardName, gcode, setUploadSeconds)
      if (result.kind === 'verified') {
        setUploadInfo(`Verified /${result.name} on the SD card (${formatBytes(result.size)}).`)
        notify(`Uploaded and verified /${result.name}.`)
      } else if (result.kind === 'unverified') {
        setUploadInfo(`Uploaded but not verified: connect to FluidNC and retry. ${result.detail}`)
        notify('Upload not verified: the SD card could not be checked.', true)
      } else if (result.kind === 'missing') {
        const list = result.listing.length ? ` SD card files: ${result.listing.slice(0, 6).map(file => file.name).join(', ')}.` : ' The SD listing was empty.'
        const flash = result.onFlash ? ' The file may have been written to board flash, not the SD card.' : ''
        setUploadInfo(`${result.name} was not found on the SD card.${list}${flash}`)
        notify('Upload failed: file not found on the SD card.', true)
      } else if (result.kind === 'incomplete') {
        setUploadInfo(`INCOMPLETE: ${formatBytes(result.got)} of ${formatBytes(result.size)} reached the SD card. Do not start it; upload again.`)
        notify('Upload incomplete. Do not start this file.', true)
      } else {
        setUploadInfo('Invalid FluidNC address.')
        notify('Invalid FluidNC address.', true)
      }
      if (filesOpen) await refreshFiles()
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason)
      setUploadInfo(`Upload failed: ${detail}`)
      notify(`Upload failed: ${detail}`, true)
    } finally {
      setUploading(false)
    }
  }

  async function startBoardJob(file = boardName) {
    if (!client.connected || acting || busyWithBoard) return
    if (!await client.settle() || !client.status.pos) {
      notify('No position from controller.', true)
      return
    }
    if (!/^Idle/.test(client.status.state)) {
      notify(`Controller is ${client.status.state}, not Idle. Unlock or reset first.`, true)
      return
    }
    if (Math.hypot(...client.status.pos) > 2) {
      notify('Needle is not at machine home (0,0). Home the machine first; the file starts by moving from home.', true)
      return
    }
    setMessage(`Checking /${file} on the SD card...`)
    const size = await client.fileSize(file)
    if (size == null) {
      notify('Cannot read the SD card listing.', true)
      return
    }
    if (size < 0) {
      notify(`/${file} is not on the SD card. Upload it first.`, true)
      return
    }
    const expected = new Blob([gcode]).size
    const matches = size === expected
    if (!window.confirm(`Start /${file} from the SD card (${formatBytes(size)})? The board will pause at M0 for thread attachment.${matches ? '' : `\n\nWARNING: file size differs from the current plan (${formatBytes(expected)}).`}`)) return
    if (file === boardName) {
      setProgress(current => beginProgress(current, plan.mp, gcode, size))
    }
    client.runFile(boardPath(file))
    notify(`Started /${file} on the board. It will pause at the first nail; attach the thread, then Resume.`)
    setRunMessage('Job running on board')
  }

  async function runListedFile(file: BoardFile) {
    if (nameKey(file.name) === nameKey(boardName)) {
      await startBoardJob(file.name)
      return
    }
    if (!client.connected || client.sdBusy() || client.running || acting) return
    if (!await client.settle() || !/^Idle/.test(client.status.state)) {
      notify(`Controller is ${client.status.state}, not Idle. Unlock or reset first.`, true)
      return
    }
    const locationWarning = client.status.pos && Math.hypot(...client.status.pos) > 2
      ? '\n\nThe needle is not at machine home (0,0). Home it first if this file starts from home.'
      : ''
    if (!window.confirm(`Run /${file.name} from the SD card?${locationWarning}`)) return
    client.runFile(boardPath(file.name))
    notify(`Started /${file.name} on the board.`)
    setRunMessage(`Board file running: ${file.name}`)
  }

  async function deleteBoardFile(file: BoardFile) {
    if (!client.connected || busyWithBoard || !window.confirm(`Delete /${file.name} from the SD card?`)) return
    const ok = await client.deleteFile(boardPath(file.name))
    notify(ok ? `Deleted /${file.name}.` : `Could not delete /${file.name}.`, !ok)
    await refreshFiles()
  }

  async function refreshFiles(kind: 'SD' | 'LocalFS' = filesKind) {
    if (!client.connected) {
      setFilesInfo('Connect to FluidNC to browse files')
      setFiles([])
      return
    }
    if (client.sdBusy() || uploading || client.running) {
      setFilesInfo('Busy: a job or upload is running')
      return
    }
    setFilesInfo('Loading...')
    const listed = await client.list(kind)
    if (!listed) {
      setFilesInfo(`Could not read ${kind === 'SD' ? 'the SD card (no card?)' : 'board flash'}`)
      setFiles([])
      return
    }
    const sorted = listed.slice().sort((a, b) => a.name.localeCompare(b.name))
    setFiles(sorted)
    const total = sorted.reduce((sum, item) => sum + item.size, 0)
    setFilesInfo(`${sorted.length} file${sorted.length === 1 ? '' : 's'}, ${(total / 1048576).toFixed(2)} MB${sorted.length ? '' : ' (empty)'}`)
  }

  async function home(command: '$H' | '$HX' | '$HY', label: string) {
    if (!connected || acting || busyWithBoard || client.running) return
    if (!window.confirm(`Home ${label}? The needle moves toward the limit switch${command === '$H' ? 'es' : ''}. Clear the path first.`)) return
    setActing(true)
    notify(`Homing ${label}...`)
    try {
      const ok = await client.home(command)
      if (ok) {
        await client.settle()
        notify(`Homed ${label}.`)
      } else notify(`FluidNC did not acknowledge homing ${label}.`, true)
    } finally {
      setActing(false)
    }
  }

  function importMeasurements(file?: File) {
    if (!file) return
    void file.text().then(text => {
      const data: unknown = JSON.parse(text)
      if (!data || typeof data !== 'object' || !('m' in data)) throw new Error('Not a calibration file')
      const imported = normalizeMeasurements((data as { m: unknown }).m)
      setMeasurements(imported)
      notify(`Imported ${Object.keys(imported).length} nail measurements.`)
    }).catch(reason => {
      notify(`Could not import calibration: ${reason instanceof Error ? reason.message : String(reason)}`, true)
    })
  }

  function handleSequenceFile(file?: File) {
    if (!file) return
    void file.text().then(text => {
      setSequence(text)
      setFileName(jobBaseName(file.name))
      notify(`Loaded sequence from ${file.name}.`)
    }).catch(reason => notify(`Could not read sequence file: ${String(reason)}`, true))
  }

  function updateField(key: keyof RawParams, event: React.ChangeEvent<HTMLInputElement>) {
    updateRaw(key, event.target.type === 'checkbox' ? event.target.checked : Number(event.target.value))
  }

  async function copyGcode() {
    try {
      await navigator.clipboard.writeText(gcode)
      setRunMessage('G-code copied to clipboard.')
    } catch {
      setRunMessage('Clipboard access was denied. Select and copy the G-code text below.')
    }
  }

  function stopMachine() {
    client.stop()
    setRunPaused(false)
    setRunWaitingForThread(false)
    setArrived(false)
    setActing(false)
    setProgress(current => haltProgress(current))
    notify('Stopped (feed hold + reset). Check position, then Unlock if needed.', true)
  }

  function pauseJob() {
    if (client.running) client.pauseRun()
    else client.pauseMotion()
  }

  function resumeJob() {
    if (client.running) client.resumeRun()
    else client.resumeHold()
  }

  function resetAnchors() {
    setAnchorAuto(true)
    setAnchors(idealAnchors(prepare(raw)))
    notify('Anchors reset to ideal placement.')
  }

  function fitRadiusToAnchors() {
    const base = baseFromCircle(plan.p, plan.cal.rc)
    if (base == null) {
      notify('Cannot fit the nail radius: the three anchor points do not define a circle.', true)
      return
    }
    setAnchorAuto(false)
    setRaw(current => ({ ...current, base }))
    notify(`Nail axis radius set to ${base.toFixed(2)} mm from the anchor circle.`)
  }

  function runMenuAction(action: AppAction) {
    if (action === 'fit') setFitRequest(value => value + 1)
    else if (action === 'toggle-done') setShowDoneOnly(value => !value)
    else if (action === 'play') startPreview()
    else if (action === 'connect') void connect()
    else if (action === 'home') void home('$H', 'all axes')
    else if (action === 'stop') stopMachine()
  }

  function startPreview() {
    setVisibleVisits(0)
    setPreviewPaused(false)
    setPlaying(true)
  }

  function pausePreview() {
    setPlaying(false)
    setPreviewPaused(true)
  }

  function resumePreview() {
    setPreviewPaused(false)
    setPlaying(true)
  }

  function stopPreview() {
    setPlaying(false)
    setPreviewPaused(false)
    setVisibleVisits(0)
  }

  const firstSequenceNail = sequence
    .split(/[\s,;]+/)
    .map(Number)
    .find(nail => Number.isInteger(nail) && nail >= plan.p.ib && nail < plan.p.ib + plan.p.n)
  const firstRingNail = firstSequenceNail == null
    ? null
    : ((firstSequenceNail - plan.p.ib + plan.p.so) % plan.p.n) + plan.p.ib

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <h1 aria-label="filum"><span>filum</span><span className="brand-period" aria-hidden="true">.</span></h1>
        </div>
        <nav
          className="app-menu"
          aria-label="Planner menus"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setActivePopup(null)
            }
          }}
        >
          {APP_MENUS.map(menu => (
            <div className="app-menu-entry" key={menu}>
              <button
                aria-haspopup="menu"
                aria-expanded={activePopup === menu}
                title={`Open the ${menu} menu.`}
                onClick={() => toggleMenu(menu)}
              >{menu[0].toUpperCase() + menu.slice(1)}</button>
              {activePopup === menu && (
                <div className="menu-popup" role="menu">
                  {renderMenuItems(menu, openDialog, openSequencePicker, runMenuAction)}
                </div>
              )}
            </div>
          ))}
        </nav>
        <button
          className={`hamburger-button ${mobileMenuOpen ? 'active' : ''}`}
          aria-label={mobileMenuOpen ? 'Close planner menu' : 'Open planner menu'}
          title={mobileMenuOpen ? 'Close planner navigation.' : 'Open planner navigation.'}
          aria-expanded={mobileMenuOpen}
          onClick={() => {
            setMobileMenuOpen(value => !value)
            setActivePopup(null)
          }}
        >
          <span /><span /><span />
        </button>
        <button className={`connection-pill ${connected ? 'connected' : ''}`} title={connected ? `Connected to FluidNC: ${machineStatus.state}. Click to disconnect.` : 'Not connected to FluidNC. Click to connect.'} onClick={() => void connect()}>
          <i />
          {connected ? machineStatus.state : 'Connect'}
        </button>
        <button className="top-stop-button" title="Stop motion and reset the controller." disabled={!connected} onClick={stopMachine}>■ <span>Stop</span></button>
      </header>
      {mobileMenuOpen && (
        <div className="mobile-menu-backdrop" onClick={() => { setMobileMenuOpen(false); setActivePopup(null) }}>
          <nav
            className="mobile-menu"
            role="menu"
            aria-label="Planner navigation"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setActivePopup(null)
                setMobileMenuOpen(false)
              }
            }}
          >
            <div className="mobile-menu-header">
              <span className="mobile-menu-brand">filum<span>.</span></span>
              <button
                className="mobile-menu-close"
                aria-label="Close planner menu"
                title="Close planner navigation."
                onClick={() => { setMobileMenuOpen(false); setActivePopup(null) }}
              >×</button>
            </div>
            {APP_MENUS.map(menu => (
              <section className="mobile-menu-section" key={menu}>
                <button
                  className="mobile-menu-section-toggle"
                  aria-expanded={activePopup === menu}
                  title={`${activePopup === menu ? 'Hide' : 'Show'} ${menu} commands.`}
                  onClick={() => toggleMenu(menu)}
                >
                  <span>{menu[0].toUpperCase() + menu.slice(1)}</span>
                  <span className="mobile-menu-chevron" aria-hidden="true">{activePopup === menu ? '▴' : '▾'}</span>
                </button>
                {activePopup === menu && <div className="mobile-menu-items" role="menu">{renderMenuItems(menu, openDialog, openSequencePicker, runMenuAction)}</div>}
              </section>
            ))}
          </nav>
        </div>
      )}
      <input
        id="sequence-file-input"
        className="sr-only"
        type="file"
        aria-label="Open sequence file"
        title="Choose a .txt file containing the nail visit sequence."
        accept=".txt"
        onChange={event => {
          handleSequenceFile(event.currentTarget.files?.[0])
          event.currentTarget.value = ''
        }}
      />

      <main className="workspace" onClick={() => setActivePopup(null)}>
        <section className="planner-column">
          <section className="planner-panel">
            <div className="section-heading">
              <h2 className="sr-only">Toolpath</h2>
              <div className="inline-actions">
                <button title="Fit the full machine bed in the map. Double-click the map for the same action." onClick={() => setFitRequest(value => value + 1)}>Fit view</button>
                <button title="During a run, show only thread lines the needle has finished." onClick={() => setShowDoneOnly(value => !value)} className={showDoneOnly ? 'selected' : ''}>Done lines only</button>
                <span className="progress-label">{progressLabel({ ...progress, show: showDoneOnly })}</span>
                <input
                  type="range"
                  title="Scrub through the nail visits to reveal the toolpath up to that point."
                  min={0}
                  max={plan.visits}
                  value={visibleVisits == null ? plan.visits : Math.min(visibleVisits, plan.visits)}
                  onChange={event => {
                    setPlaying(false)
                    setPreviewPaused(false)
                    setVisibleVisits(Number(event.target.value))
                  }}
                />
                <span className="visit-count">{visibleVisits == null ? plan.visits : Math.min(visibleVisits, plan.visits)} / {plan.visits}</span>
                {playing ? (
                  <button title="Pause the preview animation." onClick={pausePreview}>Ⅱ Pause</button>
                ) : previewPaused ? (
                  <button title="Resume the preview animation from the current visit." onClick={resumePreview}>▶ Resume</button>
                ) : (
                  <button title="Animate the thread path from the first visit to the last." onClick={startPreview}>▶ Play</button>
                )}
                {(playing || previewPaused) && (
                  <button title="Stop the preview animation and return to the beginning." onClick={stopPreview}>■ Stop</button>
                )}
              </div>
            </div>
            <PlannerCanvas
              plan={plan}
              theme={resolvedTheme}
              anchors={anchors}
              measurements={measurements}
              machinePosition={machineStatus.pos}
              selectedNail={currentNail ?? null}
              progress={progress}
              showDoneOnly={showDoneOnly}
              visibleVisits={visibleVisits == null ? plan.visits : Math.min(visibleVisits, plan.visits)}
              onAnchorPoint={setAnchorPoint}
              pickingAnchor={anchorPickMode}
              fitRequest={fitRequest}
              previewSidebarOpen={previewSidebarOpen}
              onTogglePreviewSidebar={() => setPreviewSidebarOpen(open => !open)}
              previewSidebar={
                <>
                  <section className="summary-section local-summary">
                    <h2>Local view</h2>
                    <PlannerLocalView plan={plan} />
                  </section>
                  <section className="summary-section">
                    {plan.warnings.length > 0 && (
                      <div className="warnings">{plan.warnings.map((warning, index) => <p key={index}>⚠ {warning}</p>)}</div>
                    )}
                    <h2>Plan summary</h2>
                    <div className="plan-summary">
                      <p><b>{plan.visits}</b> nail visits, thread path <b>{(plan.length / 1000).toFixed(1)} m</b>, about <b>{(plan.length / plan.p.f).toFixed(0)} min</b> at {plan.p.f} mm/min</p>
                      <p>Pull-down moves: <b>{plan.pullDowns}</b> of {plan.visits} visits{plan.pullDowns === 0 ? ' (thread would lie too tangential to slide down the nail)' : ''}</p>
                      <p>Nail ring at needle height: {plan.p.Rh.toFixed(2)} mm radius; pitch {(2 * plan.p.Rh * Math.sin(Math.PI / plan.p.n)).toFixed(2)} mm</p>
                      {firstSequenceNail != null && firstRingNail != null && (
                        <p>Sequence file nail {firstSequenceNail} is mounted on ring nail {firstRingNail} (file nail {firstSequenceNail} lands at {(((plan.p.ang(firstRingNail - plan.p.ib) * 180 / Math.PI + 540) % 360) - 180).toFixed(2)}°)</p>
                      )}
                      <p>Calibration residual: <b>{Number.isNaN(plan.cal.res) ? 'n/a' : `${plan.cal.res.toFixed(2)} mm`}</b></p>
                      <p>Anchor circle radius {Number.isNaN(plan.cal.rc) ? 'n/a' : `${plan.cal.rc.toFixed(2)} mm`} vs expected {(plan.p.Rh + plan.p.cu).toFixed(2)} mm</p>
                      <p>Needle gap to nails, CCW loop <b>{plan.ccw.gap.toFixed(2)} mm</b>, CW loop <b>{plan.cw.gap.toFixed(2)} mm</b></p>
                      <p>Outer track radius {(plan.p.Rh + plan.p.lout + 3).toFixed(2)} mm, inner {(plan.p.Rh - plan.p.lin).toFixed(2)} mm</p>
                      <p>Approach from home <b>{(polylineLength([[0, 0], ...plan.route]) / 1000).toFixed(2)} m</b> (pauses at M0 for thread), return to home <b>{(polylineLength(plan.exit) / 1000).toFixed(2)} m</b></p>
                      <p>{measuredCount} nails measured</p>
                    </div>
                  </section>
                </>
              }
            />
          </section>

        </section>

        <aside className="control-column">
          <section className="connection-panel">
            <h2>Nail calibration &amp; FluidNC</h2>
            <div className="connect-row">
              <input value={address} aria-label="FluidNC address" title="FluidNC web address, for example http://192.168.1.32/." onChange={event => setAddress(event.target.value)} />
              <button title={connected ? 'Disconnect from the FluidNC controller.' : 'Connect to the FluidNC controller at the address above.'} onClick={() => void connect()}>{connected ? 'Disconnect' : 'Connect'}</button>
            </div>
            <p className="controller-status">
              {connected ? `${machineStatus.state} · X ${machineStatus.pos?.[0].toFixed(3) ?? '-'} · Y ${machineStatus.pos?.[1].toFixed(3) ?? '-'} · ${measuredCount} nails measured` : `Not connected · ${measuredCount} nails measured`}
              {machineStatus.sd != null && ` · SD job ${parseFloat(machineStatus.sd) || 0}%`}
            </p>
            <div className="calibration-settings">
              <label>Measure every <input type="number" title="Measure one nail after each group of this many nails." min={1} value={measureStep} onChange={event => setMeasureStep(Math.max(1, Number(event.target.value) | 0))} /> nails</label>
              <label>Approach clearance <input type="number" title="Keep this distance from the nail before making the final approach." min={0} step={0.5} value={clearance} onChange={event => setClearance(Number(event.target.value))} /> mm</label>
              <label>Travel margin <input type="number" title="Extra clearance used while moving between nails." min={3} step={1} value={travelMargin} onChange={event => setTravelMargin(Number(event.target.value))} /> mm</label>
              <label className="check-inline"><input type="checkbox" title="Automatically move to the next nail after recording a measurement." checked={autoMove} onChange={event => setAutoMove(event.target.checked)} /> auto-move to next</label>
              <button title="Create a calibration route using the configured measurement interval." onClick={startCalibration}>Start plan</button>
              <button title="Refine the calibration route using recorded nail measurements." disabled={measuredCount === 0} onClick={refineCalibration}>Refine</button>
            </div>
            <div className="queue-progress"><i style={{ width: `${queue.length ? Math.min(queueIndex, queue.length) / queue.length * 100 : 0}%` }} /></div>
            <div className="calibration-actions">
              <button className="primary" title={arrived ? 'Record the current nail measurement and continue.' : 'Move the needle to the selected nail. Press Enter to move or record.'} disabled={!connected || currentNail == null || acting || busyWithBoard} onClick={() => void primaryAction()}>
                {currentNail == null ? (queue.length ? 'Plan complete' : 'Start a plan') : acting ? 'Moving…' : arrived ? `Record nail ${currentNail}` : `Go to nail ${currentNail}`}
              </button>
              <button title="Select the previous nail in the calibration route." disabled={currentNail == null} onClick={() => { setQueueIndex(index => Math.max(0, index - 1)); setArrived(false) }}>◀ Back</button>
              <button title="Skip this nail and select the next one." disabled={currentNail == null} onClick={() => { setQueueIndex(index => Math.min(queue.length, index + 1)); setArrived(false) }}>Skip ▶</button>
              <button title="Move away from the nail along the ring's outward direction." disabled={!connected || !machineStatus.pos} onClick={() => {
                if (!machineStatus.pos) return
                const direction = ringDirection([plan.cal.tx, plan.cal.ty], machineStatus.pos, 'out')
                client.jog(direction[0], direction[1], 3)
              }}>Back off</button>
              <button className="danger" title="Send feed hold and reset to stop machine motion." disabled={!connected} onClick={stopMachine}>■ Stop</button>
              <button title="Unlock the FluidNC controller after an alarm or reset." disabled={!connected} onClick={() => void client.unlock()}>Unlock</button>
            </div>
            <div className="home-actions">
              <span>Home:</span>
              <button title="Home both X and Y axes." disabled={!connected || acting || busyWithBoard} onClick={() => void home('$H', 'all axes')}>All axes</button>
              <button title="Home the X axis." disabled={!connected || acting || busyWithBoard} onClick={() => void home('$HX', 'X')}>X</button>
              <button title="Home the Y axis." disabled={!connected || acting || busyWithBoard} onClick={() => void home('$HY', 'Y')}>Y</button>
            </div>
            <div className="jog-controls" title="Use the arrow keys to jog XY, W/S to jog out/in, A/D to jog around the ring, Shift for 10× movement, and [ or ] to change the step.">
              <div className="step-buttons"><span>Jog step</span>{STEPS.map(step => (
                <button className={jogStep === step ? 'selected' : ''} title={`Set the jog increment to ${step} mm.`} key={step} onClick={() => setJogStep(step)}>{step}</button>
              ))}</div>
              <div className="jog-layout">
                <span>XY</span>
                <div className="jog-pad">
                  <i /><button title={`Jog Y positive by ${jogStep} mm.`} aria-label="Jog Y positive" onClick={() => client.jog(0, 1, jogStep)}>▲</button><i />
                  <button title={`Jog X negative by ${jogStep} mm.`} aria-label="Jog X negative" onClick={() => client.jog(-1, 0, jogStep)}>◀</button><i /><button title={`Jog X positive by ${jogStep} mm.`} aria-label="Jog X positive" onClick={() => client.jog(1, 0, jogStep)}>▶</button>
                  <i /><button title={`Jog Y negative by ${jogStep} mm.`} aria-label="Jog Y negative" onClick={() => client.jog(0, -1, jogStep)}>▼</button><i />
                </div>
                <span>Ring</span>
                <div className="jog-pad">
                  <button title="Jog counterclockwise along the ring." aria-label="Jog ring counterclockwise" onClick={() => jogRing('ccw')}>↺</button><button title="Jog outward from the ring center." onClick={() => jogRing('out')}>Out</button><button title="Jog clockwise along the ring." aria-label="Jog ring clockwise" onClick={() => jogRing('cw')}>↻</button>
                  <i /><button title="Jog inward toward the ring center." onClick={() => jogRing('in')}>In</button><i />
                </div>
              </div>
            </div>
            <div className="inline-actions calibration-files">
              <button title="Download the recorded nail positions as a JSON calibration file." onClick={() => downloadText(JSON.stringify({ n: plan.p.n, ib: plan.p.ib, m: measurements }, null, 2), 'nail_calibration.json', 'application/json')}>Export calibration</button>
              <label className="file-button" title="Load nail positions from a JSON calibration file.">Import<input type="file" title="Choose a JSON file containing saved nail measurements." accept=".json,application/json" onChange={event => importMeasurements(event.target.files?.[0])} /></label>
              <button className="danger" title="Delete all saved nail measurements." onClick={() => {
                if (!window.confirm('Delete all recorded nail positions?')) return
                setMeasurements({})
                notify('Cleared calibration measurements.')
              }}>Clear all</button>
            </div>
            <p className={`message ${error ? 'error' : ''}`} role="status">{message}</p>
            <p className="keyboard-hint">Enter go / record · arrows jog XY · W/S radial · A/D along ring · Shift ×10 · [ ] step · Esc stop</p>
          </section>
        </aside>
      </main>
      <footer className="jobbar" aria-label="Job controls">
        <div className="job-group">
          <button title="Download the generated toolpath as a G-code file." onClick={() => downloadText(gcode, boardName, 'text/plain')}>Save G-code</button>
          <button title="Copy the generated G-code to the clipboard." onClick={() => void copyGcode()}>Copy G-code</button>
        </div>
        <div className="job-transport">
          <button className="primary" title="Stream the generated toolpath directly to FluidNC. The machine must be connected and homed." disabled={!connected || acting || client.running || busyWithBoard || !plan.route.length} onClick={() => void runOnMachine()}>▶ Run on machine</button>
          <button title="Pause the active FluidNC job with feed hold." disabled={!canPauseJob} onClick={pauseJob}>Ⅱ Pause job</button>
          <button className="primary" title={runWaitingForThread ? 'Attach the thread at the first nail, then continue the streamed toolpath.' : 'Resume the paused or held job on FluidNC.'} disabled={!canResumeJob} onClick={resumeJob}>{runWaitingForThread ? 'Thread attached: Resume' : '▶ Resume job'}</button>
          <button className="danger" title="Stop motion and reset the controller." disabled={!connected} onClick={stopMachine}>■ Stop</button>
        </div>
        <div className="job-group">
          <label className="board-name">Board job<input title="Base filename to use when saving or uploading this job." value={fileName} onChange={event => setFileName(event.target.value)} /><span>.gcode</span></label>
          <button className="primary" title="Upload the generated G-code to the controller's SD card." disabled={!plan.mp.length || uploading || busyWithBoard || client.running} onClick={() => void uploadToBoard()}>{uploading ? 'Uploading…' : '⬆ Upload to SD'}</button>
          <button className="primary" title="Start the selected uploaded job on the controller." disabled={!connected || acting || busyWithBoard || client.running} onClick={() => void startBoardJob()}>▶ Start job on board</button>
        </div>
        {(runMessage || uploadInfo || uploading) && (
          <div className="job-progress" role="status" aria-live="polite">
            {runMessage && <span>{runMessage}{runTotal > 0 ? ` (${runDone}/${runTotal})` : ''}</span>}
            {uploadInfo && <span>{uploadInfo}</span>}
            {uploading && <span>Uploading… {uploadSeconds}s</span>}
            {uploading && <div className="progress-track"><i className="indeterminate" /></div>}
          </div>
        )}
      </footer>
      <AppDialog open={activeDialog === 'settings'} title="Planner settings" onClose={() => setActiveDialog(null)}>
        <div className="settings-dialog-content">
          <div className="appearance-settings">
            <label>
              <span>Appearance</span>
              <select title="Choose a light or dark appearance, or follow your operating system setting." value={theme} onChange={event => setTheme(event.target.value as ThemePreference)}>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </select>
            </label>
          </div>
          {FIELD_GROUPS.filter(group => group.title !== 'Machine and nudge').map(group => (
            <details
              key={group.title}
              open={fieldGroupsOpen[group.title]}
              className="field-group"
              onToggle={event => {
                const open = event.currentTarget.open
                setFieldGroupsOpen(current => current[group.title] === open ? current : { ...current, [group.title]: open })
              }}
            >
              <summary title={`Show or hide ${group.title.toLowerCase()} settings.`}>{group.title}</summary>
              <div className="field-grid">
                {group.fields.map(field => (
                  <label key={field.key} className={field.check ? 'check-field' : 'number-field'}>
                    <span>{field.label}</span>
                    <input
                      type={field.check ? 'checkbox' : 'number'}
                      title={field.title}
                      step={field.check ? undefined : 'any'}
                      min={field.key === 'n' ? 3 : undefined}
                      value={field.check ? undefined : Number(raw[field.key])}
                      checked={field.check ? Boolean(raw[field.key]) : undefined}
                      onChange={event => updateField(field.key, event)}
                    />
                  </label>
                ))}
              </div>
              {group.kind === 'loop' && (
                <button className="subtle-button" title="Calculate loop depths and widths from the current nail and needle geometry." onClick={() => applyRaw({ ...raw, ...autoLoop(prepare(raw)) })}>
                  Set loop values automatically
                </button>
              )}
              {group.kind === 'contact' && (
                <div className="inline-actions">
                  <button className="subtle-button" title="Set the contact offset for the needle touching the outside edge of the nail cap." onClick={() => applyRaw({ ...raw, ...contactOuter(plan.p) })}>Contact = cap rim</button>
                  <button className="subtle-button" title="Set the contact offset for the needle touching the inner side of the nail shaft." onClick={() => applyRaw({ ...raw, ...contactInner(plan.p) })}>Contact = inner shaft</button>
                </div>
              )}
            </details>
          ))}
        </div>
      </AppDialog>
      <AppDialog
        open={activeDialog === 'sequence' || activeDialog === 'gcode' || activeDialog === 'boardFiles'}
        title={activeDialog === 'sequence' ? 'Nail sequence' : activeDialog === 'gcode' ? 'G-code job' : 'Board files'}
        onClose={() => setActiveDialog(null)}
      >
        <div className="files-dialog-content">
          <section className="dialog-section sequence-dialog-content" hidden={activeDialog !== 'sequence'}>
            <div className="dialog-section-heading">
              <div>
                <h3>Nail sequence</h3>
                <p>Load or edit the nail visit order used to generate this job.</p>
              </div>
              <button title="Load a nail visit sequence from a .txt file." onClick={openSequencePicker}>Load sequence</button>
            </div>
            <div className="inline-actions">
              <button onClick={() => {
                setFileName('demo')
                setSequence(Array.from({ length: 90 }, (_, k) => (k * 37) % raw.n + raw.ib).join('\n'))
              }} title="Replace the current sequence with a sample string-art pattern.">Generate demo</button>
              <button onClick={() => {
                const values = [...Array.from({ length: Math.max(1, raw.n | 0) }, (_, k) => raw.ib + k), ...Array.from({ length: Math.max(0, (raw.n | 0) - 1) }, (_, k) => raw.ib + raw.n - 2 - k)]
                setFileName('calibration')
                setSequence(values.join('\n'))
                notify(`Calibration sequence: ${values.length} visits (${raw.n} nails there and back).`)
              }} title="Create a sequence that visits every nail in order, then returns across the ring.">Calibration pattern</button>
              <span className="sequence-count">{sequence.split(/[\s,;]+/).filter(Boolean).length} entries</span>
            </div>
            <textarea aria-label="Nail sequence" title="Edit the nail visit order. Separate nail numbers with spaces, commas, semicolons, or new lines." value={sequence} onChange={event => setSequence(event.target.value)} />
            <p className="hint">Enter nail numbers separated by spaces, commas, or new lines. Invalid nail numbers are skipped.</p>
          </section>
          <section className="dialog-section file-job-section" hidden={activeDialog !== 'gcode'}>
            <div className="dialog-section-heading">
              <div>
                <h3>G-code job</h3>
                <p>Save locally, copy, or transfer the generated job to FluidNC.</p>
              </div>
              <span className="machine-coordinate">
                {machineStatus.pos ? `X ${machineStatus.pos[0].toFixed(3)} · Y ${machineStatus.pos[1].toFixed(3)}` : 'Position unavailable'}
              </span>
            </div>
            <div className="machine-actions">
              <p className="hint">Use the persistent job controls at the bottom of the window to start, pause, resume, stop, or transfer this job.</p>
            </div>
            <details className="gcode-details">
              <summary title="Expand to inspect the generated G-code.">G-code text</summary>
              <textarea readOnly title="Generated G-code for the current toolpath. This preview is read-only." value={gcode} />
            </details>
          </section>
          <section className="dialog-section board-files-section" hidden={activeDialog !== 'boardFiles'}>
            <div className="dialog-section-heading">
              <div><h3>FluidNC files</h3><p>Browse files stored on the controller.</p></div>
              <button title={`Refresh the ${filesKind === 'SD' ? 'SD card' : 'controller flash'} file list.`} onClick={() => void refreshFiles()}>Refresh</button>
            </div>
            <div className="files-toolbar">
              <button title="Browse files stored on the controller's SD card." className={filesKind === 'SD' ? 'selected' : ''} onClick={() => { setFilesKind('SD'); setFiles([]); void refreshFiles('SD') }}>SD card</button>
              <button title="Browse controller flash files. These files are read-only." className={filesKind === 'LocalFS' ? 'selected' : ''} onClick={() => { setFilesKind('LocalFS'); setFiles([]); void refreshFiles('LocalFS') }}>Flash</button>
            </div>
            <p className="hint">{filesInfo}</p>
            <div className="file-list">
              {files.map(file => {
                const current = file.name.replace(/^\/+/, '').toLowerCase() === boardName.toLowerCase()
                const matches = file.size === new Blob([gcode]).size
                return (
                  <div className={`file-row ${current ? 'current' : ''}`} key={file.name}>
                    <span title={file.name}>{boardPath(file.name)}</span>
                    <small>{formatBytes(file.size)}</small>
                    {current && filesKind === 'SD' && <small>{matches ? '✓ plan' : '≠ plan'}</small>}
                    {filesKind === 'SD' && <>
                      <button title={`Run ${boardPath(file.name)} from the SD card.`} onClick={() => void runListedFile(file)}>Run</button>
                      <button className="danger" title={`Delete ${boardPath(file.name)} from the SD card.`} onClick={() => void deleteBoardFile(file)}>Delete</button>
                    </>}
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      </AppDialog>
      <AppDialog
        open={activeDialog === 'machineConfig' || activeDialog === 'anchors'}
        title={activeDialog === 'machineConfig' ? 'Machine configuration' : 'Calibration anchors'}
        onClose={() => setActiveDialog(null)}
      >
        <div className="machine-dialog-content">
          <section className="dialog-section machine-config-section" hidden={activeDialog !== 'machineConfig'}>
            <div className="dialog-section-heading">
              <div><h3>Machine configuration</h3><p>Set the planner's machine geometry and movement calibration.</p></div>
            </div>
            {FIELD_GROUPS.filter(group => group.title === 'Machine and nudge').map(group => (
              <details
                key={group.title}
                open={fieldGroupsOpen[group.title]}
                className="field-group"
                onToggle={event => {
                  const open = event.currentTarget.open
                  setFieldGroupsOpen(current => current[group.title] === open ? current : { ...current, [group.title]: open })
                }}
              >
                <summary title={`Show or hide ${group.title.toLowerCase()} settings.`}>{group.title}</summary>
                <div className="field-grid">
                  {group.fields.map(field => (
                    <label key={field.key} className={field.check ? 'check-field' : 'number-field'}>
                      <span>{field.label}</span>
                      <input
                        type={field.check ? 'checkbox' : 'number'}
                        title={field.title}
                        step={field.check ? undefined : 'any'}
                        min={field.key === 'n' ? 3 : undefined}
                        value={field.check ? undefined : Number(raw[field.key])}
                        checked={field.check ? Boolean(raw[field.key]) : undefined}
                        onChange={event => updateField(field.key, event)}
                      />
                    </label>
                  ))}
                </div>
              </details>
            ))}
          </section>
          <section className="dialog-section calibration-dialog-content" hidden={activeDialog !== 'anchors'}>
            <div className="dialog-section-heading">
              <div><h3>Calibration anchors</h3><p>Measure three nails or enter machine coordinates. Use Map to set an anchor from the plan view.</p></div>
              <span className={`calibration-count ${measuredCount >= 3 ? 'complete' : ''}`}>{measuredCount} measured</span>
            </div>
            <div className="anchor-table">
              <div className="anchor-row anchor-heading"><span>Anchor</span><span>Nail #</span><span>X (mm)</span><span>Y (mm)</span><span>Pick</span></div>
              {anchors.map((anchor, index) => (
                <div className="anchor-row" key={index}>
                  <span>{index + 1}</span>
                  {(['nail', 'x', 'y'] as const).map(key => (
                    <input key={key} type="number" step="any" value={anchor[key]} aria-label={`Anchor ${index + 1} ${key}`} title={key === 'nail' ? `Nail number associated with calibration anchor ${index + 1}.` : `Measured ${key.toUpperCase()} machine coordinate for calibration anchor ${index + 1}, in millimeters.`} onChange={event => updateAnchor(index, key, Number(event.target.value))} />
                  ))}
                  <button
                    className={pickedAnchor === index ? 'selected' : ''}
                    aria-label={`Set anchor ${index + 1} from map`}
                    title={`Pick anchor ${index + 1} by clicking its location on the toolpath map.`}
                    onClick={() => {
                      setPickedAnchor(index)
                      setAnchorPickMode(true)
                      setActiveDialog(null)
                      notify(`Click the map to place anchor ${index + 1}.`)
                    }}
                  >Map</button>
                </div>
              ))}
            </div>
            <div className="inline-actions">
              <button title="Move the three anchors back to their calculated ideal locations." onClick={resetAnchors}>Reset anchors to ideal</button>
              <button title="Calculate and apply the nail axis radius from the measured anchor circle." onClick={fitRadiusToAnchors}>Set nail radius from anchors</button>
              <button title="Download the recorded nail positions as a JSON calibration file." onClick={() => downloadText(JSON.stringify({ n: plan.p.n, ib: plan.p.ib, m: measurements }, null, 2), 'nail_calibration.json', 'application/json')}>Export measurements</button>
              <label className="file-button" title="Load nail positions from a JSON calibration file.">Import measurements<input type="file" title="Choose a JSON file containing saved nail measurements." accept=".json,application/json" onChange={event => importMeasurements(event.target.files?.[0])} /></label>
              <button className="danger" title="Delete all saved nail measurements." onClick={() => {
                if (!window.confirm('Delete all recorded nail positions?')) return
                setMeasurements({})
                notify('Cleared calibration measurements.')
              }}>Clear measurements</button>
            </div>
            <p className="calibration-result">
              Fit residual: <b>{Number.isNaN(plan.cal.res) ? 'n/a' : `${plan.cal.res.toFixed(2)} mm`}</b>
              {plan.cal.rc > 0 && <> · Anchor circle: <b>{plan.cal.rc.toFixed(2)} mm</b></>}
            </p>
          </section>
        </div>
      </AppDialog>
      <AppDialog open={activeDialog === 'help'} title="Keyboard shortcuts and notes" onClose={() => setActiveDialog(null)}>
        <div className="help-dialog-content">
          <p>Use these shortcuts when the focus is not in a text or number field.</p>
          <table>
            <tbody>
              <tr><th><kbd>Enter</kbd></th><td>Move to the selected nail, then record its measurement.</td></tr>
              <tr><th><kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd></th><td>Jog the machine in X and Y.</td></tr>
              <tr><th><kbd>W</kbd> <kbd>S</kbd></th><td>Jog outward or inward along the ring.</td></tr>
              <tr><th><kbd>A</kbd> <kbd>D</kbd></th><td>Jog counterclockwise or clockwise along the ring.</td></tr>
              <tr><th><kbd>Shift</kbd></th><td>Multiply keyboard jog distance by 10.</td></tr>
              <tr><th><kbd>[</kbd> <kbd>]</kbd></th><td>Select a smaller or larger jog increment.</td></tr>
              <tr><th><kbd>Esc</kbd></th><td>Close an open menu or dialog; otherwise stop machine motion.</td></tr>
            </tbody>
          </table>
          <h3>Map controls</h3>
          <ul>
            <li>Drag to pan; use the mouse wheel to zoom around the pointer.</li>
            <li>Double-click the map or select <b>Fit view</b> to fit the machine bed.</li>
            <li>When placing an anchor, click the map to set its position.</li>
            <li>Green marks show calibration anchors and measured nail offsets.</li>
          </ul>
          <p className="hint">Only use machine controls when the bed is clear and the machine is safe to move.</p>
        </div>
      </AppDialog>
      <footer className={`statusbar ${error ? 'error' : ''}`} role="status" aria-live="polite">
        <span className={`status-dot ${connected ? 'connected' : ''}`} />
        <span>{connected ? `${machineStatus.state} · ${measuredCount} nails measured` : `Not connected · ${measuredCount} nails measured`}</span>
        <span className="status-message">{message || (connected ? 'FluidNC connected' : 'Ready · Connect to FluidNC to control the machine')}</span>
        <span className="statusbar-detail">{plan.visits} visits · XY only</span>
        {anchorPickMode && <button title="Stop placing an anchor on the map." onClick={() => { setAnchorPickMode(false); setPickedAnchor(null) }}>Cancel map pick</button>}
      </footer>
    </div>
  )
}

export default App
