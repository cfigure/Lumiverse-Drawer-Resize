/**
 * Drawer Resize — a deliberately tiny, frontend-only Lumiverse extension.
 *
 * The WebKit fix is structural: the handle is positioned relative to the
 * drawer itself and anchored with `left`/`right`. It never uses a calculated
 * width to locate itself inside Lumiverse's transformed wrapper.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

type DrawerSide = 'left' | 'right'

interface WidthFromPointerInput {
  startWidth: number
  startClientX: number
  clientX: number
  side: DrawerSide
  uiScale: number
  viewportWidth: number
}

interface ReadableStorage {
  getItem(key: string): string | null
}

interface WritableStorage {
  setItem(key: string, value: string): void
}

interface OriginalInlineStyles {
  drawerPosition: string
  drawerPositionPriority: string
  drawerWidth: string
  drawerWidthPriority: string
  wrapperWidth: string
  wrapperWidthPriority: string
}

interface DrawerBinding {
  drawer: HTMLElement
  wrapper: HTMLElement
  handle: HTMLDivElement
  original: OriginalInlineStyles
  wrapperObserver: MutationObserver
  onPointerDown: (event: PointerEvent) => void
  onKeyDown: (event: KeyboardEvent) => void
  onEnter: () => void
  onLeave: () => void
  side: DrawerSide
}

interface DragState {
  pointerId: number
  startClientX: number
  startWidth: number
  bodyCursor: string
  bodyUserSelect: string
  shield: HTMLDivElement
  latestWidth: number
}

interface HandleAnchor {
  left: string
  right: string
}

export const STORAGE_KEY = 'drawer-resize.width.v1'
export const MIN_WIDTH = 200
export const MAX_WIDTH_FRACTION = 0.8
export const HANDLE_OVERHANG = 6

const SIDEBAR_SELECTOR = '[data-spindle-mount="sidebar"]'
const HANDLE_ATTRIBUTE = 'data-drawer-resize-handle'

export function clampDrawerWidth(width: number, viewportWidth: number): number {
  const safeViewport = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth
    : MIN_WIDTH / MAX_WIDTH_FRACTION
  const maximum = Math.max(MIN_WIDTH, safeViewport * MAX_WIDTH_FRACTION)
  const safeWidth = Number.isFinite(width) ? width : MIN_WIDTH
  return Math.round(Math.max(MIN_WIDTH, Math.min(maximum, safeWidth)))
}

/**
 * Resolve the host side from its stable CSS-module token. Geometry is only a
 * fallback for the brief interval before React has stamped a side class.
 */
export function resolveDrawerSide(
  className: string,
  drawerRect: Pick<DOMRect, 'left' | 'right'> | null = null,
  viewportWidth = 0,
): DrawerSide {
  if (className.includes('wrapperLeft')) return 'left'
  if (className.includes('wrapperRight')) return 'right'
  if (drawerRect && viewportWidth > 0) {
    return (drawerRect.left + drawerRect.right) / 2 < viewportWidth / 2 ? 'left' : 'right'
  }
  return 'right'
}

export function handleAnchor(side: DrawerSide): HandleAnchor {
  return side === 'left'
    ? { left: '', right: `-${HANDLE_OVERHANG}px` }
    : { left: `-${HANDLE_OVERHANG}px`, right: '' }
}

export function widthFromPointer(input: WidthFromPointerInput): number {
  const scale = Number.isFinite(input.uiScale) && input.uiScale > 0 ? input.uiScale : 1
  const renderedDelta = input.clientX - input.startClientX
  const layoutDelta = renderedDelta / scale
  const signedDelta = input.side === 'left' ? layoutDelta : -layoutDelta
  return clampDrawerWidth(input.startWidth + signedDelta, input.viewportWidth)
}

