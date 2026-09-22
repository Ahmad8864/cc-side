/** One consumer, explicit shutdown; no polling or unresolved waiter on close. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private waiter?: (value: IteratorResult<T>) => void
  private ended = false
  push(value: T) {
    if (this.ended) throw new Error('Conversation is closed')
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = undefined
      resolve({ value, done: false })
    } else this.values.push(value)
  }
  close() {
    this.ended = true
    this.values = []
    this.waiter?.({ value: undefined, done: true })
    this.waiter = undefined
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
    }
  }
}
