/* @flow */
'use strict'

import {create} from './logger'
const log = create()

import typeof BrowserCollection from './browser_collection'
import type {Config} from './config'
import type {EventEmitter} from './events'

export default class Executor {
  config: Config
  emitter: EventEmitter
  executionScheduled: boolean
  pendingCount: number
  capturedBrowsers: BrowserCollection
  runningBrowsers: BrowserCollection
  // TODO: proper socket type
  socketIoSockets: any

  constructor (
    capturedBrowsers: BrowserCollection,
    config: Config,
    emitter: EventEmitter
  ) {
    this.capturedBrowsers = capturedBrowsers
    this.config = config
    this.emitter = emitter
    this.executionScheduled = false
    this.pendingCount = 0

    // bind all the events
    emitter.bind(this)
  }

  schedule () {
    const nonReady = []

    if (!this.capturedBrowsers.length) {
      log.warn(
        'No captured browser, open %s//%s:%s%s',
        this.config.protocol,
        this.config.hostname,
        this.config.port,
        this.config.urlRoot
      )
      return false
    }

    if (this.capturedBrowsers.areAllReady(nonReady)) {
      log.debug('All browsers are ready, executing')
      log.debug('Captured %s browsers', this.capturedBrowsers.length)
      this.executionScheduled = false
      this.capturedBrowsers.clearResults()
      this.capturedBrowsers.setAllToExecuting()
      this.pendingCount = this.capturedBrowsers.length
      this.runningBrowsers = this.capturedBrowsers.clone()
      this.emitter.emit('run_start', this.runningBrowsers)
      this.socketIoSockets.emit('execute', this.config.client)
      return true
    }

    log.info('Delaying execution, these browsers are not ready: ' + nonReady.join(', '))

    this.executionScheduled = true

    return false
  }


  onRunComplete () {
    if (this.executionScheduled) {
      this.schedule()
    }
  }

  onBrowserComplete () {
    this.pendingCount--

    if (!this._pendingCount) {
      // Ensure run_complete is emitted in the next tick
      // so it is never emitted before browser_complete
      setTimeout(() => {
        this.emitter.emit(
          'run_complete',
          this.runningBrowsers,
          this.runningBrowsers.getResults()
        )
      }, 0)
    }
  }
}
