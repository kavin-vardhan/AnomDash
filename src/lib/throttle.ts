// Leading + trailing throttle: invokes at most once per `waitMs`, last-args-win for the trailing edge.
// Used by continuous slider controls (e.g. the coverage slider) to cap the WS send rate during a drag
// (per-pixel flooding is the competing-drivers / frozen-dashboard failure mode), with cancel() so the
// caller can do an authoritative send on release.
//
// NOTE: the existing poll-radius slider still sends on every onChange; it could adopt this util later —
// intentionally not retrofitted as of this change.

export interface Throttled<A extends unknown[]> {
  (...args: A): void
  cancel: () => void
  flush: () => void
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Throttled<A> {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null

  const run = (args: A) => {
    last = Date.now()
    pending = null
    fn(...args)
  }

  const throttled = ((...args: A) => {
    const remaining = waitMs - (Date.now() - last)
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      run(args)
    } else {
      pending = args // last value within the window wins
      if (!timer) {
        timer = setTimeout(() => {
          timer = null
          if (pending) run(pending)
        }, remaining)
      }
    }
  }) as Throttled<A>

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  throttled.flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending) run(pending)
  }

  return throttled
}
