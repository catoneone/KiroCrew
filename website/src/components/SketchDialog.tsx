import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { i18nT } from '../i18n/t'
import { useLanguage } from '../i18n/LanguageProvider'

/**
 * Sketch pad: an Excalidraw whiteboard in a modal, opened from the composer's
 * pencil button. "Insert" exports the scene as a PNG (what a human reads) plus
 * the .excalidraw JSON sidecar (what an agent reads — element geometry and
 * labels beat pixels) and hands both to the composer's regular attachment
 * pipeline, so server-side validation, resizing, and attachment chips are all
 * reused unchanged.
 *
 * Excalidraw is ~1MB, so the component AND its stylesheet load lazily on first
 * open; the main bundle carries only this wrapper. The last scene is kept in a
 * ref for the lifetime of the composer, so reopening the dialog restores the
 * previous drawing instead of a blank canvas.
 */

const Excalidraw = lazy(() =>
  Promise.all([
    import('@excalidraw/excalidraw'),
    // Vite splits the stylesheet into the same lazy chunk group; Excalidraw
    // renders unstyled without it.
    import('@excalidraw/excalidraw/index.css'),
  ]).then(([mod]) => ({ default: mod.Excalidraw })),
)

/** Languages Excalidraw ships translations for, keyed loosely by our tags.
 *  Anything unmapped falls back to English inside Excalidraw itself. */
const EXCALIDRAW_LANG: Record<string, string> = {
  'zh-CN': 'zh-CN',
  de: 'de-DE',
  es: 'es-ES',
  fr: 'fr-FR',
  hi: 'hi-IN',
  it: 'it-IT',
  ja: 'ja-JP',
  ko: 'ko-KR',
  pt: 'pt-PT',
  ru: 'ru-RU',
}

interface SketchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Receives the exported files (PNG + .excalidraw source) on insert. */
  onInsert: (files: File[]) => void
}

/** Where the last scene survives a reload or session switch — the drawing
 *  peer of `chatDrafts.ts`'s text-draft persistence. One key for the whole
 *  dashboard: split panes share it, last write wins, matching how a single
 *  physical sketch pad would behave. */
const SCENE_STORAGE_KEY = 'mc-sketch-scene'
/** Scenes with embedded images can outgrow localStorage's quota; past this
 *  size the scene stays in memory only rather than risking a quota throw. */
const SCENE_PERSIST_MAX_CHARS = 1_500_000

type StoredScene = {
  elements: readonly unknown[]
  appState: Record<string, unknown>
  files: unknown
}

