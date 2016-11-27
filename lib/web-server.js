/* @flow */
'use strict'

const fs = require('graceful-fs')
const http = require('http')
const https = require('https')
const path = require('path')
const connect = require('connect')
const Promise = require('bluebird')

const common = require('./middleware/common')
const runnerMiddleware = require('./middleware/runner')
const stopperMiddleware = require('./middleware/stopper')
const stripHostMiddleware = require('./middleware/strip_host')
const karmaMiddleware = require('./middleware/karma')
const sourceFilesMiddleware = require('./middleware/source_files')
const proxyMiddleware = require('./middleware/proxy')

const log = require('./logger').create('web-server')

import typeof FileList from './file-list'
import type EventEmitter from 'events'
import typeof Di from 'di'

const createCustomHandler = function (customFileHandlers, /* config.basePath */ basePath) {
  return function (request, response, next) {
    for (var i = 0; i < customFileHandlers.length; i++) {
      if (customFileHandlers[i].urlRegex.test(request.url)) {
        return customFileHandlers[i].handler(request, response, 'fake/static', 'fake/adapter',
          basePath, 'fake/root')
      }
    }

    return next()
  }
}

createCustomHandler.$inject = ['customFileHandlers', 'config.basePath']

export function create (injector: Di, emitter: EventEmitter, fileList: FileList) {
  const config = injector.get('config')
  common.initializeMimeTypes(config)
  const serveStaticFile = common.createServeFile(fs, path.normalize(path.join(__dirname, '/../static')), config)
  const serveFile = common.createServeFile(fs, null, config)
  const filesPromise = new common.PromiseContainer()

  // Set an empty list of files to avoid race issues with
  // file_list_modified not having been emitted yet
  filesPromise.set(Promise.resolve(fileList.files))

  emitter.on('file_list_modified', function (files) {
    filesPromise.set(Promise.resolve(files))
  })

  // locals for webserver module
  // NOTE(vojta): figure out how to do this with DI
  injector = injector.createChild([{
    serveFile: ['value', serveFile],
    serveStaticFile: ['value', serveStaticFile],
    filesPromise: ['value', filesPromise]
  }])

  const proxyMiddlewareInstance = injector.invoke(proxyMiddleware.create)

  log.debug('Instantiating middleware')
  const handler = connect()

  if (config.beforeMiddleware) {
    config.beforeMiddleware.forEach(function (middleware) {
      handler.use(injector.get('middleware:' + middleware))
    })
  }

  handler.use(injector.invoke(runnerMiddleware.create))
  handler.use(injector.invoke(stopperMiddleware.create))
  handler.use(injector.invoke(stripHostMiddleware.create))
  handler.use(injector.invoke(karmaMiddleware.create))
  handler.use(injector.invoke(sourceFilesMiddleware.create))
  // TODO(vojta): extract the proxy into a plugin
  handler.use(proxyMiddlewareInstance)
  // TODO(vojta): remove, this is only here because of karma-dart
  // we need a better way of custom handlers
  handler.use(injector.invoke(createCustomHandler))

  if (config.middleware) {
    config.middleware.forEach(function (middleware) {
      handler.use(injector.get('middleware:' + middleware))
    })
  }

  handler.use(function (request, response) {
    common.serve404(response, request.url)
  })

  let serverClass = http
  const serverArguments = [handler]

  if (config.protocol === 'https:') {
    serverClass = https
    serverArguments.unshift(config.httpsServerOptions || {})
  }

  if (config.httpModule) {
    serverClass = config.httpModule
  }

  const server = serverClass.createServer.apply(null, serverArguments)

  server.on('upgrade', function (req, socket, head) {
    log.debug('upgrade %s', req.url)
    proxyMiddlewareInstance.upgrade(req, socket, head)
  })

  return server
}