export function readSavedWidth(storage: ReadableStorage | null): number | null {
  if (!storage) return null
  try {
    const value = Number.parseFloat(storage.getItem(STORAGE_KEY) ?? '')
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export function saveWidth(storage: WritableStorage | null, width: number): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, String(Math.round(width)))
  } catch {
    // Private browsing or a locked-down WebView may deny storage. Resizing
    // still works for the current page, so persistence failure is non-fatal.
  }
}

function getBrowserStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function setup(context: SpindleFrontendContext): () => void {
  const controller = new DrawerResizeController(context)
  controller.start()
  return () => controller.stop()
}

class DrawerResizeController {
  private readonly context: SpindleFrontendContext
  private readonly storage: Storage | null
  private binding: DrawerBinding | null = null
  private documentObserver: MutationObserver | null = null
  private frame: number | null = null
  private stopped = false
  private drag: DragState | null = null
  private savedWidth: number | null
  private onPointerMove: ((event: PointerEvent) => void) | null = null
  private onPointerEnd: ((event: PointerEvent) => void) | null = null

  private readonly onViewportChange = (): void => this.scheduleSync()

  constructor(context: SpindleFrontendContext) {
    this.context = context
    this.storage = getBrowserStorage()
    this.savedWidth = readSavedWidth(this.storage)
  }

  start(): void {
    if (this.hasFinePointer()) this.scheduleSync()

    this.documentObserver = new MutationObserver(() => this.scheduleSync())
    // The document-wide observer only watches node replacement. Attribute
    // changes are observed on the one bound wrapper below; watching every
    // class/style mutation in the chat would be unnecessarily noisy.
    this.documentObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
    window.addEventListener('resize', this.onViewportChange, { passive: true })
    window.addEventListener('orientationchange', this.onViewportChange, { passive: true })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.documentObserver?.disconnect()
    window.removeEventListener('resize', this.onViewportChange)
    window.removeEventListener('orientationchange', this.onViewportChange)
    this.finishDrag(false)
    this.unbind()
  }

  private hasFinePointer(): boolean {
    if (typeof window.matchMedia !== 'function') return true
    return window.matchMedia('(any-pointer: fine)').matches
      || !window.matchMedia('(pointer: coarse)').matches
  }

