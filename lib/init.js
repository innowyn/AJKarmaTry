var path = require('path')
var glob = require('glob')
var mm = require('minimatch')
var exec = require('child_process').exec
var inquirer = require('inquirer')

var helper = require('./helper')

// TODO(vojta): coverage
// TODO(vojta): html preprocessors
// TODO(vojta): SauceLabs
// TODO(vojta): BrowserStack

var logQueue = []
var printLogQueue = function () {
  while (logQueue.length) {
    logQueue.shift()()
  }
}

var NODE_MODULES_DIR = path.resolve(__dirname, '../..')

// Karma is not in node_modules, probably a symlink,
// use current working dir.
if (!/node_modules$/.test(NODE_MODULES_DIR)) {
  NODE_MODULES_DIR = path.resolve('node_modules')
}

var installPackage = function (pkgName) {
  // Do not install if already installed.
  try {
    require(NODE_MODULES_DIR + '/' + pkgName)
    return Promise.resolve(true)
  } catch (e) {}

  console.log('Missing plugin "%s". Installing...', pkgName)

  var options = {
    cwd: path.resolve(NODE_MODULES_DIR, '..')
  }

  return new Promise(function (resolve, reject) {
    exec('npm install ' + pkgName + ' --save-dev', options, function (err, stdout, stderr) {
      if (err) {
        return reject(err)
      }
      // Put the logs into the queue and print them after answering current question.
      // Otherwise the log would clobber the interactive terminal.
      logQueue.push(function () {
        if (!err) {
          console.log('%s successfully installed.', pkgName)
        } else if (/is not in the npm registry/.test(stderr)) {
          console.log('Failed to install "%s". It is not in the NPM registry!\n' +
                   '  Please install it manually.', pkgName)
        } else if (/Error: EACCES/.test(stderr)) {
          console.log('Failed to install "%s". No permissions to write in %s!\n' +
                   '  Please install it manually.', pkgName, options.cwd)
        } else {
          console.log('Failed to install "%s"\n  Please install it manually.', pkgName)
        }
      })

      resolve(true)
    })
  })
}

var validatePattern = function (pattern) {
  if (!glob.sync(pattern).length) {
    console.log('There is no file matching this pattern.\n')
  }

  return true
}

var validateBrowser = function (name) {
  // TODO(vojta): check if the path resolves to a binary
  return installPackage('karma-' + name.toLowerCase().replace('canary', '') + '-launcher')
}

var validateFramework = function (name) {
  if (!name) return true

  return installPackage('karma-' + name)
}

var validateRequireJs = function (useRequire) {
  if (!useRequire) return true

  return validateFramework('requirejs')
}

var questions = [{
  name: 'framework',
  message: 'Which testing framework do you want to use?',
  choices: ['mocha', 'jasmine', 'qunit', 'nodeunit', 'nunit', ''],
  type: 'rawlist',
  validate: validateFramework
}, {
  name: 'requirejs',
  message: 'Do you want to use Require.js?',
  type: 'confirm',
  default: false,
  validate: validateRequireJs
}, {
  name: 'browsers',
  message: 'Do you want to capture any browsers automatically?',
  choices: ['Chrome', 'ChromeCanary', 'Firefox', 'Safari', 'PhantomJS', 'Opera', 'IE'],
  type: 'checkbox',
  validate: function (browsers) {
    return browsers.reduce(function (valid, browser) {
      return valid && validateBrowser(browser)
    }, true)
  }
}, {
  name: 'files',
  message: 'What is the location of your source and test files?\n\nYou can use glob patterns, eg. "js/*.js" or "test/**/*Spec.js".\n',
  type: 'input',
  validate: validatePattern
}, {
  name: 'exclude',
  message: 'Should any of the files included by the previous patterns be excluded?\n\nYou can use glob patterns, eg. "**/*.swp".\n',
  type: 'input',
  validate: validatePattern
}, {
  name: 'generateTestMain',
  message: 'Do you wanna generate a bootstrap file for RequireJS?\n',
  type: 'confirm',
  default: true,
  when: function (answers) {
    return answers.requirejs
  }
}, {
  name: 'includedFiles',
  message: 'Which files do you want to include with <script> tag?\n\nThis should be a script that bootstraps your test by configuring Require.js and kicking __karma__.start(), probably your test-main.js file.\n',
  type: 'checkbox',
  validate: validatePattern,
  when: function (answers) {
    return answers.requirejs && !answers.generateTestMain
  }
}, {
  name: 'autoWatch',
  message: 'Do you want Karma to watch all the files and run the tests on change?\n',
  type: 'confirm',
  default: true
}]

var getBasePath = function (configFilePath, cwd) {
  var configParts = path.dirname(configFilePath).split(path.sep)
  var cwdParts = cwd.split(path.sep)
  var base = []

  while (configParts.length && configParts[0] === cwdParts[0]) {
    configParts.shift()
    cwdParts.shift()
  }

  while (configParts.length) {
    var part = configParts.shift()
    if (part === '..') {
      base.unshift(cwdParts.pop())
    } else if (part !== '.') {
      base.unshift('..')
    }
  }

  return base.join(path.sep)
}

var processAnswers = function (answers, basePath, testMainFile) {
  var processedAnswers = {
    basePath: basePath,
    files: answers.files,
    onlyServedFiles: [],
    exclude: answers.exclude,
    autoWatch: answers.autoWatch,
    generateTestMain: answers.generateTestMain,
    browsers: answers.browsers,
    frameworks: [],
    preprocessors: {}
  }

  if (answers.framework) {
    processedAnswers.frameworks.push(answers.framework)
  }

  if (answers.requirejs) {
    processedAnswers.frameworks.push('requirejs')
    processedAnswers.files = answers.includedFiles || []
    processedAnswers.onlyServedFiles = answers.files

    if (answers.generateTestMain) {
      processedAnswers.files.push(testMainFile)
    }
  }

  var allPatterns = answers.files.concat(answers.includedFiles || [])
  if (allPatterns.some(function (pattern) {
    return mm(pattern, '**/*.coffee')
  })) {
    installPackage('karma-coffee-preprocessor')
    processedAnswers.preprocessors['**/*.coffee'] = ['coffee']
  }

  return processedAnswers
}

exports.init = function (config) {
  inquirer.prompt(questions).then(function (answers) {
    console.log(answers)
    printLogQueue()

    var cwd = process.cwd()
    var configFile = config.configFile || 'karma.conf.js'
    var isCoffee = path.extname(configFile) === '.coffee'
    var testMainFile = isCoffee ? 'test-main.coffee' : 'test-main.js'
    var formatter = formatters.createForPath(configFile)
    var processedAnswers = processAnswers(answers, getBasePath(configFile, cwd), testMainFile)
    var configFilePath = path.resolve(cwd, configFile)
    var testMainFilePath = path.resolve(cwd, testMainFile)

    if (isCoffee) {
      installPackage('coffee-script')
    }

    if (processedAnswers.generateTestMain) {
      formatter.writeRequirejsConfigFile(testMainFilePath)
      console.log(colorScheme.success(
        'RequireJS bootstrap file generated at "' + testMainFilePath + '".\n'
      ))
    }

    formatter.writeConfigFile(configFilePath, processedAnswers)
    console.log(colorScheme.success('Config file generated at "' + configFilePath + '".\n'))
  })
}
