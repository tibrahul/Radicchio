'use strict';
require('source-map-support').install();

var _ioredis = require('ioredis');

var _ioredis2 = _interopRequireDefault(_ioredis);

var _fs = require('fs');

var _fs2 = _interopRequireDefault(_fs);

var _bluebird = require('bluebird');

var _bluebird2 = _interopRequireDefault(_bluebird);

var _shortid = require('shortid');

var _shortid2 = _interopRequireDefault(_shortid);

var _events = require('eventemitter3');

var _events2 = _interopRequireDefault(_events);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// Radicchio imports
require('babel-core/register');

module.exports = function (redisUrl) {
  // Radicchio constants

  var redisURL = redisUrl || 'redis://localhost:6379';
  var redis = new _ioredis2.default(redisURL);
  var sub = new _ioredis2.default(redisURL);
  var emitter = new _events2.default();
  var radicchio = {};
  var setTTLSuffix = '-ttl-set';
  var setDataSuffix = '-data-set';
  var suspendedSuffix = '-suspended';
  var resumedSuffix = '-resumed';

  /**
  * Loads a lua file
  * @param {String} fileName - the lua file name to load from the lua folder
  * @returns {String} - the loaded file contents
  */
  function loadLuaFile(fileName) {
    var luaDirectory = __dirname + '/../src/lua/';
    return _fs2.default.readFileSync(luaDirectory + fileName, 'utf8');
  }

  /**
  * Update loop that runs once a second and targets redis keys to ensure expiration
  */
  function update() {
    radicchio.getAllTimesLeft();
    radicchio.getDataFromAllTimers();
  }

  /**
  * Sets up event-emitter events to react to Redis Pub/Sub
  * Current supported internal events: deleted, expired, suspended, and resumed
  * @param {String} event - the supported event name to listen for
  * @param {Function} - the callback function passed to event-emitter
  */
  radicchio.on = function (event, callback) {
    emitter.on(event, callback);
  };

  /**
  * Setup initial synchronous settings, events, commands, and files for Radicchio
  * @returns {Promise<Boolean>} - Resolves to true when initialized
  */
  radicchio.init = function () {
    var EVENT_DELETED = '__keyevent@0__:del';
    var EVENT_EXPIRED = '__keyevent@0__:expired';
    var EVENT_EXPIRE = '__keyevent@0__:expire';

    radicchio.globalSetId = _shortid2.default.generate();

    radicchio.timerSetId = radicchio.globalSetId + setTTLSuffix;
    radicchio.dataSetId = radicchio.globalSetId + setDataSuffix;

    return new _bluebird2.default(function (resolve) {
      // Load lua files
      var startFile = loadLuaFile('start.lua');
      var deleteFile = loadLuaFile('delete.lua');
      var getSetKeysFile = loadLuaFile('getSetKeys.lua');
      var getTimeLeftFile = loadLuaFile('getTimeLeft.lua');
      var suspendFile = loadLuaFile('suspend.lua');
      var resumeFile = loadLuaFile('resume.lua');
      var getDataFile = loadLuaFile('getTimerData.lua');
      var deleteFromSetsFile = loadLuaFile('deleteFromSets.lua');

      // Redis Pub/Sub config settings
      redis.config('SET', 'notify-keyspace-events', 'KEA');

      // Redis custom defined commands
      redis.defineCommand('startTimer', {
        numberOfKeys: 3,
        lua: startFile
      });

      redis.defineCommand('deleteTimer', {
        numberOfKeys: 2,
        lua: deleteFile
      });

      redis.defineCommand('getSetKeys', {
        numberOfKeys: 1,
        lua: getSetKeysFile
      });

      redis.defineCommand('getTimeLeft', {
        numberOfKeys: 1,
        lua: getTimeLeftFile
      });

      redis.defineCommand('suspendTimer', {
        numberOfKeys: 2,
        lua: suspendFile
      });

      redis.defineCommand('resumeTimer', {
        numberOfKeys: 2,
        lua: resumeFile
      });

      redis.defineCommand('getTimerData', {
        numberOfKeys: 1,
        lua: getDataFile
      });

      redis.defineCommand('deleteFromSets', {
        numberOfKeys: 2,
        lua: deleteFromSetsFile
      });

      // Event handler for Redis Pub/Sub events with the subscribing Redis client
      sub.on('message', function (channel, message) {
        if (channel === EVENT_DELETED) {
          if (message.indexOf(suspendedSuffix) >= 0) {
            emitter.emit('suspended', message);
          } else if (message.indexOf(setDataSuffix) >= 0) {
            radicchio.dataSetId = null;
          } else if (message.indexOf(setTTLSuffix) >= 0) {
            radicchio.timerSetId = null;
          } else if (message.indexOf(setTTLSuffix) === -1) {
            emitter.emit('deleted', message);
          }

          if (radicchio.timerSetId === null && radicchio.dataSetId === null) {
            radicchio.globalSetId = _shortid2.default.generate();
            radicchio.timerSetId = radicchio.globalSetId + setTTLSuffix;
            radicchio.dataSetId = radicchio.globalSetId + setDataSuffix;
          }
        } else if (channel === EVENT_EXPIRED && message.indexOf(setTTLSuffix) === -1) {
          radicchio.getTimerData(message).then(function (timerObj) {
            emitter.emit('expired', timerObj);
            redis.deleteFromSets(radicchio.timerSetId, radicchio.dataSetId, message, function () { });
          });
        } else if (channel === EVENT_EXPIRE && message.indexOf(resumedSuffix) >= 0) {
          emitter.emit('resumed', message);
        }
      });

      // Subscribe to the Redis Pub/Sub events with the subscribing Redis client
      sub.subscribe(EVENT_DELETED, EVENT_EXPIRED, EVENT_EXPIRE);

      // Setup the update function
      setInterval(update, 1000);

      resolve(true);
    });
  };

  /**
  * Generates an id for a set and a timer using shortid
  * Tracks the timer key in a Redis set and starts an expire on the timer key
  * @param {String} timeInMS - The timer length in milliseconds
  * @param {Object} data - data object to be associated with the timer
  * @returns {Promise<String|Error>} - Resolves to the started timer id
  */
  radicchio.startTimer = function (timeInMS, data) {
    var dataObj = data || {};

    return new _bluebird2.default(function (resolve, reject) {
      try {
        (function () {
          var timerId = _shortid2.default.generate();
          var dataStringified = JSON.stringify(dataObj);

          redis.startTimer(radicchio.timerSetId, timerId, radicchio.dataSetId, timeInMS, dataStringified, '', function (err, result) {
            if (err) {
              reject(err);
            } else if (result.toLowerCase() === 'ok') {
              resolve(timerId);
            }
          });
        })();
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
  * Suspends a timer by updating the TTL in the global Redis set and deleting the timer
  * @param {String} timerId - The timer id to be suspended
  * @returns {Promise<Boolean|Error>} - Resolves to true if suspended successfully
  */
  radicchio.suspendTimer = function (timerId) {
    return new _bluebird2.default(function (resolve, reject) {
      try {
        redis.suspendTimer(radicchio.timerSetId, timerId, timerId + suspendedSuffix, '', function (err, result) {
          if (err) {
            reject(err);
          } else if (result === 1) {
            resolve(true);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
  * Starts a new timer with the remaining TTL in milliseconds pulled from the global Redis set
  * @param {String} timerId - The timer id to be resumed
  * @returns {Promise<Boolean|Error>} - Resolves to true if resumed successfully
  */
  radicchio.resumeTimer = function (timerId) {
    return new _bluebird2.default(function (resolve, reject) {
      try {
        redis.resumeTimer(radicchio.timerSetId, timerId, timerId + resumedSuffix, '', function (err, result) {
          if (err) {
            reject(err);
          } else if (result.toLowerCase() === 'ok') {
            resolve(true);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
  * Deletes a timer from Redis and the global Redis set
  * @param {String} timerId - The timer id to be deleted
  * @returns {Promise<Object|Error>} - Resolves to an object containing associated timer data
  */
  radicchio.deleteTimer = function (timerId) {
    return new _bluebird2.default(function (resolve, reject) {
      try {
        redis.deleteTimer(radicchio.timerSetId, radicchio.dataSetId, timerId, '', function (err, result) {
          if (err) {
            reject(err);
          } else if (result !== 'nil') {
            var data = JSON.parse(result);
            resolve(data);
          } else {
            reject(null);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
  * Gets the TTL (time to live) in milliseconds on a timer in Redis
  * @param {String} timerId - The timer id get the time left on
  * @returns {Promise<Object(String, Number)|Error>} - Resolves to an object with the timer id and time left
  */
  radicchio.getTimeLeft = function (timerId) {
    return new _bluebird2.default(function (resolve, reject) {
      try {
        redis.getTimeLeft(timerId, '', function (err, timeLeft) {
          if (err) {
            reject(err);
          } else if (timeLeft >= 0) {
            var timerObj = {
              timerId: timerId,
              timeLeft: timeLeft
            };
            resolve(timerObj);
          } else if (timeLeft < 0) {
            resolve(null);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
  * Gets the TTL (time to live) in milliseconds on all timers in the global Redis set
  * Filters out any timers that have no time left or have expired
  * @returns {Promise<Array(Object(String, Number))}>|Error>} - Resolves to an array of objects with a timer id and time left
  */
  radicchio.getAllTimesLeft = function () {
    var promises = [];

    return new _bluebird2.default(function (resolve, reject) {
      try {
        redis.getSetKeys(radicchio.timerSetId, '', function (err, result) {
          if (err) {
            reject(err);
          } else {
            _lodash2.default.map(result, function (timerId) {
              promises.push(radicchio.getTimeLeft(timerId));
            });

            _bluebird2.default.all(promises).then(function (timerObjs) {
              var filtered = _lodash2.default.filter(timerObjs, function (timerObj) {
                return timerObj !== null && timerObj.timeLeft > 0;
              });

              resolve(filtered);
            });
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
  * Gets the data associated with a timer
  * @param {String} timerId - The timer id to get the associated data for
  * @returns {Promise<Object(String, Object)|Error>} - Resolves to an object with the timer id and associated timer data
  */
  radicchio.getTimerData = function (timerId) {
    return new _bluebird2.default(function (resolve, reject) {
      try {
        redis.getTimerData(radicchio.dataSetId, timerId, function (err, result) {
          if (err) {
            reject(err);
          } else {
            if (result === 'nil') {
              reject(null);
            } else {
              var data = JSON.parse(result);
              var timerObj = {
                timerId: timerId,
                data: data
              };

              resolve(timerObj);
            }
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
  * Get the data from all active timers (including suspended timers)
  * @returns {Promise<Array<Object(String, Object)>|Error>} - Resolves to an array of objects with a timer id and data object
  */
  radicchio.getDataFromAllTimers = function () {
    var promises = [];

    return new _bluebird2.default(function (resolve, reject) {
      try {
        redis.getSetKeys(radicchio.dataSetId, '', function (err, result) {
          if (err) {
            reject(err);
          } else {
            _lodash2.default.map(result, function (timerId) {
              promises.push(radicchio.getTimerData(timerId));
            });

            _bluebird2.default.all(promises).then(function (timerDataObjs) {
              resolve(timerDataObjs);
            });
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  };

  return radicchio;
};
//# sourceMappingURL=app.js.map
