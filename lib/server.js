/* @flow */
'use strict'

const SocketIO = require('socket.io')
const di = require('di')
const util = require('util')
const Promise = require('bluebird')
const spawn = require('child_process').spawn
const tmp = require('tmp')
const fs = require('fs')
const path = require('path')
const root = global || window || this

const cfg = require('./config')
const logger = require('./logger')
const constant = require('./constants')
const watcher = require('./watcher')
const plugin = require('./plugin')

const ws = require('./web-server')
const preprocessor = require('./preprocessor')
const Launcher = require('./launcher').Launcher
const FileList = require('./file-list')
const reporter = require('./reporter')
const helper = require('./helper')
const events = require('./events')
const EventEmitter = events.EventEmitter
import Executor from './executor'
const Browser = require('./browser')
const BrowserCollection = require('./browser_collection')
const EmitterWrapper = require('./emitter_wrapper')
const processWrapper = new EmitterWrapper(process)

type Config = typeof cfg.Config.prototype

function createSocketIoServer (webServer, executor, config) {
  var server = new SocketIO(webServer, {
    // avoid destroying http upgrades from socket.io to get proxied websockets working
    destroyUpgrade: false,
    path: config.urlRoot + 'socket.io/',
    transports: config.transports,
    forceJSONP: config.forceJSONP
  })

  // hack to overcome circular dependency
  executor.socketIoSockets = server.sockets

  return server
}

class Server extends EventEmitter {
  // TODO: logger type
  log: any
  loadErrors: [string, string][]
  _injector: typeof di.Injector
  _fileList: typeof FileList

  constructor (cliOptions: {[id:string]: any}, done?: (Error) => void) {
    super()

    logger.setupFromConfig(cliOptions)

    this.log = logger.create()
    this.loadErrors = []

    var config = cfg.parseConfig(cliOptions.configFile, cliOptions)

    var modules = [{
      helper: ['value', helper],
      logger: ['value', logger],
      done: ['value', done || process.exit],
      emitter: ['value', this],
      server: ['value', this],
      launcher: ['type', Launcher],
      config: ['value', config],
      preprocess: ['factory', preprocessor.createPreprocessor],
      fileList: ['type', FileList],
      webServer: ['factory', ws.create],
      socketServer: ['factory', createSocketIoServer],
      executor: ['type', Executor],
      // TODO(vojta): remove
      customFileHandlers: ['value', []],
      // TODO(vojta): remove, once karma-dart does not rely on it
      customScriptTypes: ['value', []],
      reporter: ['factory', reporter.createReporters],
      capturedBrowsers: ['type', BrowserCollection],
      args: ['value', {}],
      timer: ['value', {
        setTimeout: function () {
          return setTimeout.apply(root, arguments)
        },
        clearTimeout: function (timeoutId) {
          clearTimeout(timeoutId)
        }
      }]
    }]

    this._setUpLoadErrorListener()
    // Load the plugins
    modules = modules.concat(
      plugin.resolve(config.plugins, this)
    )

    this._injector = new di.Injector(modules)
  }

  // Public Methods
  // --------------

  // Start the server
  start () {
    this._injector.invoke(this._start, this)
  }

  // Get properties from the injector
  get (token: string) {
    return this._injector.get(token)
  }

  // Force a refresh of the file list
  refreshFiles () {
    if (!this._fileList) return Promise.resolve()

    return this._fileList.refresh()
  }

  // Private Methods
  // ---------------

