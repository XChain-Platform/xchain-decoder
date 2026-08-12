/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
/* XChain Decoder Utility Class */

const crypto = require('crypto');

module.exports = {

    sleep: function(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    throwError: function(error){
        console.error('throwError:', error);
        throw error;
    },

    // SHA256 over the JSON serialization, so the digest depends on key INSERTION
    // ORDER: two objects with the same entries added in a different order hash
    // differently. Callers that compare hashes must build the object identically.
    getDataHash: function(data){
        let obj  = Object.assign({}, data);
        let json = JSON.stringify(obj);
        let hash = crypto.createHash('sha256').update(json).digest('hex');
        return hash;
    },

    startTimer: function(){
        let now = Date.now();
        return now;
    },

    logTimer: function(timer, timeName){
        let now = Date.now();
        let ms  = now - timer;
        var timeString = this.millisecondsToTimeString(ms);
        var niceString = (timeName!=null) ? timeName : 'Time';
        niceString += "\t: " + ms + 'ms';
        if(timeString!='')
            niceString += ' (' + timeString + ')';
        console.log(niceString);
    },

    // Human-readable duration. `milliseconds` below is really TENTHS of a second
    // (it is only ever printed as one digit after the seconds), and `days` wraps
    // at 365, so this is for log lines and not for durations of a year or more.
    millisecondsToTimeString: function(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
            seconds      = Math.floor((ms / 1000) % 60),
            minutes      = Math.floor((ms / (1000 * 60)) % 60),
            hours        = Math.floor((ms / (1000 * 60 * 60)) % 24),
            days         = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);
        hours   = (hours < 10)   ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;
        var str = '';
        if(days    > 0) str += days + 'd ';
        if(hours   > 0) str += hours + 'h ';
        if(minutes > 0) str += minutes + 'm ';
        if(seconds > 0) str += seconds + '.' + milliseconds + 's';
        return str;
    } ,
    
	uint8ArrayToHex: function(uint8array){
		let hex = '';
		for (let i = 0; i < uint8array.length; i++) {
			const byte = uint8array[i];
			hex += byte.toString(16).padStart(2, '0');
		}
		return hex;
	}   

}