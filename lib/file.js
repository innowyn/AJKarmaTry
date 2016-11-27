/* @flow */
'use strict'

// File
// ====
//
// File object used for tracking files in `file-list.js`

const _ = require('lodash')

class File {
  path: string
  originalPath: string
  contentPath: string
  mtime: number
  isUrl: boolean
  doNotCache: boolean

  constructor (path: string, mtime: number, doNotCache: boolean) {
    // used for serving (processed path, eg some/file.coffee -> some/file.coffee.js)
    this.path = path

    // original absolute path, id of the file
    this.originalPath = path

    // where the content is stored (processed)
    this.contentPath = path

    this.mtime = mtime
    this.isUrl = false

    this.doNotCache = _.isUndefined(doNotCache) ? false : doNotCache
  }

  toString () {
    return this.path
  }
}

// PUBLIC
module.exports = File