  _start (
    config: Config,
    launcher: typeof Launcher,
    // TODO: typedef for perprocessors
    preprocess: any,
    fileList: typeof FileList,
    capturedBrowsers: typeof BrowserCollection,
    executor: Executor,
    done: (number) => void
  ) {
    var self = this
    if (config.detached) {
      this._detach(config, done)
      return
    }

    self._fileList = fileList

    config.frameworks.forEach(function (framework) {
      self._injector.get('framework:' + framework)
    })

    var webServer = self._injector.get('webServer')
    var socketServer = self._injector.get('socketServer')

    // A map of launched browsers.
    var singleRunDoneBrowsers = Object.create(null)

    // Passing fake event emitter, so that it does not emit on the global,
    // we don't care about these changes.
    var singleRunBrowsers = new BrowserCollection(new EventEmitter())

    // Some browsers did not get captured.
    var singleRunBrowserNotCaptured = false

    webServer.on('error', function (e) {
      if (e.code === 'EADDRINUSE') {
        self.log.warn('Port %d in use', config.port)
        config.port++
        webServer.listen(config.port)
      } else {
        throw e
      }
    })

    var afterPreprocess = function () {
      if (config.autoWatch) {
        self._injector.invoke(watcher.watch)
      }

      webServer.listen(config.port, function () {
        self.log.info('Karma v%s server started at %s//%s:%s%s', constant.VERSION,
                      config.protocol, config.hostname, config.port, config.urlRoot)

        self.emit('listening', config.port)
        if (config.browsers && config.browsers.length) {
          self._injector.invoke(launcher.launch, launcher).forEach(function (browserLauncher) {
            singleRunDoneBrowsers[browserLauncher.id] = false
          })
        }
        var noLoadErrors = self.loadErrors.length
        if (noLoadErrors > 0) {
          self.log.error('Found %d load error%s', noLoadErrors, noLoadErrors === 1 ? '' : 's')
          process.kill(process.pid, 'SIGINT')
        }
      })
    }

    fileList.refresh().then(afterPreprocess, afterPreprocess)

    self.on('browsers_change', function () {
      // TODO(vojta): send only to interested browsers
      socketServer.sockets.emit('info', capturedBrowsers.serialize())
    })

    self.on('browser_register', function (browser) {
      launcher.markCaptured(browser.id)

      // TODO(vojta): This is lame, browser can get captured and then
      // crash (before other browsers get captured).
      if (launcher.areAllCaptured()) {
        self.emit('browsers_ready')

        if (config.autoWatch) {
          executor.schedule()
        }
      }
    })

    var logOpts = config.browserConsoleLogOptions
    if (logOpts && logOpts.path) {
      var configLevel = logOpts.level || 'debug'
      var configFormat = logOpts.format || '%b %T: %m'
      var configPath = logOpts.path
      self.log.info('Writing browser console to file: %s', configPath)
      var browserLogFile = fs.openSync(configPath, 'w+')
      var levels = ['log', 'error', 'warn', 'info', 'debug']
      self.on('browser_log', function (browser, message, level) {
        if (levels.indexOf(level.toLowerCase()) > levels.indexOf(configLevel)) return
        if (!helper.isString(message)) {
          message = util.inspect(message, {showHidden: false, colors: false})
        }
        var logMap = {'%m': message, '%t': level.toLowerCase(), '%T': level.toUpperCase(), '%b': browser}
        var logString = configFormat.replace(/%[mtTb]/g, function (m) {
          return logMap[m]
        })
        self.log.debug('Writing browser console line: %s', logString)
        fs.write(browserLogFile, logString + '\n')
      })
    }

    var EVENTS_TO_REPLY = ['start', 'info', 'karma_error', 'result', 'complete']
    socketServer.sockets.on('connection', function (socket) {
      self.log.debug('A browser has connected on socket ' + socket.id)

      var replySocketEvents = events.bufferEvents(socket, EVENTS_TO_REPLY)

      socket.on('complete', function (data, ack) {
        ack()
      })

      socket.on('register', function (info) {
        var newBrowser
        var isRestart

        if (info.id) {
          newBrowser = capturedBrowsers.getById(info.id) || singleRunBrowsers.getById(info.id)
        }

        if (newBrowser) {
          isRestart = newBrowser.state === Browser.STATE_DISCONNECTED
          newBrowser.reconnect(socket)

          // We are restarting a previously disconnected browser.
          if (isRestart && config.singleRun) {
            newBrowser.execute(config.client)
          }
        } else {
          newBrowser = self._injector.createChild([{
            id: ['value', info.id || null],
            fullName: ['value', (helper.isDefined(info.displayName) ? info.displayName : info.name)],
            socket: ['value', socket]
          }]).instantiate(Browser)

          newBrowser.init()

          // execute in this browser immediately
          if (config.singleRun) {
            newBrowser.execute(config.client)
            singleRunBrowsers.add(newBrowser)
          }
        }

        replySocketEvents()
      })
    })

    var emitRunCompleteIfAllBrowsersDone = function () {
      // all browsers done
      var isDone = Object.keys(singleRunDoneBrowsers).reduce(function (isDone, id) {
        return isDone && singleRunDoneBrowsers[id]
      }, true)

      if (isDone) {
        var results = singleRunBrowsers.getResults()
        if (singleRunBrowserNotCaptured) {
          results.exitCode = 1
        } else if (results.success + results.failed === 0 && !config.failOnEmptyTestSuite) {
          results.exitCode = 0
          self.log.warn('Test suite was empty.')
        }
        self.emit('run_complete', singleRunBrowsers, results)
      }
    }

    self.on('browser_complete', function (completedBrowser) {
      if (completedBrowser.lastResult.disconnected &&
          completedBrowser.disconnectsCount <= config.browserDisconnectTolerance) {
        self.log.info('Restarting %s (%d of %d attempts)', completedBrowser.name,
                      completedBrowser.disconnectsCount, config.browserDisconnectTolerance)

        if (!launcher.restart(completedBrowser.id)) {
          self.emit('browser_restart_failure', completedBrowser)
        }
      } else {
        self.emit('browser_complete_with_no_more_retries', completedBrowser)
      }
    })

    if (config.singleRun) {
      self.on('browser_restart_failure', function (completedBrowser) {
        singleRunDoneBrowsers[completedBrowser.id] = true
        emitRunCompleteIfAllBrowsersDone()
      })
      self.on('browser_complete_with_no_more_retries', function (completedBrowser) {
        singleRunDoneBrowsers[completedBrowser.id] = true

        if (launcher.kill(completedBrowser.id)) {
          // workaround to supress "disconnect" warning
          completedBrowser.state = Browser.STATE_DISCONNECTED
        }

        emitRunCompleteIfAllBrowsersDone()
      })

      self.on('browser_process_failure', function (browserLauncher) {
        singleRunDoneBrowsers[browserLauncher.id] = true
        singleRunBrowserNotCaptured = true

        emitRunCompleteIfAllBrowsersDone()
      })

      self.on('run_complete', function (browsers, results) {
        self.log.debug('Run complete, exiting.')
        disconnectBrowsers(results.exitCode)
      })

      self.emit('run_start', singleRunBrowsers)
    }

    if (config.autoWatch) {
      self.on('file_list_modified', function () {
        self.log.debug('List of files has changed, trying to execute')
        if (config.restartOnFileChange) {
          socketServer.sockets.emit('stop')
        }
        executor.schedule()
      })
    }

    var webServerCloseTimeout = 3000
    var disconnectBrowsers = function (code) {
      // Slightly hacky way of removing disconnect listeners
      // to suppress "browser disconnect" warnings
      // TODO(vojta): change the client to not send the event (if disconnected by purpose)
      var sockets = socketServer.sockets.sockets

      Object.keys(sockets).forEach(function (id) {
        var socket = sockets[id]
        socket.removeAllListeners('disconnect')
        if (!socket.disconnected) {
          // Disconnect asynchronously. Socket.io mutates the `sockets.sockets` array
          // underneath us so this would skip every other browser/socket.
          process.nextTick(socket.disconnect.bind(socket))
        }
      })

      var removeAllListenersDone = false
      var removeAllListeners = function () {
        // make sure we don't execute cleanup twice
        if (removeAllListenersDone) {
          return
        }
        removeAllListenersDone = true
        webServer.removeAllListeners()
        processWrapper.removeAllListeners()
        done(code || 0)
      }

      self.emitAsync('exit').then(function () {
        // don't wait forever on webServer.close() because
        // pending client connections prevent it from closing.
        var closeTimeout = setTimeout(removeAllListeners, webServerCloseTimeout)

        // shutdown the server...
        webServer.close(function () {
          clearTimeout(closeTimeout)
          removeAllListeners()
        })
      })
    }

    processWrapper.on('SIGINT', disconnectBrowsers)
    processWrapper.on('SIGTERM', disconnectBrowsers)

    // Handle all unhandled exceptions, so we don't just exit but
    // disconnect the browsers before exiting.
    processWrapper.on('uncaughtException', function (error) {
      self.log.error(error)
      disconnectBrowsers(1)
    })
  }

  _setUpLoadErrorListener () {
    this.on('load_error', (type, name) => {
      this.log.debug('Registered a load error of type %s with name %s', type, name)
      this.loadErrors.push([type, name])
    })
  }

  _detach (config: Config, done: (number) => void) {
    var log = this.log
    var tmpFile = tmp.fileSync({keep: true})
    log.info('Starting karma detached')
    log.info('Run "karma stop" to stop the server.')
    log.debug('Writing config to tmp-file %s', tmpFile.name)
    config.detached = false
    try {
      fs.writeFileSync(tmpFile.name, JSON.stringify(config), 'utf8')
    } catch (e) {
      log.error("Couldn't write temporary configuration file")
      done(1)
      return
    }
    var child = spawn(process.argv[0], [path.resolve(__dirname, '../lib/detached.js'), tmpFile.name], {
      detached: true,
      stdio: 'ignore'
    })

    child.unref()
  }
}

// Export
// ------

module.exports = Server
