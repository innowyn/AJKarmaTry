/* @flow */
'use strict'

const fs = require('graceful-fs')
const path = require('path')
const _ = require('lodash')
const useragent = require('useragent')
const Promise = require('bluebird')
const mm = require('minimatch')

exports.browserFullNameToShort = function (fullName: string) {
  var agent = useragent.parse(fullName)
  var isKnown = agent.family !== 'Other' && agent.os.family !== 'Other'
  return isKnown ? agent.toAgent() + ' (' + agent.os + ')' : fullName
}

exports.isDefined = function (value: any) {
  return !_.isUndefined(value)
}

var parser = function (pattern, out) {
  if (pattern.length === 0) return out
  var p = /^(\[[^\]]*]|[*+@?]\((.+?)\))/g
  var matches = p.exec(pattern)
  if (!matches) {
    var c = pattern[0]
    var t = 'word'
    if (c === '*') {
      t = 'star'
    } else if (c === '?') {
      t = 'optional'
    }
    out[t]++
    return parser(pattern.substring(1), out)
  }
  if (matches[2] !== undefined) {
    out.ext_glob++
    parser(matches[2], out)
    return parser(pattern.substring(matches[0].length), out)
  }
  out.range++
  return parser(pattern.substring(matches[0].length), out)
}

var gsParser = function (pattern, out) {
  if (pattern === '**') {
    out.glob_star++
    return out
  }
  return parser(pattern, out)
}

var compareWeightObject = function (w1, w2) {
  return exports.mmComparePatternWeights(
    [w1.glob_star, w1.star, w1.ext_glob, w1.range, w1.optional],
    [w2.glob_star, w2.star, w2.ext_glob, w2.range, w2.optional]
  )
}

exports.mmPatternWeight = function (pattern: ?string) {
  var m = new mm.Minimatch(pattern)
  if (!m.globParts) {
    return [0, 0, 0, 0, 0, 0]
  }
  var result = m.globParts.reduce(function (prev, p) {
    var r = p.reduce(function (prev, p) {
      return gsParser(p, prev)
    }, {glob_star: 0, ext_glob: 0, word: 0, star: 0, optional: 0, range: 0})
    if (prev === undefined) return r
    return compareWeightObject(r, prev) > 0 ? r : prev
  }, undefined)

  result.glob_sets = m.set.length

  return [result.glob_sets, result.glob_star, result.star, result.ext_glob, result.range, result.optional]
}

type Weight = number[]

exports.mmComparePatternWeights = function (weight1: Weight, weight2: Weight) : number {
  var n1 = weight1[0]
  var n2 = weight2[0]
  var diff = n1 - n2
  if (diff !== 0) {
    return diff / Math.abs(diff)
  }
  return weight1.length > 1 ? exports.mmComparePatternWeights(weight1.slice(1), weight2.slice(1)) : 0
}

exports.isFunction = _.isFunction
exports.isString = _.isString
exports.isObject = _.isObject
exports.isArray = _.isArray

var ABS_URL = /^https?:\/\//
exports.isUrlAbsolute = function (url: string): boolean {
  return ABS_URL.test(url)
}

exports.camelToSnake = function (camelCase: string): string {
  return camelCase.replace(/[A-Z]/g, function (match, pos) {
    return (pos > 0 ? '_' : '') + match.toLowerCase()
  })
}

exports.ucFirst = function (word: string): string {
  return word.charAt(0).toUpperCase() + word.substr(1)
}

exports.dashToCamel = function (dash: string): string {
  var words = dash.split('-')
  return words.shift() + words.map(exports.ucFirst).join('')
}

exports.arrayRemove = function<T> (collection: T[], item: T): boolean {
  var idx = collection.indexOf(item)

  if (idx !== -1) {
    collection.splice(idx, 1)
    return true
  }

  return false
}

exports.merge = function () {
  var args = Array.prototype.slice.call(arguments, 0)
  args.unshift({})
  return _.merge.apply({}, args)
}

exports.formatTimeInterval = function (time: number): string {
  var mins = Math.floor(time / 60000)
  var secs = (time - mins * 60000) / 1000
  var str = secs + (secs === 1 ? ' sec' : ' secs')

  if (mins) {
    str = mins + (mins === 1 ? ' min ' : ' mins ') + str
  }

  return str
}

var replaceWinPath = function (path: string): string {
  return _.isString(path) ? path.replace(/\\/g, '/') : path
}

exports.normalizeWinPath = process.platform === 'win32' ? replaceWinPath : _.identity

exports.mkdirIfNotExists = function mkdir (directory: string, done: () => void) {
  // TODO(vojta): handle if it's a file
  /* eslint-disable handle-callback-err */
  fs.stat(directory, function (err, stat) {
    if (stat && stat.isDirectory()) {
      done()
    } else {
      mkdir(path.dirname(directory), function () {
        fs.mkdir(directory, done)
      })
    }
  })
  /* eslint-enable handle-callback-err */
}

exports.defer = function () {
  var resolve
  var reject
  var promise = new Promise(function () {
    resolve = arguments[0]
    reject = arguments[1]
  })

  return {
    resolve: resolve,
    reject: reject,
    promise: promise
  }
}