  private scheduleSync(): void {
    if (this.stopped || this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.sync()
    })
  }

  private sync(): void {
    if (!this.hasFinePointer()) {
      this.unbind()
      return
    }

    const sidebar = document.querySelector<HTMLElement>(SIDEBAR_SELECTOR)
    const drawer = sidebar?.parentElement ?? null
    const wrapper = sidebar?.closest<HTMLElement>('[class*="_wrapper_"]')
      ?? drawer?.parentElement
      ?? null
    if (!drawer || !wrapper) {
      this.unbind()
      return
    }

    if (!this.binding || this.binding.drawer !== drawer || this.binding.wrapper !== wrapper) {
      this.unbind()
      this.bind(drawer, wrapper)
    }

    this.refreshSide()
    if (!this.drag && this.savedWidth !== null) this.applyWidth(this.savedWidth, false)
  }

  private bind(drawer: HTMLElement, wrapper: HTMLElement): void {
    const original: OriginalInlineStyles = {
      drawerPosition: drawer.style.getPropertyValue('position'),
      drawerPositionPriority: drawer.style.getPropertyPriority('position'),
      drawerWidth: drawer.style.getPropertyValue('width'),
      drawerWidthPriority: drawer.style.getPropertyPriority('width'),
      wrapperWidth: wrapper.style.getPropertyValue('--drawer-panel-w'),
      wrapperWidthPriority: wrapper.style.getPropertyPriority('--drawer-panel-w'),
    }

    // This is the WebKit fix: the absolute handle receives a stable,
    // width-independent containing block that moves with the host drawer.
    if (getComputedStyle(drawer).position === 'static') {
      drawer.style.setProperty('position', 'relative')
    }

    drawer.querySelector(`[${HANDLE_ATTRIBUTE}]`)?.remove()
    const handle = document.createElement('div')
    handle.setAttribute(HANDLE_ATTRIBUTE, '')
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-label', 'Resize drawer')
    handle.setAttribute('aria-orientation', 'vertical')
    handle.tabIndex = 0
    handle.style.cssText = [
      'position:absolute',
      'top:0',
      'bottom:0',
      'width:12px',
      'z-index:2147483647',
      'cursor:col-resize',
      'touch-action:none',
      'background:transparent',
      'box-sizing:border-box',
      'transition:background-color 120ms ease',
    ].join(';')

    const onPointerDown = (event: PointerEvent): void => this.beginDrag(event)
    const onKeyDown = (event: KeyboardEvent): void => this.handleKeyDown(event)
    const onEnter = (): void => {
      if (!this.drag) handle.style.backgroundColor = 'rgba(255,255,255,.08)'
    }
    const onLeave = (): void => {
      if (!this.drag) handle.style.backgroundColor = 'transparent'
    }
    handle.addEventListener('pointerdown', onPointerDown)
    handle.addEventListener('keydown', onKeyDown)
    handle.addEventListener('mouseenter', onEnter)
    handle.addEventListener('mouseleave', onLeave)
    drawer.appendChild(handle)

    const wrapperObserver = new MutationObserver(() => this.scheduleSync())
    wrapperObserver.observe(wrapper, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    this.binding = {
      drawer,
      wrapper,
      handle,
      original,
      wrapperObserver,
      onPointerDown,
      onKeyDown,
      onEnter,
      onLeave,
      side: 'right',
    }
  }

  private unbind(): void {
    const binding = this.binding
    if (!binding) return
    this.finishDrag(false)
    const { drawer, wrapper, handle, original } = binding
    binding.wrapperObserver.disconnect()
    handle.removeEventListener('pointerdown', binding.onPointerDown)
    handle.removeEventListener('keydown', binding.onKeyDown)
    handle.removeEventListener('mouseenter', binding.onEnter)
    handle.removeEventListener('mouseleave', binding.onLeave)
    handle.remove()
    restoreStyle(drawer.style, 'position', original.drawerPosition, original.drawerPositionPriority)
    restoreStyle(drawer.style, 'width', original.drawerWidth, original.drawerWidthPriority)
    restoreStyle(wrapper.style, '--drawer-panel-w', original.wrapperWidth, original.wrapperWidthPriority)
    this.binding = null
  }

  private refreshSide(): void {
    if (!this.binding) return
    const { drawer, wrapper, handle } = this.binding
    const side = resolveDrawerSide(wrapper.className, drawer.getBoundingClientRect(), window.innerWidth)
    this.binding.side = side
    const anchor = handleAnchor(side)
    if (handle.style.left !== anchor.left) handle.style.left = anchor.left
    if (handle.style.right !== anchor.right) handle.style.right = anchor.right
  }

  private beginDrag(event: PointerEvent): void {
    if (!this.binding || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    this.refreshSide()

    const computedWidth = Number.parseFloat(getComputedStyle(this.binding.drawer).width)
    const rectWidth = this.toLayoutPx(this.binding.drawer.getBoundingClientRect().width)
    const startWidth = Number.isFinite(computedWidth) ? computedWidth : rectWidth
    const shield = document.createElement('div')
    shield.setAttribute('data-drawer-resize-shield', '')
    shield.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483646',
      'cursor:col-resize',
      'background:transparent',
      'touch-action:none',
    ].join(';')
    document.body.appendChild(shield)

    this.drag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
      shield,
      latestWidth: startWidth,
    }
    this.binding.handle.style.backgroundColor = 'rgba(255,255,255,.16)'
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    try {
      this.binding.handle.setPointerCapture(event.pointerId)
    } catch {
      // Window listeners below are the WebKit fallback.
    }

    this.onPointerMove = (moveEvent: PointerEvent): void => {
      if (!this.drag || moveEvent.pointerId !== this.drag.pointerId || !this.binding) return
      moveEvent.preventDefault()
      const width = widthFromPointer({
        startWidth: this.drag.startWidth,
        startClientX: this.drag.startClientX,
        clientX: moveEvent.clientX,
        side: this.binding.side,
        uiScale: this.uiScale(),
        viewportWidth: this.layoutViewportWidth(),
      })
      this.drag.latestWidth = width
      this.applyWidth(width, false)
    }
    this.onPointerEnd = (endEvent: PointerEvent): void => {
      if (!this.drag || endEvent.pointerId !== this.drag.pointerId) return
      this.finishDrag(true)
    }
    window.addEventListener('pointermove', this.onPointerMove, { passive: false })
    window.addEventListener('pointerup', this.onPointerEnd)
    window.addEventListener('pointercancel', this.onPointerEnd)
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.binding || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    event.preventDefault()
    this.refreshSide()
    const current = Number.parseFloat(getComputedStyle(this.binding.drawer).width)
    const step = event.shiftKey ? 40 : 10
    const physicalDelta = event.key === 'ArrowRight' ? step : -step
    const signedDelta = this.binding.side === 'left' ? physicalDelta : -physicalDelta
    const width = clampDrawerWidth(current + signedDelta, this.layoutViewportWidth())
    this.applyWidth(width, true)
  }

  private finishDrag(persist: boolean): void {
    if (!this.drag) return
    if (this.onPointerMove) window.removeEventListener('pointermove', this.onPointerMove)
    if (this.onPointerEnd) {
      window.removeEventListener('pointerup', this.onPointerEnd)
      window.removeEventListener('pointercancel', this.onPointerEnd)
    }
    const { latestWidth, bodyCursor, bodyUserSelect, shield } = this.drag
    shield.remove()
    document.body.style.cursor = bodyCursor
    document.body.style.userSelect = bodyUserSelect
    if (this.binding) this.binding.handle.style.backgroundColor = 'transparent'
    this.drag = null
    this.onPointerMove = null
    this.onPointerEnd = null
    if (persist) this.applyWidth(latestWidth, true)
  }

  private applyWidth(width: number, persist: boolean): void {
    if (!this.binding) return
    const next = clampDrawerWidth(width, this.layoutViewportWidth())
    const cssWidth = `${next}px`
    const { drawer, wrapper } = this.binding
    if (
      drawer.style.getPropertyValue('width') !== cssWidth
      || drawer.style.getPropertyPriority('width') !== 'important'
    ) {
      drawer.style.setProperty('width', cssWidth, 'important')
    }
    if (
      wrapper.style.getPropertyValue('--drawer-panel-w') !== cssWidth
      || wrapper.style.getPropertyPriority('--drawer-panel-w') !== 'important'
    ) {
      wrapper.style.setProperty('--drawer-panel-w', cssWidth, 'important')
    }
    if (persist) {
      this.savedWidth = next
      saveWidth(this.storage, next)
    }
  }

  private uiScale(): number {
    try {
      const scale = this.context.ui?.geometry?.getUiScale?.()
      if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) return scale
    } catch {
      // Fall through to the host CSS variable.
    }
    const cssScale = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-ui-scale'),
    )
    return Number.isFinite(cssScale) && cssScale > 0 ? cssScale : 1
  }

  private toLayoutPx(renderedPx: number): number {
    try {
      const value = this.context.ui?.geometry?.toLayoutPx?.(renderedPx)
      if (typeof value === 'number' && Number.isFinite(value)) return value
    } catch {
      // Fall through to scale division.
    }
    return renderedPx / this.uiScale()
  }

  private layoutViewportWidth(): number {
    try {
      const width = this.context.ui?.geometry?.layoutViewportSize?.().width
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) return width
    } catch {
      // Fall through to window geometry.
    }
    return window.innerWidth / this.uiScale()
  }
}

function restoreStyle(
  style: CSSStyleDeclaration,
  name: string,
  value: string,
  priority: string,
): void {
  if (value) style.setProperty(name, value, priority)
  else style.removeProperty(name)
}
