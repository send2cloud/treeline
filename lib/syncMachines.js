var wrench = require('wrench');
var path = require('path');
var _ = require('lodash');
var async = require('async');
var beautify = require('js-beautify').js_beautify;
var fs = require('fs-extra');
var exec = require('child_process').exec;
module.exports = function(sails, socket) {

  sails.npmQueue = async.queue(function(cwd, cb) {
    sails.config && (sails.config.maintenance = true);
    sails.log.silly("NPM UPDATE ", cwd);
    exec("npm update", {cwd: cwd}, function(err, stdout) {
      sails.log.silly(stdout);
      cb(err);
    });
  }, 1);
  sails.npmQueue.drain = function() {
    sails.config.maintenance = false;
  };

	return {

		/**
		 * Get the full list of machinepacks used by this project
		 *
		 * Expected server response:
		 * {
		 * 	"sails-core-auth__1.1": {
		 * 	  "machines": {
		 * 	    "auth__check_login:0.1.2.3": "function(inputs, exits){...}",
		 * 	    "auth__logout:0.1.0.1": "function(inputs, exits){...}"
		 * 	  },
		 * 	  "dependencies": {
		 * 	    "request": "0.2.8",
		 * 	    "bcrypt": "1.2.3"
		 * 	  }
		 * 	},
		 * 	"sails-core-response__2.2": {
		 * 	  ...
		 * 	}
		 * }
		 *
		 *
		 * @param  {[type]}   config  [description]
		 * @param  {[type]}   options [description]
		 * @param  {Function} cb      [description]
		 * @return {[type]}           [description]
		 */
		reloadAllMachinePacks: function(config, options, cb) {

			var self = this;
			cb = cb || function(){};
			options = options || {};
			config = config || sails.config.shipyard;
			options.config = config;

			socket.get(config.src.url + '/machinepacks?secret='+config.src.secret, function(data) {

				self.cleanPacks(options, data, function(err) {
					if (err) {return cb(err);}
					self.writePacks(options, data, cb);
				});

			});

		},

		cleanPacks: function(options, data, cb) {
			if (typeof data == 'function') {
				cb = data;
				data = {};
			} else if (typeof options == 'function') {
				cb = options;
				data = {};
				options = {};
			}
			var curDirs = Object.keys(data);
			var machinesDir = path.join(process.cwd(), (options.export ? '' :  'node_modules/yarr/'), 'node_machines');
			// Make the dir if it doesn't exist
			try {
				fs.mkdirsSync(machinesDir);
			} catch(e) {}
			// Get all of the machine pack subdirs
			var curMachinePacks = fs.readdirSync(machinesDir);
			// Find the ones that aren't present in the curDirs array
			var eraseDirs = _.difference(curMachinePacks, curDirs);
			// Wrench 'em
			eraseDirs.forEach(function(dir) {
				wrench.rmdirSyncRecursive(path.join(machinesDir,dir), true);
			});
			return cb();


		},

		writePacks: function(options, data, cb) {
			var machinesDir = path.join(process.cwd(), (options.export ? '' :  'node_modules/yarr/'), 'node_machines');
			// Loop through all the machinepack direcories
			async.each(Object.keys(data), function(machineDir, cb) {
				// Create the dir if necessary
				try {
					fs.mkdirSync(path.join(machinesDir, machineDir));
				} catch (e) {}
				// Get the package.json file
				var packageJson;
				try {
					packageJson = fs.readFileSync(path.join(machinesDir, machineDir, "package.json"));
					packageJson = JSON.parse(packageJson);
				} catch (e) {
					// If it doesn't exist (probably because we just created the directory),
					// try and create it
					if (e.code == 'ENOENT') {
						packageJson = {machinepack:{machines: [], machineVersions: {}}};
					} else {
						throw e;
					}
				}
				// Now compare the list of machines we got from the server to the list we have
				var machines = data[machineDir].machines;
				var newMasters = _.map(Object.keys(machines), function(master) {
					return master.split(':')[0];
				});
				var currentMasters = Object.keys(packageJson.machinepack.machineVersions);
				var mastersToDelete = _.difference(currentMasters, newMasters);
				// Delete any masters that are no longer part of the pack
				mastersToDelete.forEach(function(master) {
					fs.unlinkSync(path.join(machinesDir, master + '.js'));
				});
				var newPackageJson = {dependencies: data[machineDir].dependencies, machinepack:{machines:[], machineVersions: {}}};
				// Loop through all of the masters the server reported as making up this pack
				_.each(machines, function(machineDef, _master) {
					var master = _master.split(':')[0];
					var version = _master.split(':')[1];
					// If our installed pack doesn't have this master, or has a
					// different version, replace it.
					if (!packageJson.machinepack.machineVersions[master] || packageJson.machinepack.machineVersions[master] !== version) {
            var output = "module.exports={\n"+_.map(machineDef, function(val, key) {
              if (key == 'fn') {return 'fn:' + val;}
              if (key == 'name') {return 'identity: ' + JSON.stringify(val);}
              return key + ': ' + JSON.stringify(val);
            }).join(",\n")+"}";
						output = beautify(output, {indent_size: 2});
						fs.writeFileSync(path.join(machinesDir, machineDir, master + '.js'), output);
					}
					newPackageJson.machinepack.machineVersions[master] = version;
          newPackageJson.machinepack.machines.push(master);
				});
				// Output the package.json for this pack
				var output = beautify(JSON.stringify(newPackageJson), {indent_size: 2});
        if (output == beautify(JSON.stringify(packageJson), {indent_size: 2})) {
          return cb();
        }
				fs.writeFileSync(path.join(machinesDir, machineDir, 'package.json'), output);
        // Write out the index file
        fs.writeFileSync(path.join(machinesDir, machineDir, 'index.js'), "module.exports = require('node-machine').pack({pkg: require('./package.json'), dir: __dirname});");
				sails.npmQueue.push(path.join(machinesDir, machineDir), cb);
			}, cb);

		}

	};

};