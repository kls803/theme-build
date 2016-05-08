'use strict';

var through = require('through2');
var exec = require('child_process').exec;
var gUtil = require('gulp-util');
var PluginError = require('gulp-util').PluginError;
var File = gUtil.File;
var md5 = require('md5');

var PLUGIN_NAME = "gulp-git-contributors";

module.exports = function (options) {
	options = options || {};

	var contributors = {};

	var saveContribs = function (callback) {
		var target = new File();

		if( Object.keys( contributors ).length > 0 ) {
			for ( var i in contributors ) {
				// We only need contributors score to 2 decimal places
				contributors[i].score = Math.round( contributors[i].score * 100 ) / 100;
			}
		}

		var output = JSON.stringify( contributors, null, '\t' );

		if(options.format === 'php') {
			output = '<?php\nreturn json_decode( \'' + output + '\', true );';
		} else {
			options.format = 'json';
		}

		var content = new Buffer(output);
		target.path = 'contributors.' + options.format;
		target.contents = content;

		this.emit('data', target);
		this.emit('end');

		callback();
	};

	/**
	 * Score function judges value of each line of code.
	 *
	 * @param line The contents of the line
	 * @param fileExtension The file extension of this file
	 * @returns {number}
	 */
	var scoreFunction = function( line, fileExtension ) {
		var score = 0;
		if ( line ) {
			// Judge longer lines as more valuable
			score = line.replace( /\s/g, '' ).length;
			score = Math.log10(score + 100) - 2;
		}
		return score;
	};

	/**
	 * Decay function gives contributions a half-life.
	 *
	 * @param date
	 * @param score
	 * @returns {number}
	 */
	var decayFunction = function( date, score ) {
		// date in milliseconds
		var t = new Date().getTime() - parseInt( date );

		//Half life of about a year
		var halfLife = 1000 * 60 * 60 * 24 * 365;
		return score * Math.pow( 0.5, (t / halfLife) );
	};

	options.scoreFunction = options.scoreFunction || scoreFunction;
	options.decayFunction = options.decayFunction || decayFunction;

	// Ignores uncommitted changes.
	var skipCommits = ['0000000000000000000000000000000000000000'];
	if (options.skipCommits && options.skipCommits.length) {
		skipCommits = skipCommits.concat(options.skipCommits);
	}

	var skipBoundary = typeof options.skipBoundary === 'undefined' ? false : options.skipBoundary;

	var extractContribs = function (file, encoding, callback) {
		if ( file.isNull() ) {
			// nothing to do
			return callback(null, null);
		}

		if ( file.isStream() ) {
			// file.contents is a Stream - https://nodejs.org/api/stream.html
			this.emit('error', new PluginError( PLUGIN_NAME, 'Streams not supported!' ) );
		}

		var fileExtension = file.path.split('.').pop();

		// Using line porcelain format: https://git-scm.com/docs/git-blame#_the_porcelain_format
		// More verbose, but makes parsing easier.
		var contribCmd = 'git blame --line-porcelain ' + file.path;

		// NB! Set maxBuffer to 1000KB to handle larger files.
		exec(contribCmd, {cwd: options.cwd, maxBuffer: 1000 * 1024}, function (error, stdout, stderr) {
			var blameRegex = new RegExp(
				'^([a-fA-F0-9]*)(?:\\s\\d+){2,3}\\n' +  // Commit hash followed by original and final line numbers and number of lines in this commit group, if there is one
				'^author (.*)\\n' +                     // Author name
				'^author-mail <(.*)>\\n' +              // Author email
				'^author-time (\\d+)\\n' +              // Author time (in ms)
				'([\\w\\W]*?)\\n' +                     // Should lazily match anything until...
				'^\\t(.*)',                             // ... a line beginning with a tab followed by the line contents.
				'gm'
			);
			var match;
			while ( match = blameRegex.exec( stdout ) ) {
				var lineContent = match[6].trim();

				// Skip empty lines
				if ( !lineContent ) {
					continue;
				}

				if ( skipBoundary && match[5].match(/^boundary$/gm) ) {
					continue;
				}

				// Check if this is one of the commits we should skip
				if ( skipCommits && skipCommits.length && skipCommits.indexOf( match[1] ) !== -1 ) {
					continue;
				}

				var email = options.hideEmails ? md5( match[3] ) : match[3];
				var contrib = contributors[email] || {name: match[2], email: email, loc: 0, score: 0};
				contrib.loc++;

				// The line score
				var lineScore = typeof options.scoreFunction === 'function' ? options.scoreFunction( lineContent, fileExtension ) : lineContent;

				// git uses Unix timestamp (in seconds), so need to multiply by 1000 for JS time manipulation (in milliseconds).
				if( typeof options.decayFunction === 'function' ) {
					lineScore = options.decayFunction( match[4] * 1000, lineScore );
				}

				// Add this score to the contributor score
				if( lineScore > 0 ) {
					contrib.score += lineScore;
				}
				contributors[email] = contrib;
			}
			callback(null, null);
		});
	};
	return through.obj( extractContribs, saveContribs );
}
