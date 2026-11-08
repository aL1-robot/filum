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
import PlannerCanvas from './PlannerCanvas.tsx'
import './App.css'

const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 5]
const INITIAL = startingPoint()
type AppMenu = 'file' | 'settings' | 'machine'
type AppDialogView = 'settings' | 'sequence' | 'gcode' | 'boardFiles' | 'machineConfig' | 'anchors'

const APP_MENU_ITEMS: Record<AppMenu, { label: string; dialog: AppDialogView }[]> = {
  settings: [{ label: 'Planner settings', dialog: 'settings' }],
  file: [
    { label: 'Nail sequence', dialog: 'sequence' },
    { label: 'G-code job', dialog: 'gcode' },
    { label: 'Board files', dialog: 'boardFiles' },
  ],
  machine: [
    { label: 'Machine configuration', dialog: 'machineConfig' },
    { label: 'Calibration anchors', dialog: 'anchors' },
  ],
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
          <span className="dialog-eyebrow">NEEDLE PLANNER</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button className="dialog-close" aria-label="Close dialog" onClick={onClose}>×</button>
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
  const [raw, setRaw] = useState<RawParams>(INITIAL.raw)
  const [anchors, setAnchors] = useState<Anchor[]>(INITIAL.anchors)
  const [anchorAuto, setAnchorAuto] = useState(true)
  const [fieldGroupsOpen, setFieldGroupsOpen] = useState(() => Object.fromEntries(FIELD_GROUPS.map(group => [group.title, group.open])))
  const [activePopup, setActivePopup] = useState<AppMenu | null>(null)
  const [activeDialog, setActiveDialog] = useState<AppDialogView | null>(null)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [pickedAnchor, setPickedAnchor] = useState<number | null>(null)
  const [sequence, setSequence] = useState(INITIAL.sequence)
  const [measurements, setMeasurements] = useState<Measurements>({})
  const [machineStatus, setMachineStatus] = useState(client.status)
  const [progress, setProgress] = useState<Progress>(emptyProgress)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [runMessage, setRunMessage] = useState('')
  const [runPaused, setRunPaused] = useState(false)
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
  const [anchorPickMode, setAnchorPickMode] = useState(false)
  const [fitRequest, setFitRequest] = useState(0)
  const primaryActionRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const jogRingRef = useRef<(direction: 'out' | 'in' | 'ccw' | 'cw', shift?: boolean) => void>(() => {})

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
        setRunMessage('Waiting for thread')
      } else if (event.type === 'run-resumed') {
        setRunPaused(false)
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
    const timer = window.setInterval(() => {
      setVisibleVisits(current => {
        const next = (current ?? 0) + 1
        return Math.min(next, plan.visits)
      })
    }, 60)
    const stop = window.setTimeout(() => setPlaying(false), plan.visits * 60)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(stop)
    }
  }, [playing, plan.visits])

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
    setActing(true)
    const result = await client.runGcode(split.approach, split.rest)
    setActing(false)
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
    setArrived(false)
    setActing(false)
    setProgress(current => haltProgress(current))
    notify('Stopped (feed hold + reset). Check position, then Unlock if needed.', true)
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <div className="app-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="10.5" />
              <path d="M8.5 9.5 23 22M8 16h16M16 5.5v21" />
              <circle cx="8.5" cy="9.5" r="1.5" />
              <circle cx="23" cy="22" r="1.5" />
            </svg>
          </div>
          <div>
            <h1>Needle Planner</h1>
            <p>String art · FluidNC</p>
          </div>
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
          {(['file', 'settings', 'machine'] as const).map(menu => (
            <div className="app-menu-entry" key={menu}>
              <button
                aria-haspopup="menu"
                aria-expanded={activePopup === menu}
                onClick={() => toggleMenu(menu)}
              >{menu[0].toUpperCase() + menu.slice(1)}</button>
              {activePopup === menu && (
                <div className="menu-popup" role="menu">
                  {APP_MENU_ITEMS[menu].map(item => (
                    <button role="menuitem" key={item.dialog} onClick={() => openDialog(item.dialog)}>{item.label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <button
          className={`hamburger-button ${mobileMenuOpen ? 'active' : ''}`}
          aria-label={mobileMenuOpen ? 'Close planner menu' : 'Open planner menu'}
          aria-expanded={mobileMenuOpen}
          onClick={() => {
            setMobileMenuOpen(value => !value)
            setActivePopup(null)
          }}
        >
          <span /><span /><span />
        </button>
        <div className="header-context">Planner <span>/</span> Toolpath</div>
        <span className={`connection-pill ${connected ? 'connected' : ''}`}>
          <i />
          {connected ? machineStatus.state : 'Not connected'}
        </span>
      </header>
      {mobileMenuOpen && (
        <div className="mobile-menu-backdrop" onClick={() => { setMobileMenuOpen(false); setActivePopup(null) }}>
          <nav
            className="mobile-menu"
            role="menu"
            aria-label="Planner menus"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setActivePopup(null)
                setMobileMenuOpen(false)
              }
            }}
          >
            {activePopup ? (
              <>
                <button className="mobile-menu-back" onClick={() => setActivePopup(null)}>‹ All menus</button>
                {APP_MENU_ITEMS[activePopup].map(item => (
                  <button role="menuitem" key={item.dialog} onClick={() => openDialog(item.dialog)}>{item.label}</button>
                ))}
              </>
            ) : (
              (['file', 'settings', 'machine'] as const).map(menu => (
                <button role="menuitem" key={menu} onClick={() => setActivePopup(menu)}>
                  <b>{menu[0].toUpperCase() + menu.slice(1)}</b><span>{APP_MENU_ITEMS[menu].map(item => item.label).join(' · ')}</span>
                </button>
              ))
            )}
          </nav>
        </div>
      )}

      <main className="workspace" onClick={() => setActivePopup(null)}>
        <section className="planner-column">
          <section className="panel planner-panel">
            <div className="section-heading">
              <div>
                <h2>Toolpath</h2>
                <p>{progressLabel({ ...progress, show: showDoneOnly })}</p>
              </div>
              <div className="inline-actions">
                <button onClick={() => setShowDoneOnly(value => !value)} className={showDoneOnly ? 'selected' : ''}>Done lines only</button>
                <button onClick={() => setFitRequest(value => value + 1)}>Fit view</button>
                <button onClick={() => { setVisibleVisits(0); setPlaying(true) }}>{playing ? 'Playing…' : '▶ Play'}</button>
              </div>
            </div>
            <div className="path-legend" aria-label="Toolpath legend">
              <span><i className="thread-line" />Thread path</span>
              <span><i className="approach-line" />Approach from home</span>
              <span><i className="exit-line" />Return to home</span>
            </div>
            <PlannerCanvas
              plan={plan}
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
            />
            <div className="visit-slider">
              <input
                type="range"
                min={0}
                max={plan.visits}
                value={visibleVisits == null ? plan.visits : Math.min(visibleVisits, plan.visits)}
                onChange={event => {
                  setPlaying(false)
                  setVisibleVisits(Number(event.target.value))
                }}
              />
              <span>{visibleVisits == null ? plan.visits : Math.min(visibleVisits, plan.visits)} / {plan.visits} visits</span>
            </div>
            <div className="plan-summary">
              <div><b>{plan.visits}</b><span>nail visits</span></div>
              <div><b>{(plan.length / 1000).toFixed(1)} m</b><span>thread length</span></div>
              <div><b>{(plan.length / plan.p.f).toFixed(0)} min</b><span>estimated time</span></div>
              <div><b>{measuredCount}</b><span>nails measured</span></div>
              <p>
                Ring radius {plan.p.Rh.toFixed(2)} mm · pitch {(2 * plan.p.Rh * Math.sin(Math.PI / plan.p.n)).toFixed(2)} mm ·
                calibration residual {Number.isNaN(plan.cal.res) ? 'n/a' : `${plan.cal.res.toFixed(2)} mm`} ·
                CCW/CW gap {plan.ccw.gap.toFixed(2)} / {plan.cw.gap.toFixed(2)} mm
              </p>
            </div>
            {plan.warnings.length > 0 && (
              <div className="warnings">{plan.warnings.map((warning, index) => <p key={index}>⚠ {warning}</p>)}</div>
            )}
          </section>

        </section>

        <aside className="control-column">
          <section className="panel connection-panel">
            <h2>Nail calibration &amp; FluidNC</h2>
            <div className="connect-row">
              <input value={address} aria-label="FluidNC address" onChange={event => setAddress(event.target.value)} />
              <button onClick={() => void connect()}>{connected ? 'Disconnect' : 'Connect'}</button>
            </div>
            <p className="controller-status">
              {connected ? `${machineStatus.state} · X ${machineStatus.pos?.[0].toFixed(3) ?? '-'} · Y ${machineStatus.pos?.[1].toFixed(3) ?? '-'} · ${measuredCount} nails measured` : `Not connected · ${measuredCount} nails measured`}
              {machineStatus.sd != null && ` · SD job ${parseFloat(machineStatus.sd) || 0}%`}
            </p>
            <div className="calibration-settings">
              <label>Measure every <input type="number" min={1} value={measureStep} onChange={event => setMeasureStep(Math.max(1, Number(event.target.value) | 0))} /> nails</label>
              <label>Approach clearance <input type="number" min={0} step={0.5} value={clearance} onChange={event => setClearance(Number(event.target.value))} /> mm</label>
              <label>Travel margin <input type="number" min={3} step={1} value={travelMargin} onChange={event => setTravelMargin(Number(event.target.value))} /> mm</label>
              <label className="check-inline"><input type="checkbox" checked={autoMove} onChange={event => setAutoMove(event.target.checked)} /> auto-move to next</label>
              <button onClick={startCalibration}>Start plan</button>
              <button disabled={measuredCount === 0} onClick={refineCalibration}>Refine</button>
            </div>
            <div className="queue-progress"><i style={{ width: `${queue.length ? Math.min(queueIndex, queue.length) / queue.length * 100 : 0}%` }} /></div>
            <div className="calibration-actions">
              <button className="primary" disabled={!connected || currentNail == null || acting || busyWithBoard} onClick={() => void primaryAction()}>
                {currentNail == null ? (queue.length ? 'Plan complete' : 'Start a plan') : acting ? 'Moving…' : arrived ? `Record nail ${currentNail}` : `Go to nail ${currentNail}`}
              </button>
              <button disabled={currentNail == null} onClick={() => { setQueueIndex(index => Math.max(0, index - 1)); setArrived(false) }}>◀ Back</button>
              <button disabled={currentNail == null} onClick={() => { setQueueIndex(index => Math.min(queue.length, index + 1)); setArrived(false) }}>Skip ▶</button>
              <button disabled={!connected || !machineStatus.pos} onClick={() => {
                if (!machineStatus.pos) return
                const direction = ringDirection([plan.cal.tx, plan.cal.ty], machineStatus.pos, 'out')
                client.jog(direction[0], direction[1], 3)
              }}>Back off</button>
              <button className="danger" disabled={!connected} onClick={stopMachine}>■ Stop</button>
              <button disabled={!connected} onClick={() => void client.unlock()}>Unlock</button>
            </div>
            <div className="home-actions">
              <span>Home:</span>
              <button disabled={!connected || acting || busyWithBoard} onClick={() => void home('$H', 'all axes')}>All axes</button>
              <button disabled={!connected || acting || busyWithBoard} onClick={() => void home('$HX', 'X')}>X</button>
              <button disabled={!connected || acting || busyWithBoard} onClick={() => void home('$HY', 'Y')}>Y</button>
            </div>
            <div className="jog-controls">
              <div className="step-buttons"><span>Jog step</span>{STEPS.map(step => (
                <button className={jogStep === step ? 'selected' : ''} key={step} onClick={() => setJogStep(step)}>{step}</button>
              ))}</div>
              <div className="jog-layout">
                <span>XY</span>
                <div className="jog-pad">
                  <i /><button onClick={() => client.jog(0, 1, jogStep)}>▲</button><i />
                  <button onClick={() => client.jog(-1, 0, jogStep)}>◀</button><i /><button onClick={() => client.jog(1, 0, jogStep)}>▶</button>
                  <i /><button onClick={() => client.jog(0, -1, jogStep)}>▼</button><i />
                </div>
                <span>Ring</span>
                <div className="jog-pad">
                  <button onClick={() => jogRing('ccw')}>↺</button><button onClick={() => jogRing('out')}>Out</button><button onClick={() => jogRing('cw')}>↻</button>
                  <i /><button onClick={() => jogRing('in')}>In</button><i />
                </div>
              </div>
            </div>
            <div className="inline-actions calibration-files">
              <button onClick={() => downloadText(JSON.stringify({ n: plan.p.n, ib: plan.p.ib, m: measurements }, null, 2), 'nail_calibration.json', 'application/json')}>Export calibration</button>
              <label className="file-button">Import<input type="file" accept=".json,application/json" onChange={event => importMeasurements(event.target.files?.[0])} /></label>
              <button className="danger" onClick={() => {
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
      <AppDialog open={activeDialog === 'settings'} title="Planner settings" onClose={() => setActiveDialog(null)}>
        <div className="settings-dialog-content">
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
              <summary>{group.title}</summary>
              <div className="field-grid">
                {group.fields.map(field => (
                  <label key={field.key} className={field.check ? 'check-field' : 'number-field'}>
                    <span>{field.label}</span>
                    <input
                      type={field.check ? 'checkbox' : 'number'}
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
                <button className="subtle-button" onClick={() => applyRaw({ ...raw, ...autoLoop(prepare(raw)) })}>
                  Set loop values automatically
                </button>
              )}
              {group.kind === 'contact' && (
                <div className="inline-actions">
                  <button className="subtle-button" onClick={() => applyRaw({ ...raw, ...contactOuter(plan.p) })}>Contact = cap rim</button>
                  <button className="subtle-button" onClick={() => applyRaw({ ...raw, ...contactInner(plan.p) })}>Contact = inner shaft</button>
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
              <label className="file-button">Load sequence<input type="file" accept=".txt,.csv,.nc,.gcode" onChange={event => handleSequenceFile(event.target.files?.[0])} /></label>
            </div>
            <div className="inline-actions">
              <button onClick={() => {
                setFileName('demo')
                setSequence(Array.from({ length: 90 }, (_, k) => (k * 37) % raw.n + raw.ib).join('\n'))
              }}>Generate demo</button>
              <button onClick={() => {
                const values = [...Array.from({ length: Math.max(1, raw.n | 0) }, (_, k) => raw.ib + k), ...Array.from({ length: Math.max(0, (raw.n | 0) - 1) }, (_, k) => raw.ib + raw.n - 2 - k)]
                setFileName('calibration')
                setSequence(values.join('\n'))
                notify(`Calibration sequence: ${values.length} visits (${raw.n} nails there and back).`)
              }}>Calibration pattern</button>
              <span className="sequence-count">{sequence.split(/[\s,;]+/).filter(Boolean).length} entries</span>
            </div>
            <textarea aria-label="Nail sequence" value={sequence} onChange={event => setSequence(event.target.value)} />
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
              <button onClick={() => downloadText(gcode, boardName, 'text/plain')}>Save G-code</button>
              <button onClick={() => void copyGcode()}>Copy G-code</button>
              <button className="primary" disabled={!connected || acting || client.running || !plan.route.length} onClick={() => void runOnMachine()}>▶ Run on machine</button>
              {runPaused && <button className="primary" onClick={() => { client.resumeRun(); setRunPaused(false) }}>Thread attached: Resume</button>}
              <label className="board-name">Board job<input value={fileName} onChange={event => setFileName(event.target.value)} /><span>.gcode</span></label>
              <button className="primary" disabled={!plan.mp.length || uploading || busyWithBoard || client.running} onClick={() => void uploadToBoard()}>⬆ Upload to SD</button>
              <button className="primary" disabled={!connected || acting || busyWithBoard || client.running} onClick={() => void startBoardJob()}>▶ Start job on board</button>
              {connected && machineStatus.sd != null && /^Hold/.test(machineStatus.state) && <button className="primary" onClick={() => client.resumeHold()}>Resume SD job</button>}
            </div>
            {(runMessage || uploadInfo) && <p className="machine-message">{runMessage}{runTotal > 0 ? ` (${runDone}/${runTotal})` : ''}{uploadInfo ? ` ${uploadInfo}` : ''}</p>}
            {uploading && <div className="progress-track"><i className="indeterminate" /></div>}
            {uploading && <p className="hint">Uploading… {uploadSeconds}s</p>}
            <details className="gcode-details">
              <summary>G-code text</summary>
              <textarea readOnly value={gcode} />
            </details>
          </section>
          <section className="dialog-section board-files-section" hidden={activeDialog !== 'boardFiles'}>
            <div className="dialog-section-heading">
              <div><h3>FluidNC files</h3><p>Browse files stored on the controller.</p></div>
              <button onClick={() => void refreshFiles()}>Refresh</button>
            </div>
            <div className="files-toolbar">
              <button className={filesKind === 'SD' ? 'selected' : ''} onClick={() => { setFilesKind('SD'); setFiles([]); void refreshFiles('SD') }}>SD card</button>
              <button className={filesKind === 'LocalFS' ? 'selected' : ''} onClick={() => { setFilesKind('LocalFS'); setFiles([]); void refreshFiles('LocalFS') }}>Flash</button>
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
                      <button onClick={() => void runListedFile(file)}>Run</button>
                      <button className="danger" onClick={() => void deleteBoardFile(file)}>Delete</button>
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
                <summary>{group.title}</summary>
                <div className="field-grid">
                  {group.fields.map(field => (
                    <label key={field.key} className={field.check ? 'check-field' : 'number-field'}>
                      <span>{field.label}</span>
                      <input
                        type={field.check ? 'checkbox' : 'number'}
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
                    <input key={key} type="number" step="any" value={anchor[key]} aria-label={`Anchor ${index + 1} ${key}`} onChange={event => updateAnchor(index, key, Number(event.target.value))} />
                  ))}
                  <button
                    className={pickedAnchor === index ? 'selected' : ''}
                    aria-label={`Set anchor ${index + 1} from map`}
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
              <button onClick={resetAnchors}>Reset anchors to ideal</button>
              <button onClick={fitRadiusToAnchors}>Set nail radius from anchors</button>
              <button onClick={() => downloadText(JSON.stringify({ n: plan.p.n, ib: plan.p.ib, m: measurements }, null, 2), 'nail_calibration.json', 'application/json')}>Export measurements</button>
              <label className="file-button">Import measurements<input type="file" accept=".json,application/json" onChange={event => importMeasurements(event.target.files?.[0])} /></label>
              <button className="danger" onClick={() => {
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
      <footer className={`toast ${error ? 'error' : ''}`} aria-live="polite">
        <span>{message || (connected ? 'FluidNC connected' : 'Ready · Connect to FluidNC to control the machine')}</span>
        <span className="statusbar-detail">{plan.visits} visits <b>·</b> XY only</span>
        {anchorPickMode && <button onClick={() => { setAnchorPickMode(false); setPickedAnchor(null) }}>Cancel map pick</button>}
      </footer>
    </div>
  )
}

export default App
