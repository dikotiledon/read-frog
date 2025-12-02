import { batchQueueConfigSchema } from '@/types/config/translate'

const BASE_BACKOFF_DELAY_MS = 1000
const MAX_BACKOFF_DELAY_MS = 8000

function createAbortError(message: string): Error {
  if (typeof DOMException !== 'undefined')
    return new DOMException(message, 'AbortError')

  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

interface BatchTask<T, R> {
  data: T
  resolve: (value: R) => void
  reject: (error: Error) => void
  cancelled?: boolean
}

interface PendingBatch<T, R> {
  id: string
  tasks: BatchTask<T, R>[]
  totalCharacters: number
  createdAt: number
  maxCharactersBudget: number
}

export interface BatchOptions<T, R> {
  maxCharactersPerBatch: number
  maxItemsPerBatch: number
  batchDelay: number
  maxRetries?: number
  enableFallbackToIndividual?: boolean
  getBatchKey: (data: T) => string
  getCharacters: (data: T) => number
  getMaxCharactersForTask?: (data: T) => number | undefined
  executeBatch: (dataList: T[]) => Promise<R[]>
  executeIndividual?: (data: T) => Promise<R>
  onError?: (error: Error, context: { batchKey: string, retryCount: number, isFallback: boolean }) => void
}

export class BatchQueue<T, R> {
  private pendingBatchMap = new Map<string, PendingBatch<T, R>>()
  private nextScheduleTimer: NodeJS.Timeout | null = null
  private inFlightTasks = new Set<BatchTask<T, R>>()
  private maxCharactersPerBatch: number
  private maxItemsPerBatch: number
  private batchDelay: number
  private maxRetries: number
  private enableFallbackToIndividual: boolean
  private getBatchKey: (data: T) => string
  private getCharacters: (data: T) => number
  private getMaxCharactersForTask?: (data: T) => number | undefined
  private executeBatch: (dataList: T[]) => Promise<R[]>
  private executeIndividual?: (data: T) => Promise<R>
  private onError?: (error: Error, context: { batchKey: string, retryCount: number, isFallback: boolean }) => void

  constructor(config: BatchOptions<T, R>) {
    this.maxCharactersPerBatch = config.maxCharactersPerBatch
    this.maxItemsPerBatch = config.maxItemsPerBatch
    this.batchDelay = config.batchDelay
    this.maxRetries = config.maxRetries ?? 3
    this.enableFallbackToIndividual = config.enableFallbackToIndividual ?? true
    this.getBatchKey = config.getBatchKey
    this.getCharacters = config.getCharacters
    this.getMaxCharactersForTask = config.getMaxCharactersForTask
    this.executeBatch = config.executeBatch
    this.executeIndividual = config.executeIndividual
    this.onError = config.onError
  }

  enqueue(data: T): Promise<R> {
    let resolve!: (value: R) => void
    let reject!: (error: Error) => void
    const promise = new Promise<R>((res, rej) => {
      resolve = res
      reject = rej
    })

    const batchKey = this.getBatchKey(data)
    const task: BatchTask<T, R> = { data, resolve, reject }

    this.addTaskToBatch(task, batchKey)
    this.schedule()

    return promise
  }

  cancelTasks(predicate: (data: T) => boolean, reason: string = 'Batch task cancelled'): number {
    let cancelledCount = 0

    for (const [batchKey, batch] of this.pendingBatchMap.entries()) {
      const remainingTasks: BatchTask<T, R>[] = []
      let remainingCharacters = 0

      for (const task of batch.tasks) {
        if (predicate(task.data)) {
          if (this.cancelTask(task, reason))
            cancelledCount++
        }
        else {
          remainingTasks.push(task)
          remainingCharacters += this.getCharacters(task.data)
        }
      }

      if (remainingTasks.length === 0) {
        this.pendingBatchMap.delete(batchKey)
      }
      else {
        batch.tasks = remainingTasks
        batch.totalCharacters = remainingCharacters
      }
    }

    for (const task of Array.from(this.inFlightTasks)) {
      if (predicate(task.data) && this.cancelTask(task, reason))
        cancelledCount++
    }

    if (cancelledCount > 0)
      this.schedule()

    return cancelledCount
  }

  private schedule() {
    if (this.nextScheduleTimer) {
      clearTimeout(this.nextScheduleTimer)
      this.nextScheduleTimer = null
    }

    const now = Date.now()
    const batchesToFlush: string[] = []

    for (const [batchKey, batch] of this.pendingBatchMap.entries()) {
      const shouldFlushNow = this.shouldFlushBatch(batch)
      const isTimedOut = now >= batch.createdAt + this.batchDelay

      if (shouldFlushNow || isTimedOut)
        batchesToFlush.push(batchKey)
    }

    for (const batchKey of batchesToFlush)
      this.flushPendingBatchByKey(batchKey)

    if (this.pendingBatchMap.size > 0) {
      this.nextScheduleTimer = setTimeout(() => {
        this.nextScheduleTimer = null
        this.schedule()
      }, this.batchDelay)
    }
  }

  private addTaskToBatch(task: BatchTask<T, R>, batchKey: string) {
    const characters = this.getCharacters(task.data)
    const taskBudget = this.getMaxCharactersForTask?.(task.data)
    const resolvedBudget = Math.max(characters, taskBudget ?? this.maxCharactersPerBatch)
    const existingBatch = this.pendingBatchMap.get(batchKey)

    if (existingBatch) {
      const batchBudget = existingBatch.maxCharactersBudget
      if (existingBatch.totalCharacters + characters <= batchBudget) {
        existingBatch.tasks.push(task)
        existingBatch.totalCharacters += characters
      }
      else {
        this.flushPendingBatchByKey(batchKey)
        this.createNewPendingBatch(task, batchKey, resolvedBudget)
      }
    }
    else {
      this.createNewPendingBatch(task, batchKey, resolvedBudget)
    }
  }

  private shouldFlushBatch(batch: PendingBatch<T, R>): boolean {
    return (
      batch.tasks.length >= this.maxItemsPerBatch
      || batch.totalCharacters >= batch.maxCharactersBudget
    )
  }

  private createNewPendingBatch(task: BatchTask<T, R>, batchKey: string, maxCharactersBudget: number) {
    const pendingBatch: PendingBatch<T, R> = {
      id: crypto.randomUUID(),
      tasks: [task],
      totalCharacters: this.getCharacters(task.data),
      createdAt: Date.now(),
      maxCharactersBudget,
    }

    this.pendingBatchMap.set(batchKey, pendingBatch)
  }

  private flushPendingBatchByKey(batchKey: string) {
    const pendingBatch = this.pendingBatchMap.get(batchKey)
    if (!pendingBatch)
      return

    this.pendingBatchMap.delete(batchKey)

    const { tasks } = pendingBatch

    void this.executeBatchWithRetry(tasks, batchKey, 0)
  }

  private async executeBatchWithRetry(tasks: BatchTask<T, R>[], batchKey: string, retryCount: number): Promise<void> {
    const activeTasks = tasks.filter(task => !task.cancelled)
    if (activeTasks.length === 0)
      return

    activeTasks.forEach(task => this.inFlightTasks.add(task))

    try {
      const results = await this.executeBatch(activeTasks.map(task => task.data))

      if (!results)
        throw new Error('Batch execution results are undefined')

      if (results.length !== activeTasks.length) {
        throw new Error(`Batch result count mismatch: expected ${activeTasks.length}, got ${results.length}.\nResults: ["${results.join('\",\n\"')}"]`)
      }

      activeTasks.forEach((task, index) => {
        if (!task.cancelled)
          task.resolve(results[index])
      })
    }
    catch (error) {
      const err = error as Error

      this.onError?.(err, { batchKey, retryCount, isFallback: false })

      if (retryCount < this.maxRetries) {
        const delay = this.calculateBackoffDelay(retryCount)
        await this.sleep(delay)
        return this.executeBatchWithRetry(tasks, batchKey, retryCount + 1)
      }

      if (this.enableFallbackToIndividual && this.executeIndividual)
        return this.executeFallbackIndividual(tasks, batchKey)

      activeTasks.forEach((task) => {
        if (!task.cancelled)
          task.reject(err)
      })
    }
    finally {
      activeTasks.forEach(task => this.inFlightTasks.delete(task))
      this.schedule()
    }
  }

  private async executeFallbackIndividual(tasks: BatchTask<T, R>[], batchKey: string) {
    await Promise.allSettled(
      tasks.map(async (task) => {
        if (task.cancelled)
          return

        try {
          if (!this.executeIndividual)
            throw new Error('executeIndividual is not defined')

          const result = await this.executeIndividual(task.data)
          if (!task.cancelled)
            task.resolve(result)
        }
        catch (error) {
          const err = error as Error
          this.onError?.(err, { batchKey, retryCount: this.maxRetries, isFallback: true })
          if (!task.cancelled)
            task.reject(err)
        }
      }),
    )
  }

  private calculateBackoffDelay(retryCount: number): number {
    return Math.min(BASE_BACKOFF_DELAY_MS * (2 ** retryCount), MAX_BACKOFF_DELAY_MS)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private cancelTask(task: BatchTask<T, R>, reason: string): boolean {
    if (task.cancelled)
      return false

    task.cancelled = true
    task.reject(createAbortError(reason))
    this.inFlightTasks.delete(task)
    return true
  }

  setBatchConfig(config: Partial<Pick<BatchOptions<T, R>, 'maxCharactersPerBatch' | 'maxItemsPerBatch'>>) {
    const parseConfigStatus = batchQueueConfigSchema.partial().safeParse(config)
    if (parseConfigStatus.error)
      throw new Error(parseConfigStatus.error.issues[0].message)

    this.maxCharactersPerBatch = config.maxCharactersPerBatch ?? this.maxCharactersPerBatch
    this.maxItemsPerBatch = config.maxItemsPerBatch ?? this.maxItemsPerBatch
  }
}