function readStoredScene(): StoredScene | null {
  try {
    const raw = localStorage.getItem(SCENE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredScene
    return Array.isArray(parsed.elements) && parsed.elements.length ? parsed : null
  } catch {
    return null
  }
}

export default function SketchDialog({ open, onOpenChange, onInsert }: SketchDialogProps) {
  const { resolved: uiLanguage } = useLanguage()
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  /** Last scene — elements, appState AND the file map (embedded images live
   *  there, not in elements). Seeded from localStorage so a reload or session
   *  switch restores the drawing (the text draft beside it already survives
   *  both via chatDrafts.ts); kept in a ref between opens. */
  const sceneRef = useRef<StoredScene | null>(null)
  if (sceneRef.current === null && typeof localStorage !== 'undefined') {
    sceneRef.current = readStoredScene()
  }
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [hasElements, setHasElements] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportFailed, setExportFailed] = useState(false)

  /** The wrapper stays mounted while the dialog is closed, so a failure from
   *  the previous session would otherwise greet the next open as a stale
   *  red alert. */
  useEffect(() => {
    if (open) setExportFailed(false)
  }, [open])

  // The resolved display mode ('dark' | 'light') is what to paint; reading it
  // at render time keeps this component free of the theme hook's re-renders.
  const mode = typeof document !== 'undefined' && document.documentElement.dataset.mode === 'light' ? 'light' : 'dark'

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api
    setHasElements(api.getSceneElements().length > 0)
  }, [])

  const handleChange = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    const elements = api.getSceneElements()
    sceneRef.current = {
      elements,
      appState: api.getAppState() as unknown as Record<string, unknown>,
      files: api.getFiles(),
    }
    setHasElements(elements.length > 0)
    // Debounced localStorage write: Excalidraw fires onChange per pointer
    // move, and a synchronous serialize of a large scene on every event
    // would jank the stroke being drawn.
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      try {
        if (!elements.length) {
          localStorage.removeItem(SCENE_STORAGE_KEY)
          return
        }
        const raw = JSON.stringify(sceneRef.current)
        if (raw.length <= SCENE_PERSIST_MAX_CHARS) localStorage.setItem(SCENE_STORAGE_KEY, raw)
      } catch {
        // Quota or serialization failure: in-memory restore still works.
      }
    }, 500)
  }, [])

  const handleInsert = useCallback(async () => {
    const api = apiRef.current
    if (!api || exporting) return
    const elements = api.getSceneElements()
    if (!elements.length) return
    setExporting(true)
    setExportFailed(false)
    try {
      const mod = await import('@excalidraw/excalidraw')
      const appState = api.getAppState()
      const files = api.getFiles()
      const blob = await mod.exportToBlob({
        elements,
        appState: { ...appState, exportBackground: true },
        files,
        mimeType: 'image/png',
      })
      // Local-time stamp, mirroring nameClipboardImage's pasted-image naming.
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const png = new File([blob], `sketch-${ts}.png`, { type: 'image/png' })
      // ".excalidraw" is the scene's own extension: the dashboard's read-only
      // scene renderer (FileRenderers) routes on it, so the chip renders as a
      // drawing instead of a wall of raw JSON, and external Excalidraw tooling
      // opens it directly. The agent still reads it fine — file readers are
      // extension-agnostic for text, and the structured scene (element
      // geometry, labels) is what lets a crew read the drawing as data.
      const json = mod.serializeAsJSON(elements, appState, files, 'local')
      const sidecar = new File([json], `sketch-${ts}.excalidraw`, { type: 'application/json' })
      onInsert([png, sidecar])
      onOpenChange(false)
    } catch {
      // Offline chunk fetch or an oversized-canvas export rejection: without
      // this line the spinner just stops and Insert looks like a dead end.
      setExportFailed(true)
    } finally {
      setExporting(false)
    }
  }, [exporting, onInsert, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        maxWidth={1100}
        className="w-[min(1100px,94vw)] h-[min(720px,88vh)] p-0 gap-0 flex flex-col overflow-hidden"
        data-testid="sketch-dialog"
        // Radix's DismissableLayer catches Escape in the CAPTURE phase — before
        // Excalidraw's own handlers — so Escape meant to finish a text label or
        // cancel a shape would dismiss the whole modal. Yield Escape to the
        // canvas whenever an element is being edited or is selected; a second
        // Escape (idle canvas) still closes the dialog.
        onEscapeKeyDown={e => {
          const api = apiRef.current
          if (!api) return
          const s = api.getAppState() as unknown as {
            editingTextElement?: unknown
            newElement?: unknown
            selectedElementIds?: Record<string, boolean>
          }
          const busy = Boolean(s.editingTextElement) || Boolean(s.newElement)
            || Object.keys(s.selectedElementIds ?? {}).length > 0
          if (busy) e.preventDefault()
        }}
      >
        <div className="flex items-center gap-3 px-4 h-12 shrink-0 border-b border-border">
          <DialogTitle className="text-sm font-semibold m-0">
            {i18nT('components.sketchDialog.title')}
          </DialogTitle>
          <div className="flex-1" />
          {exportFailed && (
            <span role="alert" className="text-[12px] text-danger">
              {i18nT('components.sketchDialog.export_failed')}
            </span>
          )}
          {!exportFailed && (
            <span className="text-[11.5px] text-muted">
              {hasElements
                ? i18nT('components.sketchDialog.insert_hint')
                : i18nT('components.sketchDialog.draw_something_first')}
            </span>
          )}
          <button
            // mr-10, not mr-6: the dialog's built-in close X occupies the last
            // 44px before the right edge and renders on top — a narrower
            // margin lets an edge-click on the primary CTA hit Close instead.
            className="text-[13px] px-3.5 py-1.5 rounded-lg font-semibold bg-accent text-accent-fg border-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent-hover transition-colors mr-10"
            onClick={handleInsert}
            disabled={!hasElements || exporting}
            title={hasElements ? undefined : i18nT('components.sketchDialog.draw_something_first')}
            aria-label={i18nT('components.sketchDialog.attach_to_message')}
          >
            {exporting
              ? <Loader2 size={14} className="animate-spin lucide-inline" />
              : i18nT('components.sketchDialog.attach_to_message')}
          </button>
        </div>
        <div className="flex-1 min-h-0">
          {open && (
            <Suspense
              fallback={
                <div className="w-full h-full flex items-center justify-center gap-2 text-muted text-[13px]">
                  <Loader2 size={16} className="animate-spin lucide-inline" />
                  {i18nT('components.sketchDialog.loading')}
                </div>
              }
            >
              <Excalidraw
                excalidrawAPI={handleApi}
                onChange={handleChange}
                theme={mode}
                langCode={EXCALIDRAW_LANG[uiLanguage] ?? 'en'}
                initialData={sceneRef.current
                  ? {
                      elements: sceneRef.current.elements as never,
                      appState: { ...(sceneRef.current.appState as object), collaborators: new Map() } as never,
                      files: sceneRef.current.files as never,
                    }
                  : null}
                UIOptions={{
                  canvasActions: {
                    // The dialog's Insert button is the one export path; hiding
                    // Excalidraw's own save/export menu avoids two competing
                    // "save" affordances in one modal.
                    export: false,
                    saveToActiveFile: false,
                    loadScene: false,
                  },
                }}
              />
            </Suspense>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
