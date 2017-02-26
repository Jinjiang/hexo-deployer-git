'use strict';

var pathFn = require('path');
var fs = require('hexo-fs');
var chalk = require('chalk');
var swig = require('swig');
var moment = require('moment');
var Promise = require('bluebird');
var spawn = require('hexo-util/lib/spawn');
var CacheStream = require('hexo-util/lib/cache_stream');
var parseConfig = require('./parse_config');
var cp = require('child_process')

var swigHelpers = {
  now: function(format) {
    return moment().format(format);
  }
};

function exec(command, options) {
  function getCache(stream, encoding) {
    var buf = stream.getCache();
    stream.destroy();
    if (!encoding) return buf;

    return buf.toString(encoding);
  }
  options = options || {};
  return new Promise(function(resolve, reject) {
    var task = cp.exec(command, options);
    var verbose = options.verbose;
    var encoding = options.hasOwnProperty('encoding') ? options.encoding : 'utf8';
    var stdoutCache = new CacheStream();
    var stderrCache = new CacheStream();

    if (task.stdout) {
      var stdout = task.stdout.pipe(stdoutCache);
      if (verbose) stdout.pipe(process.stdout);
    }

    if (task.stderr) {
      var stderr = task.stderr.pipe(stderrCache);
      if (verbose) stderr.pipe(process.stderr);
    }

    task.on('close', function(code) {
      if (code) {
        var e = new Error(getCache(stderrCache, encoding));
        e.code = code;

        return reject(e);
      }

      resolve(getCache(stdoutCache, encoding));
    });

    task.on('error', reject);

    // Listen to exit events if neither stdout and stderr exist (inherit stdio)
    if (!task.stdout && !task.stderr) {
      task.on('exit', function(code) {
        if (code) {
          var e = new Error('Spawn failed');
          e.code = code;

          return reject(e);
        }

        resolve();
      });
    }
  });
}

module.exports = function(args) {
  var baseDir = this.base_dir;
  var deployDir = pathFn.join(baseDir, '.deploy_git');
  var publicDir = this.public_dir;
  var extendDirs = args.extend_dirs;
  var ignoreHidden = args.ignore_hidden;
  var targetDir = args.target_dir;
  var log = this.log;
  var message = commitMessage(args);
  var verbose = !args.silent;

  if (!args.repo && process.env.HEXO_DEPLOYER_REPO) {
    args.repo = process.env.HEXO_DEPLOYER_REPO;
  }

  if (!args.repo && !args.repository) {
    var help = '';

    help += 'You have to configure the deployment settings in _config.yml first!\n\n';
    help += 'Example:\n';
    help += '  deploy:\n';
    help += '    type: git\n';
    help += '    repo: <repository url>\n';
    help += '    branch: [branch]\n';
    help += '    message: [message]\n\n';
    help += '    extend_dirs: [extend directory]\n\n';
    help += 'For more help, you can check the docs: ' + chalk.underline('http://hexo.io/docs/deployment.html');

    console.log(help);
    return;
  }

  function git() {
    var len = arguments.length;
    var args = new Array(len);

    for (var i = 0; i < len; i++) {
      args[i] = arguments[i];
    }
    return spawn('git', args, {
      cwd: deployDir,
      verbose: verbose
    });
  }

  function setup() {
    var userName = args.name || args.user || args.userName || '';
    var userEmail = args.email || args.userEmail || '';

    // Create a placeholder for the first commit
    return fs.writeFile(pathFn.join(deployDir, 'placeholder'), '').then(function() {
      return git('init');
    }).then(function() {
      return userName && git('config', 'user.name', userName);
    }).then(function() {
      return userEmail && git('config', 'user.email', userEmail);
    }).then(function() {
      return git('add', '-A');
    }).then(function() {
      return git('commit', '-m', 'First commit');
    });
  }

  function push(repo) {
    return git('add', '-A').then(function() {
      if (targetDir) {
        return fs.mkdir(pathFn.join(deployDir, '.' + targetDir)).then(function() {
          return exec('git mv * .' + targetDir, {
            cwd: deployDir,
            verbose: verbose
          })
        }).then(function() {
          return exec('git mv .' + targetDir + ' ' + targetDir, {
            cwd: deployDir,
            verbose: verbose
          })
        })
      }
      return Promise.resolve(true)
    }).then(function() {
      return git('commit', '-m', message).catch(function() {
        // Do nothing. It's OK if nothing to commit.
      });
    }).then(function() {
      return git('push', '-u', repo.url, 'HEAD:' + repo.branch, '--force');
    });
  }

  return fs.exists(deployDir).then(function(exist) {
    if (exist) return;

    log.info('Setting up Git deployment...');
    return setup();
  }).then(function() {
    log.info('Clearing .deploy_git folder...');
    return fs.emptyDir(deployDir);
  }).then(function() {
    var opts = {};
    log.info('Copying files from public folder...');
    if (typeof ignoreHidden === 'object') {
      opts.ignoreHidden = ignoreHidden.public;
    } else {
      opts.ignoreHidden = ignoreHidden;
    }

    return fs.copyDir(publicDir, deployDir, opts);
  }).then(function() {
    log.info('Copying files from extend dirs...');

    if (!extendDirs) {
      return;
    }

    if (typeof extendDirs === 'string') {
      extendDirs = [extendDirs];
    }

    var mapFn = function(dir) {
      var opts = {};
      var extendPath = pathFn.join(baseDir, dir);
      var extendDist = pathFn.join(deployDir, dir);

      if (typeof ignoreHidden === 'object') {
        opts.ignoreHidden = ignoreHidden[dir];
      } else {
        opts.ignoreHidden = ignoreHidden;
      }

      return fs.copyDir(extendPath, extendDist, opts);
    };

    return Promise.map(extendDirs, mapFn, {
      concurrency: 2
    });
  }).then(function() {
    return parseConfig(args);
  }).each(function(repo) {
    return push(repo);
  });
};

function commitMessage(args) {
  var message = args.m || args.msg || args.message || 'Site updated: {{ now(\'YYYY-MM-DD HH:mm:ss\') }}';
  return swig.compile(message)(swigHelpers);
}
