var f = require('util').format
  , path = require('path')
  , fs = require('fs')
  , mkdirp = require('mkdirp')
  , rimraf = require('rimraf')
  , ServerManager = require('./server_manager')
  , Server = require('../../lib').Server
  , ReplSet = require('../../lib').ReplSet;

//
// Clone the options
var cloneOptions = function(options) {
  var opts = {};
  for(var name in options) {
    opts[name] = options[name];
  }
  return opts;
}

//
// Remove any non-server specific settings
var filterInternalOptionsOut = function(options, internalOptions) {
  var opts = {};

  for(var name in options) {
    if(internalOptions.indexOf(name) == -1) {
      opts[name] = options[name];
    }
  }

  return opts;
}

var ReplSetManager = function(replsetOptions) {
  replsetOptions = replsetOptions || {};
  var startPort = replsetOptions.port = replsetOptions.startPort || 31000;

  // Get the settings
  var secondaries = replsetOptions.secondaries || 2;
  var arbiters = replsetOptions.arbiters || 0;
  var replSet = replsetOptions.replSet = replsetOptions.replSet || 'rs';
  var version = 1;
  var configSet = null;

  // Clone the options
  replsetOptions = cloneOptions(replsetOptions);
  
  // Contains all the server managers
  var serverManagers = [];

  // filtered out internal keys
  var internalOptions = filterInternalOptionsOut(replsetOptions
    , ["bin", "host", "secondaries", "arbiters", "startPort"]);

  //
  // ensure replicaset is up and running
  var ensureUp = function(server, callback) {
    process.stdout.write(".");
    // Get the replicaset status
    server.command('admin.$cmd', {"replSetGetStatus": 1}, function(err, result) {
      if(err || result.result.ok == 0) return setTimeout(function() {
        ensureUp(server, callback);
      }, 1000);

      // The result
      var result = result.result;
      var ready = true;
      // Figure out if all the servers are ready
      result.members.forEach(function(m) {
        if([1, 2, 7].indexOf(m.state) == -1) ready = false;
      });

      if(ready) {
        console.log("replicaset is up");
        server.destroy();
        return callback(null, null);
      }

      // Query the state of the replicaset again
      setTimeout(function() {
        ensureUp(server, callback);
      }, 1000);        
    });
  }

  //
  // Configure and ensure
  var configureAndEnsure = function(options, callback) {
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }

    var _id = 0;
    configSet = {
        _id: replSet
      , version: version
      , members: [{
          _id: _id
        , host: serverManagers[_id].name
      }]
    }

    // Update _id
    _id = _id + 1;

    // For all servers add the members
    for(var i = 0; i < secondaries; i++, _id++) {
      configSet.members[_id] = {
          _id: _id
        , host: serverManagers[_id].name
      }      
    }
    
    // Let's pick one of the servers and run the command against it
    var server = new Server({
        host: serverManagers[0].host
      , port: serverManagers[0].port
      , connectionTimeout: 2000
    });

    var onError = function(err) {
      callback(err, null);
    }

    // Set up the connection
    server.on('connect', function(server) {
      // Execute configure replicaset
      server.command('admin.$cmd'
        , {replSetInitiate: configSet}
        , {readPreference: 'secondary'}, function(err, result) {
          if(err) return callback(err, null);
          console.log("Waiting for replicaset ");
          ensureUp(server, callback);
      });
    });

    server.once('error', onError);
    server.once('close', onError);
    server.once('timeout', onError);
    // Connect
    server.connect();
  }

  //
  // Start the server
  this.start = function(options, callback) {
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }

    // Create server instances
    var totalServers = secondaries + arbiters + 1;
    var serversLeft = totalServers;
    var purge = typeof options.purge == 'boolean' ? options.purge : true;

    // Start all the servers
    for(var i = 0; i < totalServers; i++) {
      // Clone the options
      var opts = cloneOptions(internalOptions);
      // Set the current Port 
      opts.port = startPort + i;
      opts.dbpath = opts.dbpath ? opts.dbpath + f("/data-%s", opts.port) : null;
      opts.logpath = opts.logpath ? opts.logpath + f("/data-%s.log", opts.port) : null;
      // Create a server manager
      serverManagers.push(new ServerManager(opts));
    }

    // Start all the servers
    for(var i = 0; i < serverManagers.length; i++) {
      var startOpts = {purge: purge};

      // Start the server
      serverManagers[i].start(startOpts, function(err) {
        if(err) throw err;
        serversLeft = serversLeft - 1;

        // All servers are down
        if(serversLeft == 0) {

          // Configure the replicaset
          configureAndEnsure(function() {
            callback(null, null);
          });
        }
      });
    }
  }

  this.stop = function(options, callback) {    
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }

    var count = serverManagers.length;
    // Stop all servers
    serverManagers.forEach(function(s) {
      s.stop(function() {
        count = count - 1;
        if(count == 0) {
          callback();
        }
      });
    });
  }

  this.restart = function(options, callback) {
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }

    // Servers needing to be restarted
    var servers = serverManagers.filter(function(x) {
      return !x.isConnected();
    });

    if(servers.length == 0) return callback(null, null);
    var count = servers.length;
    // Restart the servers
    for(var i = 0; i < servers.length; i++) {
      servers[i].start(options, function(err, r) {
        count = count - 1;

        if(count == 0) {
          callback(null, null);
        }
      });
    }
  } 

  //
  // Get the current ismaster
  var getIsMaster = function(callback) {
    var manager = null;
    
    // Locate a connected server
    for(var i = 0; i < serverManagers.length; i++) {
      if(serverManagers[i].isConnected()) manager = serverManagers[i];
    }

    if(manager == null) return callback(new Error("no servers"));
    serverManagers[0].ismaster(callback);
  } 

  //
  // Get a current serve
  var getServer = function(address, callback) {
    if(serverManagers.length == 0) return callback(new Error("no servers"));

    var manager = null;
    for(var i = 0; i < serverManagers.length; i++) {
      if(serverManagers[i].lastIsMaster().me == address) {
        manager = serverManagers[i];
      }
    }

    // We have an active server connection return it
    if(manager != null && manager.isConnected()) 
      return callback(null, manager.server()) ;
    if(manager == null) 
      return callback(new Error("no servers"));    
  }

  //
  // Get server by type
  var getServerByType = function(type, callback) {
    if(serverManagers.length == 0) return callback(new Error("no servers"));    
    // Filter out all connected servers
    var servers = serverManagers.filter(function(s) {
      return s.isConnected();
    });

    // var servers = serverManagers;
    if(servers.length == 0) return callback(new Error("no servers"));
    // Refresh all ismasters
    var count = servers.length;
    for(var i = 0; i < servers.length; i++) {
      servers[i].ismaster(function(err, ismaster) {
        count = count - 1;

        if(count == 0) {
          var manager = null;
          for(var i = 0; i < servers.length; i++) {
            if(servers[i].lastIsMaster().secondary && servers[i].isConnected()) {
              manager = servers[i];
              break;
            }
          }  

          // We have an active server connection return it
          if(manager != null) 
            return callback(null, manager);
          if(manager == null) 
            return callback(new Error("no servers"));                   
        }
      });
    }
  }

  this.shutdown = function(type, options, callback) {
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }

    options.signal = options.signal || -15;
    // Get server by type
    getServerByType(type, function(err, manager) {
      if(err) return callback(err);
      // Shut down the server
      manager.stop(options, callback);
    });
  }

  this.restartServer = function(type, options, callback) {
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }

    // Locate a downed secondary server
    var manager = null;
    for(var i = 0; i < serverManagers.length; i++) {
      if(!serverManagers[i].isConnected() && serverManagers[i].lastIsMaster().secondary) {
        manager = serverManagers[i];
        break;
      }
    }

    if(manager == null) return callback(new Error("no downed secondary server found"));
    // Restart the server
    manager.start(options, callback);
  }

  this.stepDown = function(options, callback) {
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }

    options.avoidElectionFor = options.avoidElectionFor || 90;
    options.force = typeof options.force == 'boolean' ? options.force : false;

    // Get is master from one of the servers
    getIsMaster(function(err, ismaster) {
      if(err) return callback(err);
      
      // Get a live connection to the primary
      getServer(ismaster.primary, function(err, server) {
        if(err) return callback(err);

        // Execute step down
        server.command('admin.$cmd', {
            replSetStepDown: options.avoidElectionFor
          , force: options.force}, function(err, result) {
            if(err) return callback(err);
            callback(result);
        });
      })
    });
  }   
}

module.exports = ReplSetManager;