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
      pending = args
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
