/* @flow */
'use strict'

type Listeners = {
  [id:string]: Array<() => void>
}

interface Emitter {
  addListener(event: string, listener: () => void): Emitter
}

class EmitterWrapper {
  emitter: Emitter
  listeners: Listeners

  constructor (emitter: Emitter) {
    this.listeners = {}
    this.emitter = emitter
  }

  on (event:string, listener: () => void) {
    this.addListener(event, listener)
  }

  addListener (event: string, listener: () => void) {
    this.emitter.addListener(event, listener)

    if (!this.listeners.hasOwnProperty(event)) {
      this.listeners[event] = []
    }

    this.listeners[event].push(listener)

    return this
  }

  removeAllListeners (event: ?string) {
    var events = event ? [event] : Object.keys(this.listeners)

    events.forEach((event) => {
      self.listeners[event].forEach(function (listener) {
        this.emitter.removeListener(event, listener)
      })

      delete self.listeners[event]
    })

    return this
  }
}

module.exports = EmitterWrapper
