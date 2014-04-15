var Runner = require('integra').Runner
  , Cover = require('integra').Cover
  , RCover = require('integra').RCover
  , f = require('util').format
  , path = require('path')
  , NodeVersionFilter = require('./filters/node_version_filter')
  // , MongoDBVersionFilter = require('./filters/mongodb_version_filter')
  , MongoDBTopologyFilter = require('./filters/mongodb_topology_filter')
  , FileFilter = require('integra').FileFilter
  , ServerManager = require('./tools/server_manager')
  , ReplSetManager = require('./tools/replset_manager');

/**
 * Standalone MongoDB Configuration
 */
var f = require('util').format;
var Logger = require('../lib/connection/logger');

var StandaloneConfiguration = function(options) {
  options = options || {};
  var host = options.host || 'localhost';
  var port = options.port || 27017;
  var db = options.db || 'integration_tests';
  var mongo = null;
  var manager = options.manager;

  // Create a topology function
  var topology = options.topology || function(self, _mongo) {
    return new _mongo.Server({
        host: self.host
      , port: self.port 
    });
  }

  return function(context) {
    mongo = require('../lib');

    return {    
      start: function(callback) {
        var self = this;

        // Start the db
        manager.start({purge:true, signal: -9}, function() {
          var server = topology(this, mongo);
          
          // Set up connect
          server.once('connect', function() {
            // Drop the database
            server.command(f("%s.$cmd", self.db), {dropDatabase: 1}, function(err, r) {
              server.destroy();
              callback();
            });
          });
          
          // Connect
          server.connect();
        });
      },

      stop: function(callback) {
        process.exit(0)
        manager.stop({signal: -15}, function() {
          callback();
        });        
      },

      restart: function(callback) {
        manager.restart(function() {
          callback();
        });
      },

      setup: function(callback) {
        callback();
      },

      teardown: function(callback) {
        callback();
      },

      newConnection: function(options, callback) {
        if(typeof options == 'function') {
          callback = options;
          options = {};
        }

        var server = topology(this, mongo);
        // Set up connect
        server.once('connect', function() {
          callback(null, server);
        });

        // Connect
        server.connect();
      },

      // Additional parameters needed
      require: mongo,
      port: port,
      host: host,
      db: db,
      manager: manager,
      writeConcern: function() { return {w: 1} }
    }
  }
}

// Set up the runner
var runner = new Runner({
    logLevel:'error'
  , runners: 1
  , failFast: true
});

var testFiles =[
  //   '/test/tests/functional/connection_tests.js'
  // , '/test/tests/functional/pool_tests.js'
  // , '/test/tests/functional/server_tests.js'
  // , '/test/tests/functional/replset_tests.js'
  , '/test/tests/functional/replset_failover_tests.js'
  // , '/test/tests/functional/basic_auth_tests.js'
  // , '/test/tests/functional/extend_pick_strategy_tests.js'
  // , '/test/tests/functional/mongos_tests.js'
]

// Add all the tests to run
testFiles.forEach(function(t) {
  if(t != "") runner.add(t);
});

// // Add the Coverage plugin
// runner.plugin(new Cover({
//  logLevel: "info"
//  , filters: [
//      /_tests.js/
//    , "js-bson"
//    , "/tests/"
//    , "/tools/"
//  ]
// }));

// // Add the RCoverage plugin
// runner.plugin(new RCover({
//    logLevel: "info"
//  , filters: [
//      /_tests.js/
//    , "js-bson"
//    , "/tests/"
//    , "/tools/"
//  ]
// }));

// Add a Node version plugin
runner.plugin(new NodeVersionFilter());
// // Add a MongoDB version plugin
// runner.plugin(new MongoDBVersionFilter());
// Add a Topology filter plugin
runner.plugin(new MongoDBTopologyFilter());

// Exit when done
runner.on('exit', function(errors, results) {
  process.exit(0)
});

// Set Logger level for driver
Logger.setLevel('info');
// Logger.filter('class', ['ReplSet', 'Server', 'Connection']);
// Logger.filter('class', ['Connection']);
Logger.filter('class', ['ReplSet', 'Server']);
//Logger.filter('class', ['Mongos', 'Server']);

// //
// // Single server topology
// var singleServerConfig = {
//     host: 'localhost'
//   , port: 27017
//   , manager: new ServerManager({
//     dbpath: path.join(path.resolve('db'), f("data-%d", 27017))
//   })
// }

//
// Replicaset server topology
var replicasetServerConfig = {
    host: 'localhost'
  , port: 31000
  , topology: function(self, _mongo) {
    return new _mongo.ReplSet([{
        host: 'localhost'
      , port: 31000
    }]);
  }  
  , manager: new ReplSetManager({
      dbpath: path.join(path.resolve('db'))
    , logpath: path.join(path.resolve('db'))
  })
}

// //
// // Mongos server topology
// var mongosServerConfig = {
//     host: 'localhost'
//   , port: 30998
//   , topology: function(self, _mongo) {
//     // return new _mongo.Mongos([{
//     //     host: self.host
//     //   , port: self.port 
//     // }, {
//     //     host: self.host
//     //   , port: self.port + 1
//     // }]);
//     return new _mongo.Mongos([{
//         host: self.host
//       , port: self.port 
//     }]);
//   }
// }

// // Set the config
// var config = mongosServerConfig;
var config = replicasetServerConfig;
// var config = singleServerConfig;

// Run the tests
runner.run(StandaloneConfiguration(config));





