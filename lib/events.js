/* @flow */
'use strict'

import Promise from 'bluebird'
import events from 'events'

import {isFunction, camelToSnake} from'./helper'

export function bindAll (object: any, context?: any) {
  context = context || this

  var bindMethod = function (method) {
    if (context) {
      context.on(camelToSnake(method.substr(2)), () => {
        var args = Array.prototype.slice.call(arguments, 0)
        args.push(context)
        object[method].apply(object, args)
      })
    }
  }

  for (var method in object) {
    if (isFunction(object[method]) && method.substr(0, 2) === 'on') {
      bindMethod(method)
    }
  }
}

export function bufferEvents (emitter: events.EventEmitter, eventsToBuffer: string[]) {
  var listeners = []
  var eventsToReply = []
  var genericListener = function () {
    eventsToReply.push(Array.prototype.slice.call(arguments))
  }

  eventsToBuffer.forEach(function (eventName) {
    var listener = genericListener.bind(null, eventName)
    listeners.push(listener)
    emitter.on(eventName, listener)
  })

  return function () {
    if (!eventsToReply) {
      return
    }

    // remove all buffering listeners
    listeners.forEach(function (listener, i) {
      emitter.removeListener(eventsToBuffer[i], listener)
    })

    // reply
    eventsToReply.forEach(function (args) {
      events.EventEmitter.prototype.emit.apply(emitter, args)
    })

    // free-up
    listeners = []
    eventsToReply = []
  }
}

// TODO(vojta): log.debug all events
export class EventEmitter extends events.EventEmitter {
  emitAsync (name: string) {
    // TODO(vojta): allow passing args
    // TODO(vojta): ignore/throw if listener call done() multiple times
    var pending = this.listeners(name).length
    return new Promise((resolve, reject) => {
      var done = function () {
        if (!--pending) {
          resolve()
        }
      }

      this.emit(name, done)

      if (!pending) {
        resolve()
      }
    })
  }

  bind (object: any, context?: any) {
    return bindAll(object, context)
  }
}
